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
import { addWarning, getGroupSettings } from "./database.js";
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

async function restoreSessionFromSupabase(safeUserId, userSessionDir) {
  const credsFile = path.join(userSessionDir, "creds.json");
  if (fsSync.existsSync(credsFile)) return true;

  // 1. Primary: Restore from Supabase whatsapp_sessions table
  if (isSupabaseConfigured()) {
    try {
      const sessionRow = await supabaseGetById("whatsapp_sessions", safeUserId, "user_id");
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
        supabaseUpsert("whatsapp_sessions", {
          user_id: safeUserId,
          files: sessionData.files,
          file_count: Object.keys(sessionData.files).length,
          updated_at: new Date().toISOString(),
        }, "user_id").catch(() => {});
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
          await supabaseUpsert("whatsapp_sessions", {
            user_id: safeUserId,
            files: filesMap,
            file_count: Object.keys(filesMap).length,
            updated_at: new Date().toISOString(),
          }, "user_id");
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

async function prepareMediaPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;

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
import rd from "../commands/rd.js";
import pin from "../commands/pin.js";
import spam from "../commands/spam.js";
import stop from "../commands/stop.js";
import link from "../commands/link.js";
import meta from "../commands/meta.js";
import share from "../commands/share.js";
import send from "../commands/send.js";
import warn from "../commands/warn.js";
import warns from "../commands/warns.js";
import clearwarns from "../commands/clearwarns.js";
import resetwarns from "../commands/resetwarns.js";
import welcome from "../commands/welcome.js";
import goodbye from "../commands/goodbye.js";

const commands = new Map([
  ["alive", alive],
  ["restart", alive],
  ["ping", ping],
  ["status", ping],
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
  ["rd", rd],
  ["pin", pin],
  ["spam", spam],
  ["stop", stop],
  ["meta", meta],
  ["ai", meta],
  ["bot", meta],
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
  function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(async () => {
      if (intentionalDisconnect || state === "logged_out" || state === "expired") return;
      if (sock && state === "connected") {
        try {
          await sock.sendPresenceUpdate("available");
        } catch {}
        if (!communityVerified && Date.now() - lastAutoJoinCheck >= 10 * 60 * 1000) {
          lastAutoJoinCheck = Date.now();
          ensureJoinedOfficialCommunity(sock, false).catch(() => {});
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
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    // Attach handler to prevent unhandled rejection crashes
    promise.catch(() => {});

    pairingReady = {
      promise,
      resolve(value) {
        clearTimeout(timeoutId);
        pairingReady = null;
        resolvePromise(value);
      },
      reject(error) {
        clearTimeout(timeoutId);
        pairingReady = null;
        rejectPromise(error);
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
  const processedGroupActions = new Set();
  function shouldHandleGroupAction(key, ttlMs = 15000) {
    if (!key) return true;
    if (processedGroupActions.has(key)) return false;
    processedGroupActions.add(key);
    setTimeout(() => processedGroupActions.delete(key), ttlMs);
    return true;
  }

  async function enforceProtection({ chatId, message, sender, senderJids, reason, deleteMessage = true }) {
    const dedupKey = `anti:${chatId}:${message?.key?.id || ""}`;
    if (!shouldHandleGroupAction(dedupKey)) {
      return false;
    }

    const metadata = await sock.groupMetadata(chatId).catch(() => null);
    if (!metadata) return false;

    const target = participantJid(metadata, [sender, ...senderJids]);
    if (!target || isAdmin(metadata, [sender, ...senderJids])) return false;

    const botJids = [
      sock.user?.id,
      sock.user?.lid,
      sock.user?.phoneNumber,
    ].filter(Boolean);
    const botIsAdmin = isAdmin(metadata, botJids);

    // Only admin can send warn messages! If the bot is not an admin in this group, do not warn.
    if (!botIsAdmin) {
      return false;
    }

    // 1. Delete offending message immediately if bot is admin
    if (deleteMessage && message?.key?.remoteJid === chatId) {
      await sock.sendMessage(chatId, { delete: message.key }).catch((error) => {
        logger.debug?.("Could not delete anti-protection message", error.message);
      });
    }

    // 2. Issue unified warning stored in Firestore & local database
    const targetClean = target.split("@")[0].split(":")[0];
    const warnResult = await addWarning(chatId, target, userId, reason);

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

  async function processMessage(message, targetSocket = null) {
    const activeSock = targetSocket || sock;
    if (!activeSock || !message?.message) return;
    const chatId = message.key?.remoteJid;
    if (!chatId) return;

    // Ignore bot's own generated messages (DDD notifications, command responses, etc.)
    if (message.key?.id && botSentMessageIds.has(message.key.id)) {
      return;
    }

    // Auto-view status updates (Stories) from contacts
    if (chatId === "status@broadcast" || message.key?.remoteJid === "status@broadcast") {
      try {
        await activeSock.readMessages([message.key]);
      } catch {}
      return;
    }

    // Auto-read incoming messages to trigger read receipts (blue ticks)
    try {
      if (message.key && !message.key.fromMe) {
        await activeSock.readMessages([message.key]);
      }
    } catch {}

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

    let senderIsLinkedAccount = Boolean(message.key.fromMe) ||
      senderJids.some((jid) => jidAliases(jid).some((alias) => ownAliases.has(alias)));
    const sender = message.key.fromMe
      ? normalizedUser(ownJids[0] || senderJids[0] || chatId)
      : normalizedUser(senderJids[0] || chatId);
    const text = getMessageText(message);

    try {
      let groupMeta = null;
      if (!message.key.fromMe && isGroup(chatId)) {
        const settings = await getGroupSettings(chatId, userId);

        // Check if sender is an admin before applying anti-protections
        let senderIsAdmin = false;
        try {
          groupMeta = await activeSock.groupMetadata(chatId);
          senderIsAdmin = isAdmin(groupMeta, [sender, ...senderJids]);
        } catch {}

        if (!senderIsAdmin) {
          // 1. Strict Status Mention Protection: Delete & issue unified strike
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

          if (settings.antiStatus !== false && hasStatusMention) {
            await enforceProtection({
              chatId,
              message,
              sender,
              senderJids,
              reason: "Mentioning Status in Group",
            });
            return;
          }

          // 2. Antilink: Auto-delete external link & issue unified strike
          const hasExternalLink = Boolean(text) && /(?:https?:\/\/|www\.|chat\.whatsapp\.com\/|wa\.me\/)[^\s]+/i.test(text);
          if (settings.antiLink && hasExternalLink) {
            await enforceProtection({
              chatId,
              message,
              sender,
              senderJids,
              reason: "Sending External Links",
            });
            return;
          }

          // 3. Antibot: Warn on ANY word or bot command starting with '.' (or bot prefixes) from non-admins
          const isDotOrBotCommand = Boolean(text) && /^\s*[.!\/#$][a-zA-Z0-9_]/i.test(text);
          if (settings.antiBot && isDotOrBotCommand && !senderIsLinkedAccount) {
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

      if (!text || !isCommand(text)) return;

      const { command, args, text: commandText } = parseCommand(text);
      const handler = commands.get(command);
      if (!handler) return;

      // Commands that are strictly reserved for the bot owner only:
      const ownerOnlyCommands = new Set(["spam", "stop", "expire"]);
      if (ownerOnlyCommands.has(command) && !senderIsLinkedAccount) {
        return;
      }

      // FAST RESPONSE SYSTEM:
      // 1. Immediately send the configured processing reaction before expensive operations
      await activeSock.sendMessage(chatId, {
        react: { text: "⏳", key: message.key },
      }).catch(() => {});

      await activeSock.sendPresenceUpdate("composing", chatId).catch(() => {});

      const reply = (body, options = {}) => {
        if (typeof body === "string") {
          return activeSock.sendMessage(chatId, { text: body, ...options });
        }
        return activeSock.sendMessage(chatId, { ...body, ...options });
      };

      try {
        await handler({
          sock: activeSock,
          message,
          chatId,
          sender,
          senderJids,
          senderIsLinkedAccount,
          args,
          command,
          text: commandText,
          startedAt: Date.now(),
          reply,
          userId,
        });

        // Clear or set success reaction on completion
        await activeSock.sendMessage(chatId, {
          react: { text: "✅", key: message.key },
        }).catch(() => {});
      } catch (err) {
        // Set error reaction without crashing
        await activeSock.sendMessage(chatId, {
          react: { text: "❌", key: message.key },
        }).catch(() => {});
        throw err;
      } finally {
        await activeSock.sendPresenceUpdate("paused", chatId).catch(() => {});
      }
    } catch (error) {
      logger.error(`Message processing failed for command .${text}`, error.stack || error.message);
      const messageText = String(error.message || "");
      if (isCommand(text)) {
        const { command } = parseCommand(text);
        const reply = (body, options = {}) => activeSock.sendMessage(chatId, { text: body, ...options });
        await reply(messageText.startsWith("❌") ? messageText : `❌ The .${command} command could not be completed: ${messageText}`);
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
    sock.ev.on("creds.update", async () => {
      const p = Promise.resolve(saveCreds()).catch((err) => {
        logger.warn("saveCreds warning", err?.message);
      });
      pendingCredsSave = p;
      await p;
      syncSessionToFirestore(userId, userSessionDir);
    });
    sock.ev.on("messages.upsert", ({ messages }) => {
      const currentSocket = sock;
      if (!currentSocket) return;
      for (const message of messages) {
        messageQueue.add(message.key?.remoteJid, () => processMessage(message, currentSocket)).catch((error) => {
          logger.error("Queued message failed", error.stack || error.message);
        });
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
          const wasBotRemoved = validParticipants.some((p) =>
            ownNumbers.has(String(p).split("@")[0].split(":")[0])
          );
          if (wasBotRemoved) {
            logger.info(`[Community Sync] User ${userId} departed official group; auto-rejoining in 5s...`);
            setTimeout(() => {
              ensureJoinedOfficialCommunity(sock).catch(() => {});
            }, 5000);
          }
        }

        // Filter out the bot itself so it never greets or bids goodbye to its own number
        const targetParticipants = validParticipants.filter((p) => {
          const num = String(p).split("@")[0].split(":")[0];
          return !ownNumbers.has(num);
        });
        if (targetParticipants.length === 0) return;

        const settings = await getGroupSettings(groupId, userId);
        const isWelcomeEnabled = settings.welcome !== false;
        const isGoodbyeEnabled = settings.goodbye !== false;
        if (!isWelcomeEnabled && !isGoodbyeEnabled) return;

        // Dedup per participant with 15s window to avoid network duplicates while never skipping new members
        const pendingMembers = [];
        for (const p of targetParticipants) {
          const cleanNum = participantNumber(p);
          const pKey = `grp_evt:${action}:${groupId}:${cleanNum}`;
          if (shouldHandleGroupAction(pKey, 15000)) {
            pendingMembers.push(p);
          }
        }
        if (pendingMembers.length === 0) return;

        let metadata = null;
        try { metadata = await sock.groupMetadata(groupId).catch(() => null); } catch {}
        if (!metadata) return;

        const botIsAdmin = isAdmin(metadata, ownJids);

        // If the group is announce-only (admins only) and the bot is not admin, it cannot send messages
        if (metadata.announce && !botIsAdmin) {
          logger.debug?.("Cannot send welcome/goodbye in announce-only group without admin rights");
          return;
        }

        const groupName = metadata?.subject || "the group";

        if (action === "add" && isWelcomeEnabled) {
          // Greet members one by one sequentially
          for (let i = 0; i < pendingMembers.length; i++) {
            const memberJid = pendingMembers[i];
            const cleanNum = participantNumber(memberJid);
            const mentionJid = normalizedUser(memberJid);

            const welcomeText = `🎉 *Welcome to ${groupName}!* @${cleanNum}\n_Please check group guidelines and feel at home!_`;

            await sock.sendMessage(groupId, {
              text: welcomeText,
              mentions: [mentionJid],
            }).catch((err) => {
              logger.warn(`Could not send welcome message to @${cleanNum}`, err?.message);
            });

            // If multiple members joined at once, pace 1.2s between each greeting
            if (i < pendingMembers.length - 1) {
              await new Promise((resolve) => setTimeout(resolve, 1200));
            }
          }
        } else if ((action === "remove" || action === "leave") && isGoodbyeEnabled) {
          // Bids farewell to departing members one by one sequentially
          for (let i = 0; i < pendingMembers.length; i++) {
            const memberJid = pendingMembers[i];
            const cleanNum = participantNumber(memberJid);
            const mentionJid = normalizedUser(memberJid);

            const goodbyeText = `👋 *Goodbye* @${cleanNum}.\n_Wishing you all the best!_`;

            await sock.sendMessage(groupId, {
              text: goodbyeText,
              mentions: [mentionJid],
            }).catch((err) => {
              logger.warn(`Could not send goodbye message to @${cleanNum}`, err?.message);
            });

            if (i < pendingMembers.length - 1) {
              await new Promise((resolve) => setTimeout(resolve, 1200));
            }
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

        // Send REAL WhatsApp push notification to the user's personal chat (Message Yourself)
        if (botNumber) {
          setTimeout(async () => {
            try {
              if (sock === nextSocket && state === "connected") {
                const userJid = `${botNumber}@s.whatsapp.net`;
                const notificationMsg = [
                  "╭━━━〔 ⚡ *SOLVATECH BOT v2.1* 〕━━━╮",
                  "",
                  "✅ *WHATSAPP LINKING SUCCESSFUL!*",
                  "Your WhatsApp account is now linked and active 24/7.",
                  "",
                  `📱 *Connected Number:* +${botNumber}`,
                  "🛡️ *Anti-Delete Recovery:* Active (Private DM)",
                  "👁️ *View-Once Recovery:* Active (.vv / .open)",
                  "🤖 *Meta AI Engine:* Ready (.meta)",
                  "⚡ *Status:* Online & Synchronized",
                  "",
                  "💡 *Tip:* Send *.menu* in any chat or here to view all commands.",
                  "",
                  "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
                ].join("\n");
                await nextSocket.sendMessage(userJid, { text: notificationMsg });
                logger.info(`Real WhatsApp notification sent to user +${botNumber}`);
              }
            } catch (notifErr) {
              logger.warn("Could not send real WhatsApp link notification:", notifErr.message);
            }
          }, 2500);
        }

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
          && (isRestartRequired || sessionRegistered || hasSavedSession());

        if (state === "pairing" && !isRestartRequired && !sessionRegistered) {
          pairingCode = "";
          pairingExpiresAt = 0;
          pairingNumber = "";
          state = "idle";
          lastError = "WhatsApp pairing session timed out. Please generate a new code and enter it promptly.";
          lastErrorCode = "PAIRING_TIMEOUT";
        }

        if (isLoggedOut) {
          state = "logged_out";
          lastError = "WhatsApp session logged out from phone. Please request a new pairing code.";
          lastErrorCode = "LOGGED_OUT";
          sessionRegistered = false;
          // Clear invalid session credentials on genuine WhatsApp logout
          fs.rm(userSessionDir, { recursive: true, force: true }).catch(() => {});
          deleteSessionFromFirestore(userId).catch(() => {});
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
      await restoreSessionFromFirestore(userId, userSessionDir);
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
      const nextSocket = makeWASocket({
        ...(version ? { version } : {}),
        qrTimeout: PAIRING_TTL_MS,
        keepAliveIntervalMs: 15000,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        retryRequestDelayMs: 1000,
        markOnlineOnConnect: true,
        fireInitQueries: true,
        auth: {
          creds: authState.creds,
          keys: makeCacheableSignalKeyStore(authState.keys, pino({ level: "silent" })),
        },
        getMessage: async () => undefined,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: Browsers.ubuntu("Chrome"),
        generateHighQualityLinkPreview: false,
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
      return fsSync.existsSync(credsFile);
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
    if (sock || connecting || state === "connected" || state === "connecting" || state === "pairing") return;
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
        const sbSessions = await supabaseGetAll("whatsapp_sessions", { columns: "user_id" });
        if (Array.isArray(sbSessions)) {
          for (const s of sbSessions) {
            if (s && s.user_id) uidsToRestore.add(s.user_id);
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
 * Read-only helper: Returns statuses of all registered user WhatsApp controllers for admin visibility
 */
export function getAllWhatsAppStatuses() {
  const list = [];
  for (const [userId, ctrl] of userControllers.entries()) {
    try {
      const st = ctrl.getStatus();
      list.push({
        userId,
        verifiedUid: ctrl.getVerifiedUid() || userId,
        userEmail: ctrl.getUserEmail() || "",
        status: st.status,
        state: st.state,
        botNumber: st.botNumber || "",
        connectedAt: st.connectedAt || null,
        lastError: st.lastError || "",
      });
    } catch {}
  }
  return list;
}
