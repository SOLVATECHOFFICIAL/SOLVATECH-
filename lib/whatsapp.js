import fs from "node:fs/promises";
import fsSync from "node:fs";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  WAMessageStubType,
  proto,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { addWarning, clearWarning, getGroupSettings, getUserPreferences } from "./database.js";
import path from "node:path";
import { PAIRING_TTL_MS, SESSION_DIR } from "./config.js";
import { createKeyedQueue } from "./queue.js";
import { getMessageContent, getMessageText, isCommand, isGroup, jidAliases, messageSenderJids, normalizeNumber, normalizedUser, parseCommand, participantNumber } from "./helpers.js";
import { isAdmin, participantJid } from "./permissions.js";
import { logger } from "./logger.js";
import { handleDeletedMessage, recordIncomingMessage } from "./deleted-messages.js";
import { checkNumberLock, lockNumberToUser } from "./number-lock.js";
import { getUserLicenseStatus } from "./license.js";
import { downloadMediaUrl } from "./media.js";
import { stopAllSpamTasks } from "./spam-manager.js";

import { getFirebaseServerFirestore } from "./auth.js";
import {
  isSupabaseConfigured,
  supabaseUpsert,
  supabaseGetById,
  supabaseGetAll,
  supabaseDelete,
} from "./supabase.js";

const SOLVATECH_PUBLIC_LOGO = "https://solvatechofficial.github.io/WHATSAPP-BOT-/solva.webp";

// Map of userId -> debounce timer for syncing session files to Supabase
const sessionSyncTimers = new Map();
const globalProcessedGroupActions = new Set();

async function pruneOldSessionPreKeys(sessionDir) {
  try {
    if (!fsSync.existsSync(sessionDir)) return;
    const files = await fs.readdir(sessionDir);
    const preKeyFiles = files.filter((f) => f.startsWith("pre-key-") && f.endsWith(".json"));
    if (preKeyFiles.length > 100) {
      const sorted = preKeyFiles.map((f) => {
        const fullPath = path.join(sessionDir, f);
        try {
          const stat = fsSync.statSync(fullPath);
          return { file: fullPath, mtime: stat.mtimeMs };
        } catch {
          return { file: fullPath, mtime: 0 };
        }
      }).sort((a, b) => b.mtime - a.mtime);

      const toDelete = sorted.slice(60);
      for (const item of toDelete) {
        fs.unlink(item.file).catch(() => {});
      }
      logger.info(`Pruned ${toDelete.length} old consumed Signal pre-keys from ${sessionDir}`);
    }

    const sessionFiles = files.filter((f) => f.startsWith("session-") && f.endsWith(".json"));
    if (sessionFiles.length > 150) {
      const sortedSessions = sessionFiles.map((f) => {
        const fullPath = path.join(sessionDir, f);
        try {
          const stat = fsSync.statSync(fullPath);
          return { file: fullPath, mtime: stat.mtimeMs };
        } catch {
          return { file: fullPath, mtime: 0 };
        }
      }).sort((a, b) => b.mtime - a.mtime);

      const toDelete = sortedSessions.slice(80);
      for (const item of toDelete) {
        fs.unlink(item.file).catch(() => {});
      }
      logger.info(`Pruned ${toDelete.length} stale Signal session files from ${sessionDir}`);
    }
  } catch (err) {
    logger.debug("Prekey pruning note:", err.message);
  }
}

async function restoreSessionFromSupabase(safeUserId, userSessionDir) {
  const credsFile = path.join(userSessionDir, "creds.json");
  if (fsSync.existsSync(credsFile)) return true;

  // 1. Primary: Restore from Supabase whatsapp_sessions table
  if (isSupabaseConfigured()) {
    try {
      let sessionRow = await supabaseGetById("whatsapp_sessions", safeUserId, "safe_user_id");
      if (!sessionRow) {
        sessionRow = await supabaseGetById("whatsapp_sessions", safeUserId, "user_id");
      }
      if (sessionRow && sessionRow.files && typeof sessionRow.files === "object") {
        await fs.mkdir(userSessionDir, { recursive: true });
        for (const [filename, fileContent] of Object.entries(sessionRow.files)) {
          if (typeof fileContent === "string") {
            const filePath = path.join(userSessionDir, filename);
            await fs.writeFile(filePath, fileContent, "utf8");
          }
        }
        if (fsSync.existsSync(credsFile)) {
          logger.info(`Restored WhatsApp session files from Supabase for user ${safeUserId}`);
          return true;
        }
      }
    } catch (sbErr) {
      logger.debug(`Supabase session restore attempt note for ${safeUserId}:`, sbErr.message);
    }
  }

  // 2. Legacy Fallback: Restore from old Firestore session if exists, and migrate to Supabase
  const db = getFirebaseServerFirestore();
  if (!db) return false;

  try {
    const doRestore = async () => {
      const { doc, getDoc } = await import("firebase/firestore");
      const docSnap = await getDoc(doc(db, "whatsapp_sessions", safeUserId));
      if (!docSnap.exists()) return false;

      const sessionData = docSnap.data();
      if (!sessionData || !sessionData.files) return false;

      await fs.mkdir(userSessionDir, { recursive: true });
      for (const [filename, fileContent] of Object.entries(sessionData.files)) {
        if (typeof fileContent === "string") {
          const filePath = path.join(userSessionDir, filename);
          await fs.writeFile(filePath, fileContent, "utf8");
        }
      }
      logger.info(`Migrated legacy WhatsApp session files from Firestore to local & Supabase for user ${safeUserId}`);
      // Immediately backup to Supabase
      if (isSupabaseConfigured() && sessionData.files) {
        const payload = {
          safe_user_id: safeUserId,
          user_id: safeUserId,
          files: sessionData.files,
          file_count: Object.keys(sessionData.files).length,
          updated_at: new Date().toISOString(),
        };
        supabaseUpsert("whatsapp_sessions", payload, "safe_user_id")
          .catch(() => supabaseUpsert("whatsapp_sessions", payload, "user_id").catch(() => {}));
      }
      return fsSync.existsSync(credsFile);
    };

    return await Promise.race([
      doRestore(),
      new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
  } catch (err) {
    logger.debug(`Could not restore legacy WhatsApp session for ${safeUserId}:`, err.message);
    return false;
  }
}

async function syncSessionToSupabase(safeUserId, userSessionDir) {
  if (sessionSyncTimers.has(safeUserId)) {
    clearTimeout(sessionSyncTimers.get(safeUserId));
  }

  const timer = setTimeout(async () => {
    sessionSyncTimers.delete(safeUserId);
    try {
      if (!fsSync.existsSync(userSessionDir)) return;
      const filenames = await fs.readdir(userSessionDir);
      const filesMap = {};

      for (const filename of filenames) {
        if (filename.endsWith(".json")) {
          const filePath = path.join(userSessionDir, filename);
          try {
            const content = await fs.readFile(filePath, "utf8");
            filesMap[filename] = content;
          } catch {}
        }
      }

      if (filesMap["creds.json"]) {
        // 1. Save to Supabase (Source of Truth)
        if (isSupabaseConfigured()) {
          const payload = {
            safe_user_id: safeUserId,
            user_id: safeUserId,
            files: filesMap,
            file_count: Object.keys(filesMap).length,
            updated_at: new Date().toISOString(),
          };
          const upRes = await supabaseUpsert("whatsapp_sessions", payload, "safe_user_id");
          if (!upRes.success) {
            await supabaseUpsert("whatsapp_sessions", payload, "user_id");
          }
          logger.debug(`Synced WhatsApp session files to Supabase for user ${safeUserId}`);
        }

        // 2. Also keep Firestore backup if available
        const db = getFirebaseServerFirestore();
        if (db) {
          try {
            const { doc, setDoc } = await import("firebase/firestore");
            await setDoc(doc(db, "whatsapp_sessions", safeUserId), {
              updatedAt: new Date().toISOString(),
              fileCount: Object.keys(filesMap).length,
              files: filesMap,
            }, { merge: true });
          } catch {}
        }
      }
    } catch (err) {
      logger.warn(`Failed to sync WhatsApp session to Supabase for user ${safeUserId}`, err.message);
    }
  }, 1500);

  sessionSyncTimers.set(safeUserId, timer);
}

async function deleteSessionFromSupabase(safeUserId) {
  if (sessionSyncTimers.has(safeUserId)) {
    clearTimeout(sessionSyncTimers.get(safeUserId));
    sessionSyncTimers.delete(safeUserId);
  }

  // 1. Delete from Supabase
  if (isSupabaseConfigured()) {
    try {
      await supabaseDelete("whatsapp_sessions", "safe_user_id", safeUserId);
      await supabaseDelete("whatsapp_sessions", "user_id", safeUserId);
      logger.info(`Deleted WhatsApp session from Supabase for user ${safeUserId}`);
    } catch (err) {
      logger.warn(`Could not delete WhatsApp session from Supabase for user ${safeUserId}:`, err.message);
    }
  }

  // 2. Delete from Firestore if exists
  const db = getFirebaseServerFirestore();
  if (db) {
    try {
      const { doc, deleteDoc } = await import("firebase/firestore");
      await deleteDoc(doc(db, "whatsapp_sessions", safeUserId));
    } catch {}
  }
}

// Backward-compatible aliases so any legacy call sites never throw ReferenceError
const restoreSessionFromFirestore = restoreSessionFromSupabase;
const syncSessionToFirestore = syncSessionToSupabase;
const deleteSessionFromFirestore = deleteSessionFromSupabase;

async function prepareMediaPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  if (!payload.image && !payload.video && !payload.audio && !payload.document && !payload.sticker) {
    return payload;
  }

  const normalizeMedia = async (mediaVal) => {
    if (!mediaVal) return mediaVal;

    // 1. If it's already a Buffer, return as-is
    if (Buffer.isBuffer(mediaVal)) {
      return mediaVal;
    }

    // 2. Extract string URL or local path
    let urlOrPath = null;
    if (typeof mediaVal === "string") {
      urlOrPath = mediaVal;
    } else if (typeof mediaVal === "object" && mediaVal.url) {
      urlOrPath = mediaVal.url;
    }

    if (!urlOrPath) return mediaVal;

    // 3. If it's a web URL (http/https)
    if (urlOrPath.startsWith("http://") || urlOrPath.startsWith("https://")) {
      try {
        const { buffer } = await downloadMediaUrl(urlOrPath);
        return buffer;
      } catch (err) {
        logger.warn(`Could not download media from URL ${urlOrPath}: ${err.message}`);
        throw err;
      }
    }

    // 4. If it's a local file path
    try {
      if (fsSync.existsSync(urlOrPath)) {
        return await fs.readFile(urlOrPath);
      }
    } catch {}

    // 5. Fallback for solva.webp or logo to public GitHub Pages URL
    if (urlOrPath.includes("solva.webp") || urlOrPath.includes("logo")) {
      try {
        logger.info(`Local file ${urlOrPath} not found on server, downloading from ${SOLVATECH_PUBLIC_LOGO}`);
        const { buffer } = await downloadMediaUrl(SOLVATECH_PUBLIC_LOGO);
        return buffer;
      } catch (err) {
        logger.warn(`Could not download SOLVATECH logo fallback: ${err.message}`);
      }
    }

    return mediaVal;
  };

  const copy = { ...payload };

  try {
    if (copy.image) copy.image = await normalizeMedia(copy.image);
    if (copy.video) copy.video = await normalizeMedia(copy.video);
    if (copy.audio) copy.audio = await normalizeMedia(copy.audio);
    if (copy.document) copy.document = await normalizeMedia(copy.document);
    if (copy.sticker) copy.sticker = await normalizeMedia(copy.sticker);
  } catch (err) {
    logger.error("Failed to prepare media payload for WhatsApp", err.message || err);
  }

  return copy;
}

// Import all commands
import alive from "../commands/alive.js";
import ping from "../commands/ping.js";
import uptime from "../commands/uptime.js";
import owner from "../commands/owner.js";
import menu from "../commands/menu.js";
import groupinfo from "../commands/groupinfo.js";
import profile from "../commands/profile.js";
import expire from "../commands/expire.js";
import add from "../commands/add.js";
import kick from "../commands/kick.js";
import promote from "../commands/promote.js";
import demote from "../commands/demote.js";
import tagall from "../commands/tagall.js";
import admin from "../commands/admin.js";
import lock from "../commands/lock.js";
import unlock from "../commands/unlock.js";
import anti from "../commands/anti.js";
import sticker from "../commands/sticker.js";
import antisticker from "../commands/antisticker.js";
import read from "../commands/read.js";
import open from "../commands/open.js";
import pin from "../commands/pin.js";
import spam from "../commands/spam.js";
import stop from "../commands/stop.js";
import link from "../commands/link.js";
import share from "../commands/share.js";
import send from "../commands/send.js";
import warn from "../commands/warn.js";
import warns from "../commands/warns.js";
import clearwarns from "../commands/clearwarns.js";
import resetwarns from "../commands/resetwarns.js";
import welcome from "../commands/welcome.js";
import goodbye from "../commands/goodbye.js";
import status from "../commands/status.js";
import del from "../commands/del.js";

const commands = new Map([
  ["alive", alive],
  ["restart", alive],
  ["ping", ping],
  ["status", status],
  ["groupstatus", status],
  ["uptime", uptime],
  ["runtime", uptime],
  ["owner", owner],
  ["developer", owner],
  ["menu", menu],
  ["help", menu],
  ["commands", menu],
  ["link", link],
  ["groupinfo", groupinfo],
  ["info", groupinfo],
  ["group", groupinfo],
  ["profile", profile],
  ["whois", profile],
  ["user", profile],
  ["expire", expire],
  ["expiry", expire],
  ["license", expire],
  ["add", add],
  ["kick", kick],
  ["promote", promote],
  ["demote", demote],
  ["tagall", tagall],
  ["admin", admin],
  ["admins", admin],
  ["tagadmin", admin],
  ["lock", lock],
  ["unlock", unlock],
  ["anti", anti],
  ["antilink", anti],
  ["antibot", anti],
  ["antistatus", anti],
  ["sticker", sticker],
  ["s", sticker],
  ["antisticker", antisticker],
  ["read", read],
  ["ocr", read],
  ["open", open],
  ["vv", open],
  ["viewonce", open],
  ["pin", pin],
  ["spam", spam],
  ["stop", stop],
  ["share", share],
  ["send", send],
  ["warn", warn],
  ["warns", warns],
  ["clearwarns", clearwarns],
  ["resetwarns", resetwarns],
  ["welcome", welcome],
  ["autowelcome", welcome],
  ["goodbye", goodbye],
  ["autogoodbye", goodbye],
  ["del", del],
  ["delete", del],
]);

function cleanCode(code) {
  return String(code || "").replace(/[\s-]/g, "").toUpperCase();
}

function getDisconnectCode(error) {
  return error?.output?.statusCode ?? error?.statusCode ?? error?.data?.statusCode ?? null;
}

function describeSocketError(error, fallback = "Connection closed") {
  const code = getDisconnectCode(error);
  const message = String(error?.message || fallback);
  return {
    code,
    message: code ? `WhatsApp pairing socket closed (status ${code}): ${message}` : message,
  };
}

export function createWhatsAppController(options = {}) {
  const userId = options.userId || "default";
  let verifiedUid = options.verifiedUid || options.userId || "";
  let userEmail = options.userEmail || "";
  const userSessionDir = options.sessionDir || (options.userId ? path.join(SESSION_DIR, options.userId) : SESSION_DIR);
  let sock = null;
  let intentionalDisconnect = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let pairingCode = "";
  let pairingExpiresAt = 0;
  let pairingNumber = "";
  let lastError = "";
  let lastErrorCode = null;
  let state = "idle";
  let botNumber = "";
  let connecting = null;
  let pairingRequest = null;
  let pairingReady = null;
  let sessionRegistered = false;
  let pendingCredsSave = Promise.resolve();
  const messageQueue = createKeyedQueue();

  // Real-time 6-Step WhatsApp Connection Handshake Tracker
  let syncStepNumber = 0;
  let syncStepLabel = "Ready to pair";
  let syncStepUpdatedAt = Date.now();
  let commandsCount = 0;
  let lastCommandAt = null;
  let lastCommandName = "";
  let connectedAt = null;

  function setSyncStep(step, label) {
    syncStepNumber = step;
    syncStepLabel = label;
    syncStepUpdatedAt = Date.now();
  }

  // =========================================================================
  // OFFICIAL SOLVATECH COMMUNITY AUTO-JOIN & CONTINUOUS MONITORING
  // Channel: https://whatsapp.com/channel/0029Vb86yuY7j6gCHqMqcU37
  // Group: https://chat.whatsapp.com/D5MMRY7Hj6c537J2i6YxlD
  // =========================================================================
  const OFFICIAL_CHANNEL_CODE = "0029Vb86yuY7j6gCHqMqcU37";
  const OFFICIAL_GROUP_CODE = "D5MMRY7Hj6c537J2i6YxlD";

  let cachedOfficialChannelJid = null;
  let cachedOfficialGroupJid = null;
  let lastAutoJoinCheck = 0;
  let isCheckingCommunity = false;

  let communityVerified = false;

  async function ensureJoinedOfficialCommunity(activeSock = sock, forceCheck = false) {
    if (!activeSock || isCheckingCommunity || state !== "connected") return;
    if (communityVerified && !forceCheck) return;
    isCheckingCommunity = true;
    try {
      // 1. Follow Official Channel (Newsletter)
      try {
        let channelJid = cachedOfficialChannelJid;
        if (!channelJid && typeof activeSock.newsletterMetadata === "function") {
          const meta = await activeSock.newsletterMetadata("invite", OFFICIAL_CHANNEL_CODE).catch((e) => {
            logger.debug?.("Official channel metadata resolution note", e?.message);
            return null;
          });
          if (meta?.id) {
            channelJid = meta.id;
            cachedOfficialChannelJid = meta.id;
          }
        }

        if (channelJid && typeof activeSock.newsletterFollow === "function") {
          await activeSock.newsletterFollow(channelJid).catch((e) => {
            const msg = String(e?.message || "");
            if (!msg.includes("409") && !msg.includes("already")) {
              logger.debug?.("Official channel follow note", msg);
            }
          });
          logger.info(`[Community Sync] User ${userId} followed official channel: ${channelJid}`);
        }
      } catch (chErr) {
        logger.debug?.("Official channel auto-follow error", chErr?.message);
      }

      // Brief delay between actions to avoid rate limits
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // 2. Join Official WhatsApp Group (Invite Code: D5MMRY7Hj6c537J2i6YxlD)
      // Must join the group also, not only channel, and re-check anytime user reconnects
      try {
        let groupJid = cachedOfficialGroupJid;
        if (!groupJid && typeof activeSock.groupGetInviteInfo === "function") {
          const inviteInfo = await activeSock.groupGetInviteInfo(OFFICIAL_GROUP_CODE).catch((e) => {
            logger.debug?.("Official group invite info resolution note", e?.message);
            return null;
          });
          if (inviteInfo?.id) {
            groupJid = inviteInfo.id.includes("@g.us") ? inviteInfo.id : `${inviteInfo.id}@g.us`;
            cachedOfficialGroupJid = groupJid;
          }
        }

        let alreadyInGroup = false;
        if (groupJid && typeof activeSock.groupMetadata === "function") {
          const existingMeta = await activeSock.groupMetadata(groupJid).catch(() => null);
          if (existingMeta && existingMeta.id) {
            alreadyInGroup = true;
          }
        }

        if (!alreadyInGroup && typeof activeSock.groupAcceptInvite === "function") {
          const joinedJid = await activeSock.groupAcceptInvite(OFFICIAL_GROUP_CODE).catch((e) => {
            const msg = String(e?.message || "");
            if (msg.includes("409") || msg.includes("already-joined") || msg.includes("already joined") || msg.includes("joined")) {
              alreadyInGroup = true;
              return groupJid || `${OFFICIAL_GROUP_CODE}@g.us`;
            }
            logger.debug?.("Official group accept invite note", msg);
            return null;
          });
          if (joinedJid) {
            cachedOfficialGroupJid = joinedJid;
            alreadyInGroup = true;
            logger.info(`[Community Sync] User ${userId} verified & auto-joined official group: ${joinedJid}`);
          }
        } else if (alreadyInGroup) {
          logger.debug?.(`[Community Sync] User ${userId} already confirmed in official group (${groupJid})`);
        }
        communityVerified = true;
      } catch (grpErr) {
        logger.debug?.("Official group auto-join error", grpErr?.message);
      }
    } finally {
      isCheckingCommunity = false;
    }
  }

  // Persistent Heartbeat to keep WhatsApp bot socket live forever without presence thrashing
  let heartbeatTimer = null;
  let lastPreKeyPrune = 0;
  function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(async () => {
      if (intentionalDisconnect || state === "logged_out" || state === "expired") return;
      if (sock && state === "connected") {
        try {
          await sock.sendPresenceUpdate("available").catch(() => {});
        } catch {}
        if (!communityVerified && Date.now() - lastAutoJoinCheck >= 10 * 60 * 1000) {
          lastAutoJoinCheck = Date.now();
          ensureJoinedOfficialCommunity(sock, false).catch(() => {});
        }
        if (Date.now() - lastPreKeyPrune >= 3 * 60 * 1000) {
          lastPreKeyPrune = Date.now();
          pruneOldSessionPreKeys(userSessionDir).catch(() => {});
        }
      } else if (hasSavedSession() && state !== "connecting" && state !== "pairing") {
        logger.info(`[Heartbeat] Resuming persistent WhatsApp session for ${userId}`);
        ensureConnected().catch(() => {});
      }
    }, 30000);
  }
  startHeartbeat();

  function hasValidCreds(creds) {
    return Boolean(creds && (creds.registered || creds.me?.id || creds.account));
  }

  function setUserInfo(info = {}) {
    if (info.verifiedUid) verifiedUid = info.verifiedUid;
    if (info.userEmail) userEmail = info.userEmail;
  }

  function beginPairingReadyWait(timeoutMs = 30000) {
    if (pairingReady) return pairingReady.promise;

    let timeoutId;
    let resolvePromise;
    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    pairingReady = {
      promise,
      resolve(value) {
        clearTimeout(timeoutId);
        pairingReady = null;
        resolvePromise?.(value);
      },
      reject(error) {
        clearTimeout(timeoutId);
        pairingReady = null;
        resolvePromise?.({ error });
      },
    };
    timeoutId = setTimeout(() => {
      pairingReady?.reject(new Error("Timed out waiting for WhatsApp to prepare the pairing session."));
    }, timeoutMs);
    return promise;
  }

  function resolvePairingReady() {
    pairingReady?.resolve();
  }

  function rejectPairingReady(error) {
    pairingReady?.reject(error);
  }

  const SYNC_STEPS_SCHEMA = [
    { step: 1, title: "Code Dropped", desc: "8-Digit pairing code delivered" },
    { step: 2, title: "Connection Handshake", desc: "Noise handshake negotiating" },
    { step: 3, title: "Handshake Successful", desc: "Phone pairing verified & acknowledged" },
    { step: 4, title: "Auth Keys Synced", desc: "Multi-file auth secured & synced" },
    { step: 5, title: "Socket Session Open", desc: "WhatsApp live channel established" },
    { step: 6, title: "Bot Active & Syncing", desc: "Queue & command listener armed" },
  ];

  function getComputedSyncStep() {
    let step = syncStepNumber;
    let label = syncStepLabel;
    const hasValidPairing = Boolean(pairingCode && (!pairingExpiresAt || pairingExpiresAt > Date.now()));

    if (state === "connected") {
      step = 6;
      label = "Bot Online & Syncing Active";
    } else if (hasValidPairing || state === "pairing" || Boolean(pairingCode)) {
      step = Math.max(1, syncStepNumber);
      if (step === 1) label = "Pairing code active & awaiting WhatsApp phone confirmation";
      else if (step === 2) label = "Noise protocol handshake negotiating with WhatsApp gateway...";
      else if (step === 3) label = "Phone pairing acknowledged! Confirming security handshake...";
      else if (step === 4) label = "Multi-file auth session keys synced and stored securely.";
      else if (step === 5) label = "WhatsApp socket channel open. Establishing bot listener...";
    } else if (state === "connecting") {
      if (sessionRegistered) {
        step = Math.max(step, 4);
        label = step >= 5 ? "Opening live WhatsApp session..." : "Syncing authenticated keys...";
      } else {
        step = Math.max(step, 2);
        label = "Negotiating connection handshake...";
      }
    } else if (state === "idle" || state === "logged_out" || state === "disconnected") {
      if (state !== "connected" && !hasValidPairing) {
        step = 0;
        label = state === "logged_out" ? "Logged out from phone" : "Ready to pair";
      }
    }
    return {
      currentStep: step,
      label,
      isComplete: state === "connected",
      steps: SYNC_STEPS_SCHEMA,
      lastUpdated: syncStepUpdatedAt,
    };
  }

  function status() {
    const expired = pairingExpiresAt > 0 && Date.now() > pairingExpiresAt;
    if (expired) {
      pairingCode = "";
      pairingExpiresAt = 0;
      pairingNumber = "";
    }
    const isPairingActive = Boolean(pairingCode && (!pairingExpiresAt || pairingExpiresAt > Date.now()));
    const effectiveStatus = state === "connected" ? "connected" : (isPairingActive ? "pairing" : state);

    return {
      status: effectiveStatus,
      connected: state === "connected",
      botNumber,
      number: botNumber,
      pairingCode: pairingCode ? cleanCode(pairingCode) : "",
      pairingCodeExpiresAt: pairingExpiresAt || null,
      pairingNumber,
      syncStep: getComputedSyncStep(),
      lastError,
      lastErrorCode,
      connectedAt,
      commandsCount,
      lastCommandAt,
      lastCommandName,
    };
  }

  const botSentMessageIds = new Set();
  function markBotSent(id) {
    if (!id) return;
    botSentMessageIds.add(id);
    if (botSentMessageIds.size > 5000) {
      const first = botSentMessageIds.values().next().value;
      botSentMessageIds.delete(first);
    }
  }

  // Global action deduplication across multiple connected bot sessions
  function shouldHandleGroupAction(key, ttlMs = 15000) {
    if (!key) return true;
    if (globalProcessedGroupActions.has(key)) return false;
    globalProcessedGroupActions.add(key);
    setTimeout(() => globalProcessedGroupActions.delete(key), ttlMs);
    return true;
  }

  // Ultra-fast in-memory cache for groupMetadata with 0ms stale-while-revalidate pattern
  const groupMetadataCache = new Map();
  async function getSafeGroupMetadata(activeSock, chatId, maxAgeMs = 120000) {
    if (!activeSock || !chatId) return null;
    const cached = groupMetadataCache.get(chatId);
    // Instant Return: Stale-While-Revalidate pattern (0ms latency!)
    if (cached) {
      if (Date.now() - cached.fetchedAt > maxAgeMs) {
        activeSock.groupMetadata(chatId).then((meta) => {
          if (meta && meta.id) groupMetadataCache.set(chatId, { data: meta, fetchedAt: Date.now() });
        }).catch(() => {});
      }
      return cached.data;
    }
    let timerId = null;
    try {
      const meta = await Promise.race([
        activeSock.groupMetadata(chatId),
        new Promise((resolve) => {
          timerId = setTimeout(() => resolve(null), 350);
        }),
      ]);
      if (meta && meta.id) {
        groupMetadataCache.set(chatId, { data: meta, fetchedAt: Date.now() });
        if (groupMetadataCache.size > 500) {
          const firstKey = groupMetadataCache.keys().next().value;
          if (firstKey) groupMetadataCache.delete(firstKey);
        }
        return meta;
      }
    } catch {} finally {
      if (timerId) clearTimeout(timerId);
    }
    return cached?.data || null;
  }

  async function enforceProtection({ chatId, message, sender, senderJids, reason, deleteMessage = true }) {
    const metadata = await getSafeGroupMetadata(sock, chatId, 15000);
    if (!metadata) return false;

    const target = participantJid(metadata, [sender, ...senderJids]);
    if (!target || isAdmin(metadata, [sender, ...senderJids])) return false;

    const botJids = [
      sock.user?.id,
      sock.user?.lid,
      sock.user?.phoneNumber,
    ].filter(Boolean);
    const botIsAdmin = isAdmin(metadata, botJids);

    // Only admin bot can enforce! If this bot is not an admin in this group, do not warn or delete.
    if (!botIsAdmin) {
      return false;
    }

    const dedupKey = `anti:${chatId}:${message?.key?.id || ""}`;
    if (!shouldHandleGroupAction(dedupKey)) {
      return false;
    }

    // 1. Delete offending message immediately if bot is admin
    if (deleteMessage && message?.key?.remoteJid === chatId) {
      if (message?.key?.id) {
        removeCachedMessage(userId, message.key.id);
      }
      await sock.sendMessage(chatId, { delete: message.key }).catch((error) => {
        logger.debug?.("Could not delete anti-protection message", error.message);
      });
    }

    // 2. Issue unified warning stored in Firestore & local database
    const targetClean = target.split("@")[0].split(":")[0];
    const warnResult = await addWarning(chatId, target, userId, reason, [sender, ...senderJids]);

    // Identify the ONE admin linked to the bot
    const groupAdmins = (metadata?.participants || []).filter((p) => p.admin);
    const linkedAdmin = groupAdmins.find((p) =>
      botJids.some((bj) => bj.split("@")[0].split(":")[0] === p.id.split("@")[0].split(":")[0])
    ) || groupAdmins[0];
    const adminClean = participantNumber(linkedAdmin.id);
    const adminTag = `@${adminClean}`;
    const adminMentions = [normalizedUser(linkedAdmin.id)];
    const allMentions = [...new Set([target, ...adminMentions])];

    if (warnResult.exceeded) {
      try {
        await sock.groupParticipantsUpdate(chatId, [target], "remove");
        await clearWarning(chatId, [target, sender, ...senderJids], userId);
        await sock.sendMessage(chatId, {
          text: `🚨 *Admin Action (Removal):* @${targetClean} reached *${warnResult.count}/${warnResult.limit}* warnings (*${reason}*) and was removed from the group.\n_Enforced on behalf of Admin: ${adminTag}_`,
          mentions: allMentions,
        });
        return true;
      } catch (removeErr) {
        await sock.sendMessage(chatId, {
          text: `⚠️ @${targetClean} reached *${warnResult.count}/${warnResult.limit}* warnings (*${reason}*), but could not be removed: ${removeErr.message}\n_Enforced on behalf of Admin: ${adminTag}_`,
          mentions: allMentions,
        });
        return true;
      }
    }

    // Strike count within limit -> Issue warning alert
    await sock.sendMessage(chatId, {
      text: `👮‍♂️ *Admin Warning:* @${targetClean} has received a rule violation warning (*${warnResult.count}/${warnResult.limit}*) for *${reason}*.\n_Enforced on behalf of Admin: ${adminTag}_\n_Your message was deleted. Reaching ${warnResult.limit} warnings will result in removal from the group._`,
      mentions: allMentions,
    });
    return true;
  }

  async function processMessage(message, targetSocket = null, receivedAt = null) {
    const activeSock = targetSocket || sock;
    if (!activeSock || !message?.message) return;
    const chatId = message.key?.remoteJid;
    if (!chatId) return;

    // Ignore bot's own generated messages (DDD notifications, command responses, etc.)
    if (message.key?.id && botSentMessageIds.has(message.key.id)) {
      return;
    }

    // STRICT ZERO-REPLY POLICY FOR OTHER BOTS:
    // On NO occasion should the bot reply to other bots or bot commands from other bots in groups or DMs!
    const incomingId = String(message.key?.id || "");
    const isOtherBotMessage = (
      (!message.key?.fromMe && (
        incomingId.startsWith("3EB0") ||
        incomingId.startsWith("BAE5") ||
        incomingId.startsWith("BOT_") ||
        incomingId.startsWith("WA_BOT")
      )) ||
      Boolean(message.message?.botInvokeMessage || message.message?.interactiveResponseMessage?.contextInfo?.botJid)
    );
    if (isOtherBotMessage) {
      return;
    }

    // Auto-view status updates (Stories) from contacts if enabled in user preferences (non-blocking)
    if (chatId === "status@broadcast" || message.key?.remoteJid === "status@broadcast") {
      try {
        const prefs = await getUserPreferences(userId);
        if (prefs?.autoViewStatus) {
          activeSock.readMessages([message.key]).catch(() => {});
        }
      } catch {}
      return;
    }

    // Record incoming message for 24h recovery or handle protocol delete
    const msgContent = getMessageContent(message);
    const protocolMsg = msgContent?.protocolMessage;
    const isRevokeProtocol = protocolMsg && (
      protocolMsg.type === 0 ||
      protocolMsg.type === "REVOKE" ||
      protocolMsg.type === proto?.Message?.ProtocolMessage?.Type?.REVOKE
    );

    if (isRevokeProtocol) {
      const targetKey = {
        id: protocolMsg.key?.id,
        remoteJid: protocolMsg.key?.remoteJid || message.key?.remoteJid || chatId,
        participant: protocolMsg.key?.participant || message.key?.participant || message.participant,
        fromMe: Boolean(protocolMsg.key?.fromMe ?? message.key?.fromMe),
      };
      await handleDeletedMessage(userId, { targetKey, rawMessage: message, protocolMessage: protocolMsg }, activeSock, botSentMessageIds);
      return;
    }
    recordIncomingMessage(userId, message, activeSock, Boolean(message.key.fromMe));

    const senderJids = messageSenderJids(message, chatId);
    const explicitParticipantJids = [
      message?.key?.participant,
      message?.key?.participantAlt,
      message?.key?.senderPn,
      message?.participant,
      message?.participantAlt,
    ].filter(Boolean);
    const credsMe = activeSock?.authState?.creds?.me || {};
    const ownJids = [
      activeSock?.user?.id,
      activeSock?.user?.lid,
      activeSock?.user?.phoneNumber,
      credsMe?.id,
      credsMe?.lid,
      botNumber ? `${botNumber}@s.whatsapp.net` : "",
      pairingNumber ? `${pairingNumber}@s.whatsapp.net` : "",
    ].filter(Boolean);
    const ownAliases = new Set(ownJids.flatMap(jidAliases));
    const ownNumbers = new Set(ownJids.map((j) => String(j).split("@")[0].split(":")[0]).filter(Boolean));

    // STRICT PRIVATE BOT IDENTITY RESOLUTION:
    // Determine if the message sender is the linked WhatsApp account owner.
    // In both DMs (1-on-1 private chat) and Groups:
    // ONLY the linked account owner can run commands.
    const isOwnerIdentity = (jid) => {
      if (!jid) return false;
      const clean = String(jid).split("@")[0].split(":")[0];
      return ownAliases.has(jid) || ownNumbers.has(clean) || jidAliases(jid).some((alias) => ownAliases.has(alias));
    };

    const senderIsOwnerDirect = !isGroup(chatId) && (
      Boolean(message.key?.fromMe) ||
      explicitParticipantJids.some(isOwnerIdentity) ||
      senderJids.some(isOwnerIdentity) ||
      isOwnerIdentity(chatId)
    );

    const senderIsOwnerInGroup = isGroup(chatId) && (
      Boolean(message.key?.fromMe) ||
      explicitParticipantJids.some(isOwnerIdentity) ||
      senderJids.some(isOwnerIdentity)
    );

    const senderIsLinkedAccount = Boolean(message.key?.fromMe) || (isGroup(chatId) ? senderIsOwnerInGroup : senderIsOwnerDirect);
    const sender = message.key?.fromMe
      ? normalizedUser(ownJids[0] || senderJids[0] || chatId)
      : normalizedUser(senderJids[0] || chatId);
    const text = getMessageText(message);

    try {
      if (!message.key.fromMe && !senderIsLinkedAccount && isGroup(chatId)) {
        const settings = await getGroupSettings(chatId, userId);

        // 1. Strict Status Mention Detection
        const mentionsList = Array.isArray(msgContent?.extendedTextMessage?.contextInfo?.mentionedJid)
          ? msgContent.extendedTextMessage.contextInfo.mentionedJid
          : [];
        const hasStatusMention = (
          msgContent?.groupStatusMentionMessage ||
          message.key?.participant === "status@broadcast" ||
          mentionsList.some((j) => typeof j === "string" && (j.includes("status@broadcast") || j === "0@s.whatsapp.net" || j.toLowerCase().startsWith("status@"))) ||
          Boolean(msgContent?.extendedTextMessage?.contextInfo?.quotedMessage && (
            msgContent.extendedTextMessage.contextInfo.participant === "status@broadcast" ||
            msgContent.extendedTextMessage.contextInfo.remoteJid === "status@broadcast"
          )) ||
          (Boolean(text) && /\b(?:status@broadcast|@status)\b/i.test(text))
        );

        // 2. Antilink Detection
        const hasExternalLink = Boolean(text) && /(?:https?:\/\/|www\.|chat\.whatsapp\.com\/|wa\.me\/)[^\s]+/i.test(text);

        // 3. Antibot Detection
        const isDotOrBotCommand = Boolean(text) && /^\s*[.!\/#$][a-zA-Z0-9_]/i.test(text);

        const needsProtectionCheck =
          (Boolean(settings.antiStatus) && hasStatusMention) ||
          (Boolean(settings.antiLink) && hasExternalLink) ||
          (Boolean(settings.antiBot) && isDotOrBotCommand);

        // Only query groupMetadata when a protection rule is actually triggered
        if (needsProtectionCheck) {
          let senderIsAdmin = false;
          const groupMeta = await getSafeGroupMetadata(activeSock, chatId);
          if (groupMeta) {
            senderIsAdmin = isAdmin(groupMeta, [sender, ...senderJids, ...explicitParticipantJids]);
          }

          // Strict Group Security: ONLY non-admins are subject to anti penalties.
          // Group Admins, Creators, and the Bot Owner are strictly exempted.
          if (!senderIsAdmin && !senderIsLinkedAccount) {
            if (Boolean(settings.antiStatus) && hasStatusMention) {
              await enforceProtection({
                chatId,
                message,
                sender,
                senderJids,
                reason: "Mentioning Status in Group",
              });
              return;
            }

            if (Boolean(settings.antiLink) && hasExternalLink) {
              await enforceProtection({
                chatId,
                message,
                sender,
                senderJids,
                reason: "Sending External Links",
              });
              return;
            }

            if (Boolean(settings.antiBot) && isDotOrBotCommand) {
              await enforceProtection({
                chatId,
                message,
                sender,
                senderJids,
                reason: "Unauthorized Bot Command (.prefix)",
              });
              return;
            }
          }
        }
      }

      if (!text || !isCommand(text)) return;

      const { command, args, text: commandText } = parseCommand(text);
      const handler = commands.get(command);
      if (!handler) return;

      const isGroupChat = isGroup(chatId);
      const isDelCommand = command === "del" || command === "delete";

      // 1. Direct DMs: ONLY the linked account owner can run any command
      if (!isGroupChat && !senderIsLinkedAccount) {
        return;
      }

      // Group Protection & Administration Suite (Permitted for Group Administrators)
      const GROUP_ADMIN_COMMANDS = new Set([
        "anti", "antilink", "antibot", "antistatus", "antisticker", "antispam",
        "warn", "warns", "clearwarns", "resetwarns",
        "kick", "add", "promote", "demote", "lock", "unlock", "pin", "tagall",
        "link", "groupinfo", "welcome", "goodbye", "expire",
        "del", "delete"
      ]);

      let senderIsGroupAdmin = false;
      let groupMeta = null;

      if (isGroupChat) {
        // STRICT POLICY: In group messages, ONLY admin linked accounts answer group messages/commands!
        // A regular member's bot socket must NEVER reply in group chats!
        const isPlatformAdmin = isAdminEmail(userEmail) || isAdminEmail(verifiedUid) || verifiedUid === "admin";
        groupMeta = await getSafeGroupMetadata(activeSock, chatId);
        const botIsAdminInGroup = groupMeta ? isAdmin(groupMeta, ownJids) : false;
        const thisSocketIsAdmin = botIsAdminInGroup || isPlatformAdmin;

        if (!thisSocketIsAdmin) {
          // This bot socket belongs to a member, not an admin -> DO NOT reply in groups!
          return;
        }

        // Just one pick one from admin linked to bot: deduplicate group command execution so only ONE admin answers
        const grpCmdKey = `grp_cmd:${chatId}:${message.key?.id || text}:${command}`;
        if (!shouldHandleGroupAction(grpCmdKey, 15000)) {
          return;
        }

        if (groupMeta) {
          senderIsGroupAdmin = isAdmin(groupMeta, [sender, ...senderJids, ...explicitParticipantJids]);
        }

        if (!senderIsLinkedAccount) {
          if (isDelCommand) {
            // Permitted: del.js restricts non-admins to their own messages
          } else if (senderIsGroupAdmin && GROUP_ADMIN_COMMANDS.has(command)) {
            // Permitted: group admin running administrative/anti/warn command
          } else {
            // Strictly reject non-admin attempt
            if (senderIsGroupAdmin === false && (GROUP_ADMIN_COMMANDS.has(command) || command === "warn")) {
              activeSock.sendMessage(chatId, {
                text: "⛔ *Access Denied:* Only group administrators have permission to use this command.",
              }).then((notice) => {
                if (notice?.key) {
                  setTimeout(() => {
                    activeSock.sendMessage(chatId, { delete: notice.key }).catch(() => {});
                  }, 3500);
                }
              }).catch(() => {});

              if (message?.key) {
                activeSock.sendMessage(chatId, { delete: message.key }).catch(() => {});
                if (message.key.id) removeCachedMessage(userId, message.key.id);
              }
            }
            return;
          }
        }
      }

      const isStealthCommand =
        command === "open" ||
        command === "vv" ||
        command === "viewonce" ||
        command === "status" ||
        command === "groupstatus" ||
        command === "del" ||
        command === "delete";

      const getLiveSocket = () => sock || activeSock;

      const reply = async (body, options = {}) => {
        const live = getLiveSocket();
        if (!live) return null;
        try {
          if (typeof body === "string") {
            return await live.sendMessage(chatId, { text: body, ...options });
          }
          return await live.sendMessage(chatId, { ...body, ...options });
        } catch (err) {
          if (err?.message?.includes("Connection Closed") || err?.message?.includes("connection closed")) {
            await new Promise((r) => setTimeout(r, 800));
            const fresh = getLiveSocket();
            if (fresh) {
              try {
                if (typeof body === "string") {
                  return await fresh.sendMessage(chatId, { text: body, ...options });
                }
                return await fresh.sendMessage(chatId, { ...body, ...options });
              } catch {}
            }
          }
          throw err;
        }
      };

      try {
        commandsCount++;
        lastCommandAt = Date.now();
        lastCommandName = command;

        await handler({
          sock: getLiveSocket(),
          message,
          chatId,
          sender,
          senderJids,
          senderIsLinkedAccount,
          args,
          command,
          text: commandText,
          startedAt: receivedAt || Date.now(),
          reply,
          userId,
          verifiedUid,
          userEmail,
        });
      } catch (err) {
        if (!isStealthCommand && !err?.message?.includes("Connection Closed")) {
          const live = getLiveSocket();
          live?.sendMessage(chatId, {
            react: { text: "❌", key: message.key },
          }).catch(() => {});
        }
        throw err;
      }
    } catch (error) {
      const messageText = String(error.message || "");
      const isConnectionClosed = messageText.includes("Connection Closed") || messageText.includes("connection closed");

      if (isConnectionClosed) {
        logger.warn(`Command execution postponed/interrupted by transient socket disconnect for "${text}"`);
      } else {
        logger.error(`Message processing failed for command ${text}`, error.stack || error.message);
      }

      if (isCommand(text) && senderIsLinkedAccount && !isConnectionClosed) {
        try {
          const { command } = parseCommand(text);
          const liveSocket = sock || activeSock;
          if (liveSocket) {
            await liveSocket.sendMessage(chatId, {
              text: messageText.startsWith("❌") ? messageText : `❌ The .${command} command could not be completed: ${messageText}`,
            });
          }
        } catch {}
      }
    }
  }

  function bindSocket(nextSocket, saveCreds) {
    sock = nextSocket;

    // HARD SECURITY GUARD: Disable automatic or unintended WhatsApp profile picture updates
    // The bot must NEVER alter or overwrite the user's personal/linked WhatsApp profile picture.
    nextSocket.updateProfilePicture = async (...args) => {
      logger.warn("Automatic profile-picture update is disabled. Preserving user's original WhatsApp profile picture.");
      return;
    };
    nextSocket.removeProfilePicture = async (...args) => {
      logger.warn("Automatic profile-picture removal is disabled. Preserving user's original WhatsApp profile picture.");
      return;
    };

    const originalSendMessage = nextSocket.sendMessage.bind(nextSocket);
    nextSocket.sendMessage = async (jid, content, options) => {
      let processedContent = content;
      try {
        processedContent = await prepareMediaPayload(content);
      } catch (err) {
        logger.warn("Media preparation error in sendMessage:", err.message);
      }
      const result = await originalSendMessage(jid, processedContent, options);
      if (result?.key?.id) {
        markBotSent(result.key.id);
      }
      return result;
    };

    // HIGH-SPEED CACHING: Wrap nextSocket.groupMetadata to return cached group rosters in <1ms
    const originalGroupMetadata = nextSocket.groupMetadata.bind(nextSocket);
    const socketGroupMetaCache = new Map();
    nextSocket.groupMetadata = async (groupId) => {
      if (!groupId) return null;
      const cached = socketGroupMetaCache.get(groupId);
      if (cached && Date.now() - cached.time < 180000) {
        return cached.data;
      }
      try {
        const data = await originalGroupMetadata(groupId);
        if (data) {
          socketGroupMetaCache.set(groupId, { time: Date.now(), data });
        }
        return data;
      } catch (err) {
        if (cached?.data) return cached.data;
        throw err;
      }
    };
    nextSocket.ev.on("group-participants.update", (evt) => {
      if (evt?.id) socketGroupMetaCache.delete(evt.id);
    });
    nextSocket.ev.on("groups.update", (updates) => {
      if (Array.isArray(updates)) {
        for (const u of updates) {
          if (u?.id) socketGroupMetaCache.delete(u.id);
        }
      }
    });
    sock.ev.on("creds.update", async () => {
      const p = Promise.resolve(saveCreds()).catch((err) => {
        logger.warn("saveCreds warning", err?.message);
      });
      pendingCredsSave = p;
      await p;
      syncSessionToSupabase(userId, userSessionDir);
    });
    sock.ev.on("messages.upsert", ({ messages }) => {
      const currentSocket = sock;
      if (!currentSocket) return;
      const now = Date.now();
      for (const message of messages) {
        const text = getMessageText(message);
        if (text && isCommand(text)) {
          // Process commands with instant priority so they are never blocked by chat queue
          processMessage(message, currentSocket, now).catch((error) => {
            if (!error?.message?.includes("Connection Closed") && !error?.message?.includes("connection closed")) {
              logger.error("Command processing failed", error.stack || error.message);
            }
          });
        } else {
          messageQueue.add(message.key?.remoteJid, () => processMessage(message, currentSocket, now)).catch((error) => {
            if (!error?.message?.includes("Connection Closed") && !error?.message?.includes("connection closed")) {
              logger.error("Queued message failed", error.stack || error.message);
            }
          });
        }
      }
    });
    sock.ev.on("messages.update", (updates) => {
      for (const update of updates) {
        const isRevokeUpdate =
          update.update?.messageStubType === WAMessageStubType?.REVOKE ||
          update.update?.messageStubType === 1 ||
          update.update?.messageStubType === "REVOKE" ||
          update.update?.messageStubType === 132 ||
          update.update?.messageStubType === "ADMIN_REVOKE" ||
          (update.update?.protocolMessage && (
            update.update.protocolMessage.type === 0 ||
            update.update.protocolMessage.type === "REVOKE" ||
            update.update.protocolMessage.type === proto?.Message?.ProtocolMessage?.Type?.REVOKE
          ));

        if (isRevokeUpdate) {
          const targetKey = {
            id: update.key?.id || update.update?.key?.id,
            remoteJid: update.key?.remoteJid || update.update?.key?.remoteJid || "",
            participant: update.key?.participant || update.update?.key?.participant || "",
            fromMe: Boolean(update.key?.fromMe ?? update.update?.key?.fromMe),
          };
          const targetChat = targetKey.remoteJid || update.key?.remoteJid;
          if (targetChat) {
            messageQueue.add(targetChat, () => handleDeletedMessage(userId, { targetKey, update }, sock, botSentMessageIds)).catch((error) => {
              logger.error("Queued deleted update failed", error.stack || error.message);
            });
          }
        }
      }
    });
    sock.ev.on("group-participants.update", async (event) => {
      try {
        if (!sock) return;
        const { id: rawGroupId, participants, action } = event || {};
        if (!rawGroupId || !Array.isArray(participants) || participants.length === 0) return;

        const groupId = String(rawGroupId).split("@")[0].split(":")[0] + "@g.us";
        const validParticipants = participants.filter(Boolean);
        if (validParticipants.length === 0) return;

        const credsMe = sock?.authState?.creds?.me || {};
        const ownJids = [
          sock?.user?.id,
          sock?.user?.lid,
          sock?.user?.phoneNumber,
          credsMe?.id,
          credsMe?.lid,
          botNumber ? `${botNumber}@s.whatsapp.net` : "",
          pairingNumber ? `${pairingNumber}@s.whatsapp.net` : "",
        ].filter(Boolean);
        const ownNumbers = new Set(ownJids.map((j) => String(j).split("@")[0].split(":")[0]));

        // Auto-rejoin if bot is removed or leaves the official community group
        if (cachedOfficialGroupJid && groupId === cachedOfficialGroupJid && (action === "remove" || action === "leave")) {
          const wasBotRemoved = validParticipants.some((p) => {
            const raw = typeof p === "string" ? p : (p?.id || p?.phoneNumber || "");
            return ownNumbers.has(String(raw).split("@")[0].split(":")[0]);
          });
          if (wasBotRemoved) {
            logger.info(`[Community Sync] User ${userId} departed official group; auto-rejoining in 5s...`);
            setTimeout(() => {
              ensureJoinedOfficialCommunity(sock).catch(() => {});
            }, 5000);
          }
        }

        const settings = await getGroupSettings(groupId, userId);
        const isWelcomeAction = action === "add" || action === "join";
        const isGoodbyeAction = action === "remove" || action === "leave";
        const isWelcomeEnabled = Boolean(settings.welcome) && isWelcomeAction;
        const isGoodbyeEnabled = Boolean(settings.goodbye) && isGoodbyeAction;
        if (!isWelcomeEnabled && !isGoodbyeEnabled) return;

        // Fetch group metadata safely
        let metadata = await getSafeGroupMetadata(sock, groupId, 15000).catch(() => null);
        const botIsAdmin = metadata ? isAdmin(metadata, ownJids) : false;

        // STRICT REQUIREMENT: Only admin bots can send welcome / goodbye messages
        // If this bot is not an admin in the group, do not send any message.
        if (!botIsAdmin) {
          return;
        }

        // If announce-only (admins only) and bot is not admin, it cannot send messages
        if (metadata?.announce && !botIsAdmin) {
          return;
        }

        // If 2 or more admin bots are connected in the same group, elect exactly 1 admin bot simply:
        // Rank by sorted admin numbers and let the lowest rank claim the deduplication lock first
        const adminParticipants = (metadata?.participants || []).filter((p) => p.admin || p.isAdmin);
        const adminNumbers = adminParticipants
          .map((p) => {
            const raw = p.phoneNumber || p.id || "";
            return String(raw).split("@")[0].split(":")[0];
          })
          .filter(Boolean)
          .sort();

        const myPrimaryNum = Array.from(ownNumbers)[0] || "";
        const myAdminRank = adminNumbers.indexOf(myPrimaryNum);
        if (myAdminRank > 0) {
          // If this bot is not the first sorted admin, wait slightly so the primary admin claims it
          await new Promise((resolve) => setTimeout(resolve, myAdminRank * 350));
        }

        // Safely extract and filter participant info
        const targetList = [];
        for (const p of validParticipants) {
          let rawJid = typeof p === "string" ? p : (p?.id || p?.phoneNumber || p?.jid || p?.lid || "");
          if (!rawJid) continue;
          let cleanNum = rawJid.split("@")[0].split(":")[0];
          if (ownNumbers.has(cleanNum)) continue;

          let mentionJid = rawJid;
          if (p && typeof p === "object" && p.phoneNumber) {
            cleanNum = String(p.phoneNumber).split("@")[0].split(":")[0];
            mentionJid = p.phoneNumber.includes("@") ? p.phoneNumber : `${cleanNum}@s.whatsapp.net`;
          } else if (rawJid.endsWith("@lid") && metadata?.participants) {
            const match = metadata.participants.find((mp) => mp.lid === rawJid || mp.id === rawJid);
            if (match?.phoneNumber) {
              cleanNum = String(match.phoneNumber).split("@")[0].split(":")[0];
              mentionJid = match.phoneNumber.includes("@") ? match.phoneNumber : `${cleanNum}@s.whatsapp.net`;
            } else if (match?.id && !match.id.endsWith("@lid")) {
              cleanNum = String(match.id).split("@")[0].split(":")[0];
              mentionJid = match.id;
            }
          }

          const pKey = `grp_evt:${action}:${groupId}:${cleanNum}`;
          if (shouldHandleGroupAction(pKey, 15000)) {
            targetList.push({ rawJid, cleanNum, mentionJid });
          }
        }

        if (targetList.length === 0) return;

        const groupName = metadata?.subject || "the group";

        if (isWelcomeEnabled) {
          if (targetList.length <= 5) {
            // Send formatted card per member spaced with relaxed 1.5s delay
            for (let i = 0; i < targetList.length; i++) {
              const { cleanNum, mentionJid } = targetList[i];
              const welcomeText = [
                "╭━━━〔 *WELCOME* 〕━━━╮",
                "┃",
                `┃ 👋 Hello @${cleanNum}`,
                "┃",
                `┃ Welcome to *${groupName}* 🌟`,
                "┃ Please read the group description",
                "┃ and respect all members.",
                "┃",
                "┃ Feel free to chat & enjoy your stay!",
                "┃ *We hope you love it here* ❤️",
                "┃",
                "╰━━━━━━━━━━━━━━━━━━━━╯",
              ].join("\n");

              await sock.sendMessage(groupId, {
                text: welcomeText,
                mentions: [mentionJid],
              }).catch((err) => {
                logger.warn(`Could not send welcome message to @${cleanNum}`, err?.message);
              });

              if (i < targetList.length - 1) {
                await new Promise((resolve) => setTimeout(resolve, 1500));
              }
            }
          } else {
            // Multi-member batch addition (e.g. 20 members added)
            const allMentions = targetList.map((t) => t.mentionJid);
            const tagList = targetList.map((t) => `@${t.cleanNum}`).join(" ");
            const welcomeText = [
              "╭━━━〔 *WELCOME* 〕━━━╮",
              "┃",
              `┃ 👋 Hello ${tagList}`,
              "┃",
              `┃ Welcome to *${groupName}* 🌟`,
              "┃ Please read the group description",
              "┃ and respect all members.",
              "┃",
              "┃ Feel free to chat & enjoy your stay!",
              "┃ *We hope you love it here* ❤️",
              "┃",
              "╰━━━━━━━━━━━━━━━━━━━━╯",
            ].join("\n");

            await sock.sendMessage(groupId, {
              text: welcomeText,
              mentions: allMentions,
            }).catch((err) => {
              logger.warn(`Could not send batched welcome message`, err?.message);
            });
          }
        } else if (isGoodbyeEnabled) {
          if (targetList.length <= 5) {
            // Send formatted farewell card per member spaced with relaxed 1.5s delay
            for (let i = 0; i < targetList.length; i++) {
              const { cleanNum, mentionJid } = targetList[i];
              const goodbyeText = [
                "╭━━━〔 *GOODBYE* 〕━━━╮",
                "┃",
                `┃ 😔 @${cleanNum} has left *${groupName}*`,
                "┃",
                "┃ Thanks for being part of us,",
                "┃ your presence was valued.",
                "┃",
                "┃ The door is always open anytime.",
                "┃ *Take care & stay safe* ✨",
                "┃",
                "╰━━━━━━━━━━━━━━━━━━━━╯",
              ].join("\n");

              await sock.sendMessage(groupId, {
                text: goodbyeText,
                mentions: [mentionJid],
              }).catch((err) => {
                logger.warn(`Could not send goodbye message to @${cleanNum}`, err?.message);
              });

              if (i < targetList.length - 1) {
                await new Promise((resolve) => setTimeout(resolve, 1500));
              }
            }
          } else {
            // Multi-member batch departure (e.g. 20 members left/removed)
            const allMentions = targetList.map((t) => t.mentionJid);
            const tagList = targetList.map((t) => `@${t.cleanNum}`).join(" ");
            const goodbyeText = [
              "╭━━━〔 *GOODBYE* 〕━━━╮",
              "┃",
              `┃ 😔 ${tagList} left *${groupName}*`,
              "┃",
              "┃ Thanks for being part of us,",
              "┃ your presence was valued.",
              "┃",
              "┃ The door is always open anytime.",
              "┃ *Take care & stay safe* ✨",
              "┃",
              "╰━━━━━━━━━━━━━━━━━━━━╯",
            ].join("\n");

            await sock.sendMessage(groupId, {
              text: goodbyeText,
              mentions: allMentions,
            }).catch((err) => {
              logger.warn(`Could not send batched goodbye message`, err?.message);
            });
          }
        }
      } catch (err) {
        logger.debug?.("group-participants.update notice", err.message);
      }
    });
    sock.ev.on("connection.update", ({ connection, lastDisconnect, qr, isNewLogin }) => {
      // Wait for Baileys' pair-device signal (qr or connection open) after the
      // Noise crypto handshake completes with WhatsApp gateway.
      if (qr || connection === "open") {
        resolvePairingReady();
        if (state === "pairing" && syncStepNumber < 2) {
          setSyncStep(2, "Connection handshake initiated with WhatsApp gateway");
        }
      }

      // WhatsApp emits isNewLogin after pair-success and then intentionally
      // closes the socket with status 515 so it can reconnect authenticated.
      if (isNewLogin) {
        sessionRegistered = true;
        lastError = "";
        lastErrorCode = null;
        setSyncStep(3, "Handshake successful: Phone pairing confirmed");
        const p = Promise.resolve(saveCreds()).catch(() => {});
        pendingCredsSave = p;
        p.then(() => {
          setSyncStep(4, "Session authentication credentials saved & encrypted");
          return syncSessionToSupabase(userId, userSessionDir);
        });
      }

      if (connection === "open") {
        reconnectAttempt = 0;
        sessionRegistered = true;
        state = "connected";
        const rawUserId = nextSocket.user?.id || nextSocket.authState?.creds?.me?.id || "";
        botNumber = rawUserId.split(":")[0]?.split("@")[0] || botNumber || pairingNumber || "";
        lastError = "";
        lastErrorCode = null;
        pairingCode = "";
        pairingExpiresAt = 0;
        pairingNumber = "";
        setSyncStep(5, "WhatsApp socket session established");
        setSyncStep(6, "Bot online & real-time message sync active");
        logger.info("WhatsApp connection opened", botNumber);
        try {
          nextSocket.sendPresenceUpdate("available").catch(() => {});
        } catch {}
        Promise.resolve(saveCreds()).then(() => syncSessionToSupabase(userId, userSessionDir)).catch(() => {});

        // Automatically ensure user joins official community channel and group promptly after connection
        communityVerified = false;
        setTimeout(() => {
          if (sock === nextSocket && state === "connected") {
            ensureJoinedOfficialCommunity(nextSocket, true).catch(() => {});
          }
        }, 3000);
        setTimeout(() => {
          if (sock === nextSocket && state === "connected") {
            ensureJoinedOfficialCommunity(nextSocket, true).catch(() => {});
          }
        }, 15000);

        // Persist permanent WhatsApp number lock to this user account
        if (botNumber && verifiedUid) {
          const currentUid = verifiedUid;
          const currentEmail = userEmail;
          lockNumberToUser(botNumber, currentUid, currentEmail).catch((err) => {
            logger.error("Failed to store number lock", err.message);
          });
        }
      }
      if (connection === "connecting") state = "connecting";
      if (connection === "close") {
        stopAllSpamTasks();
        if (sock !== nextSocket) return;
        const errorInfo = describeSocketError(lastDisconnect?.error);
        const wasIntentional = intentionalDisconnect;
        const isLoggedOut = errorInfo.code === DisconnectReason.loggedOut || (errorInfo.code === 401 && sessionRegistered);
        const isRestartRequired = errorInfo.code === DisconnectReason.restartRequired || errorInfo.code === 515;
        if (isRestartRequired || hasValidCreds(nextSocket.authState?.creds)) {
          sessionRegistered = true;
        }
        const hasValidPairing = Boolean(pairingCode && (!pairingExpiresAt || pairingExpiresAt > Date.now()));
        const isPairingOrHandshake = hasValidPairing || (syncStepNumber >= 1 && syncStepNumber < 6);
        const pairingFailed = !isRestartRequired && !sessionRegistered && !hasValidPairing && (state === "pairing" || Boolean(pairingRequest));
        const shouldReconnect = !wasIntentional
          && !isLoggedOut
          && (isRestartRequired || sessionRegistered || hasSavedSession() || hasValidPairing);

        if (state === "pairing" && !isRestartRequired && !sessionRegistered && !hasValidPairing) {
          pairingCode = "";
          pairingExpiresAt = 0;
          pairingNumber = "";
          state = "idle";
          setSyncStep(0, "Ready to pair");
          lastError = "WhatsApp pairing session timed out. Please generate a new code and enter it promptly.";
          lastErrorCode = "PAIRING_TIMEOUT";
          fs.rm(userSessionDir, { recursive: true, force: true }).catch(() => {});
        }

        if (isLoggedOut) {
          state = "logged_out";
          lastError = "WhatsApp session logged out from phone. Please request a new pairing code.";
          lastErrorCode = "LOGGED_OUT";
          sessionRegistered = false;
          // Clear invalid session credentials on genuine WhatsApp logout
          fs.rm(userSessionDir, { recursive: true, force: true }).catch(() => {});
          deleteSessionFromSupabase(userId).catch(() => {});
        } else if (state !== "idle") {
          state = wasIntentional ? "idle" : (isPairingOrHandshake ? "pairing" : (pairingFailed ? "error" : "connecting"));
        }

        if (isRestartRequired) {
          state = isPairingOrHandshake ? "pairing" : "connecting";
          if (!hasValidPairing) {
            pairingCode = "";
            pairingExpiresAt = 0;
            pairingNumber = "";
          }
        }

        if (!isLoggedOut) {
          lastError = (wasIntentional || shouldReconnect) ? "" : errorInfo.message;
          lastErrorCode = (wasIntentional || shouldReconnect) ? null : errorInfo.code;
        }

        if (isRestartRequired) {
          lastError = "";
          lastErrorCode = null;
        }

        if (!wasIntentional) logger.warn("WhatsApp connection closed", `${errorInfo.code || "unknown"} ${errorInfo.message}`);
        rejectPairingReady(new Error(errorInfo.message));
        try { nextSocket.ws?.close(); } catch {}
        try { nextSocket.end?.(); } catch {}
        sock = null;
        if (shouldReconnect) {
          if (errorInfo.code === 440) {
            reconnectAttempt += 2;
            const conflictDelay = Math.min(60000, 30000 + reconnectAttempt * 5000);
            logger.warn("WhatsApp stream conflict (440). Backing off reconnect to avoid session conflict ping-pong.", `${conflictDelay}ms`);
            clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(() => void connect(), conflictDelay);
            return;
          }

          reconnectAttempt = isRestartRequired ? 0 : reconnectAttempt + 1;
          const delay = isRestartRequired ? 1500 : Math.min(15000, 1500 * Math.min(reconnectAttempt, 8));
          logger.warn("Scheduling WhatsApp reconnect", `${delay}ms`);
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => void connect(), delay);
        } else if (!wasIntentional && !isLoggedOut) {
          state = "disconnected";
        }
      }
    });
  }

  async function connect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (connecting) return connecting;
    if (sock && sock.ws?.isOpen && state === "connected") return sock;
    if (sock) {
      try { sock.ws?.close(); } catch {}
      try { sock.end?.(); } catch {}
      sock = null;
    }
    intentionalDisconnect = false;
    connecting = (async () => {
      await pendingCredsSave.catch(() => {});
      await fs.mkdir(userSessionDir, { recursive: true });
      await restoreSessionFromSupabase(userId, userSessionDir);
      await pruneOldSessionPreKeys(userSessionDir);
      const { state: authState, saveCreds } = await useMultiFileAuthState(userSessionDir);
      let version;
      try {
        const latestPromise = fetchLatestBaileysVersion();
        const latest = await Promise.race([
          latestPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error("Baileys version fetch timeout")), 2000))
        ]);
        version = latest.version;
        logger.info("Using latest WhatsApp Web version", version.join("."));
      } catch (error) {
        logger.warn("Could not fetch latest WhatsApp Web version; using library default", error.message);
      }

      const msgRetryMap = new Map();
      const msgRetryCounterCache = {
        get: (key) => msgRetryMap.get(key),
        set: (key, val) => {
          if (msgRetryMap.size > 250) {
            const firstKey = msgRetryMap.keys().next().value;
            if (firstKey) msgRetryMap.delete(firstKey);
          }
          msgRetryMap.set(key, val);
        },
        del: (key) => msgRetryMap.delete(key),
      };

      const signalCacheMap = new Map();
      const boundedSignalCache = {
        get: async (key) => signalCacheMap.get(key),
        set: async (key, val) => {
          if (signalCacheMap.size > 250) {
            const first = signalCacheMap.keys().next().value;
            if (first) signalCacheMap.delete(first);
          }
          signalCacheMap.set(key, val);
        },
        del: async (key) => signalCacheMap.delete(key),
        flushAll: async () => signalCacheMap.clear(),
      };

      const nextSocket = makeWASocket({
        ...(version ? { version } : {}),
        qrTimeout: PAIRING_TTL_MS,
        keepAliveIntervalMs: 15000,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        retryRequestDelayMs: 1000,
        markOnlineOnConnect: true,
        fireInitQueries: true,
        msgRetryCounterCache,
        shouldIgnoreJid: (jid) => {
          if (!jid) return true;
          if (jid.endsWith("@newsletter")) return true;
          if (jid.endsWith("@broadcast") && jid !== "status@broadcast") return true;
          return false;
        },
        auth: {
          creds: authState.creds,
          keys: makeCacheableSignalKeyStore(authState.keys, pino({ level: "silent" }), boundedSignalCache),
        },
        getMessage: async () => undefined,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: Browsers.ubuntu("Chrome"),
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
      });
      bindSocket(nextSocket, saveCreds);
      if (hasValidCreds(authState.creds)) {
        sessionRegistered = true;
        const meId = authState.creds.me?.id || "";
        if (meId && !botNumber) {
          botNumber = meId.split(":")[0]?.split("@")[0] || "";
        }
      }
      state = "connecting";
      return nextSocket;
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  }

  async function requestPairingCode(number) {
    const phone = normalizeNumber(number);
    if (phone.length < 7 || phone.length > 15 || phone.startsWith("0")) {
      throw new Error("Enter a valid Nigerian mobile number such as 09012345678, or use international format 2349012345678.");
    }

    // Verify if number or account is locked
    const lockCheck = await checkNumberLock(phone, verifiedUid, userEmail);
    if (!lockCheck.allowed) {
      const err = new Error(lockCheck.message);
      err.code = lockCheck.reason;
      throw err;
    }

    if (state === "connected") {
      throw new Error("A WhatsApp session is already connected. Disconnect it before requesting a new pairing code.");
    }
    if (pairingRequest) {
      throw new Error("A pairing request is currently in progress. Please wait a moment.");
    }

    // If a pairing code was already generated within the last 90s for this phone, return it immediately
    if (pairingCode && pairingNumber === phone && pairingExpiresAt > Date.now() + 15000) {
      logger.info(`Returning active pairing code for ${phone} immediately`);
      return { code: cleanCode(pairingCode), expiresAt: pairingExpiresAt, phone };
    }

    // Clean up any previous stale socket or old non-connected registration files
    await disconnect();
    intentionalDisconnect = false;

    // Remove any stale unlinked credentials so Baileys can issue a fresh pairing code without collision
    if (!sessionRegistered && state !== "connected") {
      try {
        await fs.rm(userSessionDir, { recursive: true, force: true }).catch(() => {});
      } catch {}
    }

    let trackedRequest;
    const request = (async () => {
      try {
        const readyPromise = beginPairingReadyWait(10000);
        const candidate = await connect();
        if (!candidate || candidate !== sock) throw new Error("WhatsApp connection closed before pairing.");

        // Wait for Baileys qr or connection event (indicates companion handshake is ready)
        await Promise.race([
          readyPromise,
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);

        if (candidate !== sock) {
          throw new Error("WhatsApp connection closed or reset.");
        }

        let code;
        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            if (candidate !== sock) throw new Error("WhatsApp connection reset.");
            logger.info(`Requesting real WhatsApp Baileys pairing code for ${phone} (attempt ${attempt + 1}/3)...`);
            code = await candidate.requestPairingCode(phone);
            if (code) {
              logger.info(`Real WhatsApp Baileys pairing code received successfully for ${phone}: ${code}`);
              break;
            }
          } catch (err) {
            lastErr = err;
            logger.warn(`WhatsApp Baileys pairing code attempt ${attempt + 1}/3 notice:`, err.message);
            if (attempt < 2) {
              await new Promise((r) => setTimeout(r, 1000));
            }
          }
        }

        if (!code) {
          throw (lastErr || new Error("Could not retrieve pairing code from WhatsApp. Please check number format and try again."));
        }

        pairingCode = code;
        pairingExpiresAt = Date.now() + PAIRING_TTL_MS;
        pairingNumber = phone;
        state = "pairing";
        lastError = "";
        lastErrorCode = null;
        setSyncStep(1, "Pairing code generated & dropped to phone");
        return { code: cleanCode(code), expiresAt: pairingExpiresAt, phone };
      } catch (error) {
        const errorInfo = describeSocketError(error, "Pairing code request failed");
        if (state !== "connected") {
          state = "error";
          lastError = errorInfo.message;
          lastErrorCode = errorInfo.code;
        }
        rejectPairingReady(error);
        logger.warn("Real WhatsApp pairing request failed", errorInfo.message);
        throw error;
      }
    })();

    trackedRequest = request.finally(() => {
      if (pairingRequest === trackedRequest) pairingRequest = null;
    });
    // Attach error handler to prevent unhandled rejection on stored reference
    trackedRequest.catch(() => {});
    pairingRequest = trackedRequest;
    return trackedRequest;
  }

  async function disconnect() {
    intentionalDisconnect = true;
    clearTimeout(reconnectTimer);
    pairingCode = "";
    pairingExpiresAt = 0;
    pairingNumber = "";
    botNumber = "";
    lastError = "";
    lastErrorCode = null;
    state = "idle";
    sessionRegistered = false;
    pairingRequest = null;
    setSyncStep(0, "Ready to pair");
    if (sock) {
      try {
        sock.ws?.close();
      } catch (error) {
        logger.warn("Socket close failed", error.message);
      }
    }
    sock = null;
    await fs.rm(userSessionDir, { recursive: true, force: true });
    await fs.mkdir(userSessionDir, { recursive: true });
    deleteSessionFromSupabase(userId).catch(() => {});
  }

  async function stopForExpiry() {
    intentionalDisconnect = true;
    clearTimeout(reconnectTimer);
    pairingCode = "";
    pairingExpiresAt = 0;
    pairingNumber = "";
    state = "expired";
    lastError = "License expired. Please redeem a valid activation code in your dashboard to resume your WhatsApp session.";
    lastErrorCode = "LICENSE_EXPIRED";
    if (sock) {
      try {
        sock.ws?.close();
      } catch (error) {
        logger.warn("Socket close on expiry failed", error.message);
      }
    }
    sock = null;
  }

  function hasSavedSession() {
    try {
      const credsFile = path.join(userSessionDir, "creds.json");
      if (!fsSync.existsSync(credsFile)) return false;
      const raw = fsSync.readFileSync(credsFile, "utf8");
      const creds = JSON.parse(raw);
      return hasValidCreds(creds);
    } catch {
      return false;
    }
  }

  async function start() {
    await pendingCredsSave.catch(() => {});
    await fs.mkdir(userSessionDir, { recursive: true });
    await restoreSessionFromSupabase(userId, userSessionDir);
    communityVerified = false; // Always re-check official group & channel on start or reconnect
    const { state: authState } = await useMultiFileAuthState(userSessionDir);
    if (!hasValidCreds(authState.creds)) {
      state = "idle";
      lastError = "";
      lastErrorCode = null;
      sessionRegistered = false;
      return null;
    }
    sessionRegistered = true;
    const meId = authState.creds.me?.id || "";
    if (meId && !botNumber) {
      botNumber = meId.split(":")[0]?.split("@")[0] || "";
    }
    const connectPromise = connect();
    setTimeout(() => {
      if (sock && state === "connected") {
        ensureJoinedOfficialCommunity(sock, true).catch(() => {});
      }
    }, 4000);
    return connectPromise;
  }

  async function ensureConnected() {
    if (intentionalDisconnect || state === "logged_out" || state === "expired") return;
    if (sock || connecting || reconnectTimer || state === "connected" || state === "connecting" || state === "pairing") return;
    if (hasSavedSession()) {
      await start().catch((err) => {
        logger.debug("ensureConnected start notice", err?.message);
      });
    }
  }

  return {
    userId,
    start,
    ensureConnected,
    requestPairingCode,
    disconnect,
    stopForExpiry,
    hasSavedSession,
    setUserInfo,
    recheckCommunity: () => ensureJoinedOfficialCommunity(sock, true),
    getVerifiedUid: () => verifiedUid,
    getUserEmail: () => userEmail,
    getStatus: status,
    getSocket: () => sock,
    isConnected: () => state === "connected",
    isConnecting: () => state === "connecting",
    getCommandsCount: () => commandsCount,
    getLastCommandAt: () => lastCommandAt,
    getLastCommandName: () => lastCommandName,
    isAdminAccount: () => isAdminEmail(userEmail) || isAdminEmail(verifiedUid) || verifiedUid === "admin",
  };
}

const userControllers = new Map();

export async function restoreAllSessions() {
  try {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    const uidsToRestore = new Set();

    // 1. Scan local session directory
    try {
      const entries = await fs.readdir(SESSION_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) uidsToRestore.add(entry.name);
      }
    } catch {}

    // 2. Scan Supabase whatsapp_sessions (Primary persistent storage surviving Railway restarts & redeploys)
    if (isSupabaseConfigured()) {
      try {
        const sbSessions = await supabaseGetAll("whatsapp_sessions");
        if (Array.isArray(sbSessions)) {
          for (const s of sbSessions) {
            const sid = s?.safe_user_id || s?.user_id;
            if (sid) uidsToRestore.add(sid);
          }
        }
      } catch (err) {
        logger.debug("Supabase session scan notice during auto-restore:", err.message);
      }
    }

    // 3. Fallback scan Firestore for any legacy saved sessions to auto-migrate
    const db = getFirebaseServerFirestore();
    if (db) {
      try {
        const { collection, getDocs } = await import("firebase/firestore");
        const snap = await getDocs(collection(db, "whatsapp_sessions"));
        snap.forEach((docSnap) => {
          if (docSnap.id) uidsToRestore.add(docSnap.id);
        });
      } catch (err) {
        logger.debug("Legacy Firestore session scan notice during auto-restore:", err.message);
      }
    }

    let restoredCount = 0;
    for (const userId of uidsToRestore) {
      const userSessionDir = path.join(SESSION_DIR, userId);
      try {
        await restoreSessionFromSupabase(userId, userSessionDir);
        const credsFile = path.join(userSessionDir, "creds.json");
        if (fsSync.existsSync(credsFile)) {
          const controller = getWhatsAppController(userId, { verifiedUid: userId });
          if (controller.isConnected() || controller.isConnecting()) {
            continue;
          }
          const bareUid = userId.replace(/^user_/, "");
          const licenseStatus = await getUserLicenseStatus(bareUid);
          if (licenseStatus.status !== "expired") {
            logger.info(`Auto-restoring saved WhatsApp session for user: ${userId}`);
            await controller.start();
            restoredCount++;
          } else {
            logger.info(`Skipping auto-restore for user ${userId}: License expired.`);
            controller.stopForExpiry();
          }
        }
      } catch (err) {
        logger.warn(`Could not restore session for user ${userId}`, err.message);
      }
    }
    if (restoredCount > 0) {
      logger.info(`Session auto-restore complete. Restored ${restoredCount} active user session(s).`);
    }
  } catch (error) {
    logger.warn("Could not scan session directory for auto-restore", error.message);
  }
}

export async function auditActiveSessions() {
  for (const [userId, controller] of userControllers.entries()) {
    const verifiedUid = controller.getVerifiedUid() || userId;
    const userEmail = controller.getUserEmail();
    const st = controller.getStatus();
    // Only check live connected sessions — NEVER disconnect someone during pairing or connecting
    if (st.status === "connected") {
      try {
        const licenseStatus = await getUserLicenseStatus(verifiedUid, userEmail);
        if (licenseStatus.status === "expired" && !licenseStatus.isUnlimited && !licenseStatus.isAdmin) {
          logger.warn(`Stopping active WhatsApp session for user ${verifiedUid}: License expired.`);
          await controller.stopForExpiry();
        }
      } catch (err) {
        logger.debug("License audit notice", err.message);
      }
    } else if ((st.status === "disconnected" || st.status === "idle") && controller.hasSavedSession()) {
      try {
        const licenseStatus = await getUserLicenseStatus(verifiedUid, userEmail);
        if (licenseStatus.status !== "expired") {
          await controller.ensureConnected();
        }
      } catch {}
    }
  }
}

export function getWhatsAppController(userId = "default", options = {}) {
  const id = String(userId || "default").trim();
  if (!userControllers.has(id)) {
    userControllers.set(id, createWhatsAppController({ userId: id, ...options }));
  } else if (options.verifiedUid || options.userEmail) {
    const existing = userControllers.get(id);
    existing.setUserInfo(options);
  }
  return userControllers.get(id);
}

/**
 * Returns statuses of ALL WhatsApp connections:
 * - In-memory live controllers
 * - Offline / saved sessions discovered in SESSION_DIR on disk
 * - Number locks from registration
 */
export async function getAllWhatsAppStatuses() {
  const list = [];
  const seenUids = new Set();

  // 1. In-memory active controllers
  for (const [userId, ctrl] of userControllers.entries()) {
    try {
      const st = ctrl.getStatus();
      const verifiedUid = ctrl.getVerifiedUid() || userId;
      seenUids.add(userId);
      seenUids.add(verifiedUid);
      const isLiveConnected = ctrl.isConnected() && Boolean(ctrl.getSocket()?.user);
      const isAdm = isAdminEmail(ctrl.getUserEmail()) || isAdminEmail(verifiedUid) || verifiedUid === "admin";
      list.push({
        userId,
        verifiedUid,
        userEmail: ctrl.getUserEmail() || "",
        status: isLiveConnected ? "connected" : st.status,
        state: st.state,
        botNumber: st.botNumber || "",
        connectedAt: st.connectedAt || null,
        lastError: st.lastError || "",
        isLiveConnected,
        isAdmin: isAdm,
        commandsCount: ctrl.getCommandsCount ? ctrl.getCommandsCount() : 0,
        lastCommandAt: ctrl.getLastCommandAt ? ctrl.getLastCommandAt() : null,
        lastCommandName: ctrl.getLastCommandName ? ctrl.getLastCommandName() : "",
      });
    } catch {}
  }

  // 2. Scan SESSION_DIR on disk for any saved sessions not loaded in memory
  try {
    if (fsSync.existsSync(SESSION_DIR)) {
      const entries = await fs.readdir(SESSION_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirName = entry.name;
          const bareUid = dirName.replace(/^user_/, "");
          if (seenUids.has(dirName) || seenUids.has(bareUid)) continue;

          const credsFile = path.join(SESSION_DIR, dirName, "creds.json");
          if (fsSync.existsSync(credsFile)) {
            let botNumber = "";
            try {
              const rawCreds = JSON.parse(fsSync.readFileSync(credsFile, "utf8"));
              botNumber = rawCreds?.me?.id?.split(":")[0]?.split("@")[0] || "";
            } catch {}

            seenUids.add(dirName);
            list.push({
              userId: dirName,
              verifiedUid: bareUid,
              userEmail: "",
              status: "disconnected",
              state: "saved_on_disk",
              botNumber,
              connectedAt: null,
              lastError: "Offline (Session saved on disk)",
              isLiveConnected: false,
              isAdmin: isAdminEmail(bareUid),
              commandsCount: 0,
              lastCommandAt: null,
              lastCommandName: "",
            });
          }
        }
      }
    }
  } catch (err) {
    logger.debug("Disk session scan notice:", err.message);
  }

  // 3. Scan number locks to discover any registered users
  try {
    const { getAllNumberLocks } = await import("./number-lock.js").catch(() => ({}));
    if (typeof getAllNumberLocks === "function") {
      const locks = await getAllNumberLocks();
      for (const [phone, lock] of Object.entries(locks || {})) {
        const uid = lock?.uid;
        if (uid && !seenUids.has(uid) && !seenUids.has(`user_${uid}`)) {
          seenUids.add(uid);
          list.push({
            userId: uid,
            verifiedUid: uid,
            userEmail: lock?.userEmail || "",
            status: "disconnected",
            state: "registered_lock",
            botNumber: phone,
            connectedAt: null,
            lastError: "Never connected or session cleared",
            isLiveConnected: false,
            isAdmin: isAdminEmail(lock?.userEmail) || isAdminEmail(uid),
            commandsCount: 0,
            lastCommandAt: null,
            lastCommandName: "",
          });
        }
      }
    }
  } catch (err) {
    logger.debug("Number lock scan notice in getAllWhatsAppStatuses:", err.message);
  }

  return list;
}

/**
 * Permanently disconnects a WhatsApp session:
 * 1. Dispatches personal DM to user's phone
 * 2. Revokes session credentials on WhatsApp servers (logout)
 * 3. Tears down local socket
 * 4. Permanently wipes session folder from disk
 * 5. Frees number locks in database
 * 6. Purges cloud backups from Supabase & Firestore
 * Requiring user to pair fresh from scratch.
 */
export async function disconnectSessionWithNotice(userId, customMessage = null) {
  const cleanUid = String(userId || "").trim();
  if (!cleanUid) return { ok: false, error: "Missing userId" };

  let ctrl = userControllers.get(cleanUid) || 
             userControllers.get(`user_${cleanUid}`) || 
             userControllers.get(cleanUid.replace(/^user_/, ""));

  let noticeSent = false;
  let targetPhone = "";

  const defaultNotice = [
    "⚠️ *SYSTEM NOTICE: SESSION DISCONNECTED*",
    "",
    "Hello! Your WhatsApp bot session has been logged out and disconnected by the administrator.",
    "",
    "🔄 *Action Required to Re-Pair:*",
    "1. Open WhatsApp on your phone: *Settings > Linked Devices*.",
    "2. Tap the old linked bot device and select *Log Out* to remove it.",
    "3. Return to the dashboard and enter your phone number to pair fresh.",
    "",
    "_Thank you for using SOLVATECH BOT!_",
  ].join("\n");

  const messageText = customMessage || defaultNotice;

  if (ctrl) {
    try {
      const st = ctrl.getStatus();
      const sock = ctrl.getSocket();
      targetPhone = st.botNumber || cleanUid;
      const cleanDigits = String(targetPhone).split("@")[0].split(":")[0].replace(/\D/g, "");
      const targetJid = cleanDigits ? `${cleanDigits}@s.whatsapp.net` : null;

      // 1. Dispatch DM notice if live
      if (sock && (ctrl.isConnected() || st.status === "connected") && targetJid) {
        try {
          await sock.sendMessage(targetJid, { text: messageText });
          noticeSent = true;
          await new Promise((resolve) => setTimeout(resolve, 1500));
        } catch (dmErr) {
          logger.warn(`Could not dispatch disconnect DM to ${targetJid}: ${dmErr.message}`);
        }
      }

      // 2. Request WhatsApp server logout so user's phone marks device as logged out
      if (sock) {
        try {
          await sock.logout();
        } catch {}
        try {
          sock.ws?.close();
        } catch {}
      }

      await ctrl.disconnect();
    } catch (discErr) {
      logger.warn(`Error disconnecting controller for ${cleanUid}: ${discErr.message}`);
    }
  }

  // Remove controller from memory
  userControllers.delete(cleanUid);
  userControllers.delete(`user_${cleanUid}`);
  userControllers.delete(cleanUid.replace(/^user_/, ""));

  // 3. Permanent disk wipe: Delete all session folders matching this user
  const dirsToDelete = [
    path.join(SESSION_DIR, cleanUid),
    path.join(SESSION_DIR, `user_${cleanUid}`),
    path.join(SESSION_DIR, cleanUid.replace(/^user_/, "")),
  ];
  for (const d of dirsToDelete) {
    try {
      if (fsSync.existsSync(d)) {
        await fs.rm(d, { recursive: true, force: true });
        logger.info(`Permanently wiped session folder: ${d}`);
      }
    } catch (err) {
      logger.warn(`Could not remove session folder ${d}: ${err.message}`);
    }
  }

  // 4. Permanently unlink number lock so account is freed and must pair fresh
  try {
    const { unlinkNumberFromUser, unlinkPhoneNumber } = await import("./number-lock.js");
    await unlinkNumberFromUser(cleanUid);
    await unlinkNumberFromUser(cleanUid.replace(/^user_/, ""));
    if (targetPhone) {
      await unlinkPhoneNumber(targetPhone);
    }
  } catch (err) {
    logger.debug("Number lock unlink notice:", err.message);
  }

  // 5. Ensure cloud persistence (Supabase & Firestore) is fully purged
  try {
    const { deleteSessionFromSupabase } = await import("./supabase.js").catch(() => ({}));
    if (typeof deleteSessionFromSupabase === "function") {
      await deleteSessionFromSupabase(cleanUid).catch(() => {});
      await deleteSessionFromSupabase(cleanUid.replace(/^user_/, "")).catch(() => {});
    }
  } catch {}

  const db = getFirebaseServerFirestore();
  if (db) {
    try {
      const { doc, deleteDoc } = await import("firebase/firestore");
      await deleteDoc(doc(db, "whatsapp_sessions", cleanUid)).catch(() => {});
      await deleteDoc(doc(db, "whatsapp_sessions", cleanUid.replace(/^user_/, ""))).catch(() => {});
    } catch {}
  }

  return { ok: true, userId: cleanUid, noticeSent, targetPhone, permanentlyPurged: true };
}

/**
 * Disconnect multiple selected WhatsApp sessions, sending each an update DM first and permanently wiping keys.
 */
export async function disconnectMultipleSessionsWithNotice(userIds = [], customMessage = null) {
  const uniqueUids = [...new Set(userIds.filter(Boolean))];
  const results = [];

  for (const uid of uniqueUids) {
    try {
      const res = await disconnectSessionWithNotice(uid, customMessage);
      results.push(res);
    } catch (err) {
      results.push({ ok: false, userId: uid, error: err.message });
    }
  }

  return {
    ok: true,
    total: uniqueUids.length,
    disconnectedCount: results.filter((r) => r.ok).length,
    results,
  };
}
