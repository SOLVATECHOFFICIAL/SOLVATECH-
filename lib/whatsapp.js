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
import { PAIRING_TTL_MS, SESSION_DIR, LOG_FILE, DATA_DIR } from "./config.js";
import { createKeyedQueue } from "./queue.js";
import { getMessageContent, getMessageText, isCommand, isGroup, jidAliases, messageSenderJids, normalizeNumber, normalizedUser, parseCommand, participantNumber } from "./helpers.js";
import { isAdmin, participantJid } from "./permissions.js";
import { logger } from "./logger.js";
import {
  handleDeletedMessage,
  recordIncomingMessage,
  removeCachedMessage,
  getCachedIncomingMessage,
  getDeletedMessageCacheStats,
  clearAllDeletedMessageCaches,
} from "./deleted-messages.js";
import { checkNumberLock, lockNumberToUser } from "./number-lock.js";
import { getUserLicenseStatus } from "./license.js";
import { downloadMediaUrl } from "./media.js";
import { stopSpamTask, stopAllSpamTasks } from "./spam-manager.js";

import { getFirebaseServerFirestore, isAdminEmail } from "./auth.js";
import {
  firestoreUpsert,
  firestoreGetById,
  firestoreGetAll,
  firestoreDelete,
} from "./firestore-sync.js";
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

const COMMAND_REACTIONS = {
  ping: "🏓",
  menu: "📋",
  link: "🔗",
  tagall: "📢",
  admin: "👑",
  admins: "👑",
  tagadmin: "👑",
  sticker: "🎨",
  antisticker: "🎨",
  read: "📖",
  open: "👁️",
  vv: "👁️",
  viewonce: "👁️",
  rd: "📖",
  pin: "📌",
  kick: "👢",
  add: "➕",
  promote: "⬆️",
  demote: "⬇️",
  lock: "🔒",
  unlock: "🔓",
  antilink: "🔗",
  antibot: "🤖",
  anti: "🛡️",
  warn: "⚠️",
  warns: "⚠️",
  clearwarns: "✅",
  clearwarn: "✅",
  resetwarns: "🔄",
  spam: "⚡",
  stop: "🛑",
  alive: "🟢",
  groupinfo: "👥",
  uptime: "⏳",
  owner: "👑",
  profile: "👤",
  expire: "📅",
  status: "⏳",
  groupstatus: "⏳",
  gcstatus: "⏳",
  del: "🗑️",
  delete: "🗑️",
};

async function pruneOldSessionPreKeys(sessionDir) {
  try {
    if (!fsSync.existsSync(sessionDir)) return;
    const files = await fs.readdir(sessionDir);

    // 1. Instantly purge transient mapping, token & device files so they never build up into 70,000 files!
    const transientFiles = files.filter((f) =>
      f.startsWith("lid-mapping-") ||
      f.startsWith("device-list-") ||
      f.startsWith("tctoken-")
    );
    for (const f of transientFiles) {
      fs.unlink(path.join(sessionDir, f)).catch(() => {});
    }

    // 2. Bounded consumed one-time prekeys (keeps active session-* and sender-key-* 100% intact)
    const preKeyFiles = files.filter((f) => f.startsWith("pre-key-") && f.endsWith(".json"));
    if (preKeyFiles.length > 500) {
      const sorted = preKeyFiles.map((f) => {
        const fullPath = path.join(sessionDir, f);
        try {
          const stat = fsSync.statSync(fullPath);
          return { file: fullPath, mtime: stat.mtimeMs };
        } catch {
          return { file: fullPath, mtime: 0 };
        }
      }).sort((a, b) => b.mtime - a.mtime);

      const toDelete = sorted.slice(200);
      for (const item of toDelete) {
        fs.unlink(item.file).catch(() => {});
      }
    }
  } catch (err) {
    logger.debug("Prekey pruning note:", err.message);
  }
}

async function restoreSessionFromSupabase(safeUserId, userSessionDir) {
  const credsFile = path.join(userSessionDir, "creds.json");
  if (fsSync.existsSync(credsFile)) return true;

  // 1. Primary: Restore straight from Firebase Firestore whatsapp_sessions collection
  try {
    const fsDoc = await firestoreGetById("whatsapp_sessions", safeUserId);
    if (fsDoc && fsDoc.files && fsDoc.files["creds.json"] && typeof fsDoc.files["creds.json"] === "string") {
      await fs.mkdir(userSessionDir, { recursive: true });
      await fs.writeFile(credsFile, fsDoc.files["creds.json"], "utf8");
      if (fsSync.existsSync(credsFile)) {
        logger.info(`[Direct Firebase] Restored WhatsApp session creds directly from Firebase Firestore for user ${safeUserId}`);
        return true;
      }
    }
  } catch (fsErr) {
    logger.debug(`Firebase session restore check notice for ${safeUserId}:`, fsErr.message);
  }

  // 2. Secondary: Restore from Supabase whatsapp_sessions table
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

  // 3. Fallback: Restore from server Firestore instance if present
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
      logger.info(`Restored WhatsApp session files from Firestore SDK for user ${safeUserId}`);
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
      const credsFile = path.join(userSessionDir, "creds.json");
      if (!fsSync.existsSync(credsFile)) return;

      const credsContent = await fs.readFile(credsFile, "utf8");
      if (!credsContent) return;

      const credsSizeBytes = Buffer.byteLength(credsContent, "utf8");

      // Ultra-lightweight payload: ONLY creds.json (2KB) is needed for persistent auth
      const filesMap = {
        "creds.json": credsContent,
      };

      // 1. Save directly straight to Firebase Firestore (Primary Source of Truth)
      try {
        await firestoreUpsert("whatsapp_sessions", safeUserId, {
          safeUserId,
          userId: safeUserId,
          files: filesMap,
          fileCount: 1,
          credsSizeBytes,
          updatedAt: new Date().toISOString(),
        });
        logger.debug(`[Direct Firebase] Synced session creds straight to Firebase Firestore for user ${safeUserId}`);
      } catch (fbErr) {
        logger.debug(`Firebase session creds sync notice for ${safeUserId}:`, fbErr.message);
      }

      // Also ensure Firestore SDK instance writes if available
      const db = getFirebaseServerFirestore();
      if (db) {
        try {
          const { doc, setDoc } = await import("firebase/firestore");
          await setDoc(doc(db, "whatsapp_sessions", safeUserId), {
            updatedAt: new Date().toISOString(),
            fileCount: 1,
            credsSizeBytes,
            files: filesMap,
          }, { merge: true });
        } catch {}
      }

      // 2. Also keep Supabase copy synchronized if configured
      if (isSupabaseConfigured()) {
        const payload = {
          safe_user_id: safeUserId,
          user_id: safeUserId,
          files: filesMap,
          file_count: 1,
          updated_at: new Date().toISOString(),
        };
        const upRes = await supabaseUpsert("whatsapp_sessions", payload, "safe_user_id");
        if (!upRes.success) {
          await supabaseUpsert("whatsapp_sessions", payload, "user_id").catch(() => {});
        }
      }
    } catch (err) {
      logger.debug(`Session creds sync notice for ${safeUserId}:`, err.message);
    }
  }, 2500);

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
import ai from "../commands/ai.js";

const commands = new Map([
  ["alive", alive],
  ["restart", alive],
  ["ping", ping],
  ["ai", ai],
  ["ask", ai],
  ["gpt", ai],
  ["gcstatus", status],
  ["gc", status],
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
  ["halt", stop],
  ["cancel", stop],
  ["abort", stop],
  ["kill", stop],
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

function formatPairingCode(code) {
  const clean = cleanCode(code);
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
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
  let linkedOwnerPhone = "";
  let linkedOwnerJid = "";
  let linkedOwnerLid = "";
  const linkedOwnerNumbers = new Set();
  const linkedOwnerAliases = new Set();

  function registerOwnerIdentity(phoneOrJid) {
    if (!phoneOrJid) return;
    const str = String(phoneOrJid).trim();
    if (!str || str === "undefined" || str === "null") return;
    const digits = str.split("@")[0].split(":")[0].replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) {
      linkedOwnerNumbers.add(digits);
      linkedOwnerAliases.add(`${digits}@s.whatsapp.net`);
      if (!linkedOwnerPhone) linkedOwnerPhone = digits;
      if (!botNumber) botNumber = digits;
    }
    if (str.includes("@")) {
      linkedOwnerAliases.add(str);
      const cleanJid = str.split(":")[0] + "@" + str.split("@")[1];
      linkedOwnerAliases.add(cleanJid);
      if (str.includes("@lid")) {
        linkedOwnerLid = str;
      } else {
        linkedOwnerJid = cleanJid;
      }
    }
  }

  // Pre-seed owner identity from options if provided
  if (options.pairingNumber) registerOwnerIdentity(options.pairingNumber);
  if (options.lockedPhone) registerOwnerIdentity(options.lockedPhone);
  if (options.verifiedUid) registerOwnerIdentity(options.verifiedUid);

  // Read saved session credentials from disk immediately on initialization
  try {
    const credsPath = path.join(userSessionDir, "creds.json");
    if (fsSync.existsSync(credsPath)) {
      const raw = fsSync.readFileSync(credsPath, "utf8");
      const creds = JSON.parse(raw);
      if (creds?.me?.id) registerOwnerIdentity(creds.me.id);
      if (creds?.me?.lid) registerOwnerIdentity(creds.me.lid);
      if (creds?.me?.phoneNumber) registerOwnerIdentity(creds.me.phoneNumber);
    }
  } catch {}

  function isSenderLinkedOwner(message, chatId) {
    if (Boolean(message.key?.fromMe)) {
      return true;
    }

    const isGroupChat = isGroup(chatId);
    const candidates = isGroupChat
      ? [message?.key?.participant, message?.key?.senderPn, message?.participant].filter(Boolean)
      : [message?.key?.remoteJid, message?.key?.participant, chatId].filter(Boolean);

    for (const cand of candidates) {
      const candStr = String(cand).trim();
      if (!candStr || candStr === "undefined" || candStr === "null") continue;

      const cleanJid = candStr.split(":")[0] + (candStr.includes("@") ? "@" + candStr.split("@")[1] : "");
      if (linkedOwnerAliases.has(cleanJid) || linkedOwnerAliases.has(candStr)) {
        return true;
      }

      const digits = candStr.split("@")[0].split(":")[0].replace(/\D/g, "");
      if (digits.length >= 7 && digits.length <= 15 && linkedOwnerNumbers.has(digits)) {
        return true;
      }
    }

    return false;
  }

  let connecting = null;
  let pairingRequest = null;
  let pairingReady = null;
  let sessionRegistered = false;
  let pendingCredsSave = Promise.resolve();
  const messageQueue = createKeyedQueue();
  const pendingParticipantBatches = new Map();

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
        // Mark verified on non-retryable errors like bad-request so we don't spam WhatsApp servers
        if (grpErr?.message?.includes("bad-request") || grpErr?.message?.includes("not-authorized")) {
          communityVerified = true;
        }
      }
    } finally {
      isCheckingCommunity = false;
    }
  }

  // 24/7/365 Persistent Heartbeat: Keeps WhatsApp bot socket live forever without sleeping
  // Prevents NAT timeouts, mobile network drops, and idle socket closures.
  // Sends presence "available" and direct WebSocket ping every 20 seconds.
  let heartbeatTimer = null;
  let lastPreKeyPrune = 0;
  function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(async () => {
      if (intentionalDisconnect || state === "expired") return;

      const isLive = Boolean(
        sock &&
        sock.ws &&
        (sock.ws.isOpen || sock.ws.socket?.readyState === 1) &&
        state === "connected"
      );

      if (isLive) {
        try {
          await sock.sendPresenceUpdate("available").catch(() => {});
          if (typeof sock.ws?.socket?.ping === "function") {
            sock.ws.socket.ping();
          } else if (typeof sock.ws?.ping === "function") {
            sock.ws.ping();
          }
        } catch (pingErr) {
          logger.debug("[20s Heartbeat] Presence ping note:", pingErr.message);
        }
        if (!communityVerified && Date.now() - lastAutoJoinCheck >= 10 * 60 * 1000) {
          lastAutoJoinCheck = Date.now();
          ensureJoinedOfficialCommunity(sock, false).catch(() => {});
        }
        if (Date.now() - lastPreKeyPrune >= 3 * 60 * 1000) {
          lastPreKeyPrune = Date.now();
          pruneOldSessionPreKeys(userSessionDir).catch(() => {});
        }
      } else if (hasSavedSession() && state !== "pairing" && state !== "connecting") {
        if (state === "connected") {
          logger.warn(`[20s Heartbeat] WhatsApp socket closed/dropped for user ${userId}. Re-establishing connection...`);
        } else {
          logger.info(`[20s Heartbeat] Ensuring paired WhatsApp session stays active for ${userId} (current state: ${state})`);
        }
        ensureConnected().catch((err) => {
          logger.debug("[20s Heartbeat] ensureConnected note:", err?.message);
        });
      }
    }, 20000); // 20 seconds interval - prevents ANY mobile/NAT/Cloud timeout
  }
  startHeartbeat();

  function hasValidCreds(creds) {
    return Boolean(creds && creds.registered === true && (creds.me?.id || creds.account));
  }

  function setUserInfo(info = {}) {
    if (info.verifiedUid) verifiedUid = info.verifiedUid;
    if (info.userEmail) userEmail = info.userEmail;
  }

  function beginPairingReadyWait(timeoutMs = 35000) {
    if (pairingReady) return pairingReady.promise;

    let timeoutId;
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
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
        rejectPromise?.(error);
      },
    };
    timeoutId = setTimeout(() => {
      if (pairingReady) {
        pairingReady.reject(new Error("Timed out waiting for WhatsApp gateway to prepare pairing socket. Please check network connection and try again."));
      }
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
      pairingCode: pairingCode ? formatPairingCode(pairingCode) : "",
      rawPairingCode: pairingCode ? cleanCode(pairingCode) : "",
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
          timerId = setTimeout(() => resolve(null), 2500);
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

  async function enforceProtection({ chatId, message, sender, senderJids, reason, deleteMessage = true, groupMeta = null }) {
    const metadata = groupMeta || await getSafeGroupMetadata(sock, chatId, 15000);
    if (!metadata) return false;

    const target = participantJid(metadata, [sender, ...senderJids]);
    if (!target || isAdmin(metadata, [sender, ...senderJids])) return false;

    const botJids = [
      sock.user?.id,
      sock.user?.lid,
      sock.user?.phoneNumber,
      linkedOwnerPhone ? `${linkedOwnerPhone}@s.whatsapp.net` : "",
      linkedOwnerJid,
      linkedOwnerLid,
      botNumber ? `${botNumber}@s.whatsapp.net` : "",
      pairingNumber ? `${pairingNumber}@s.whatsapp.net` : "",
    ].filter(Boolean);
    const botIsAdmin = isAdmin(metadata, botJids);
    // If bot is not admin in this group, silently return. Never post notices or messages as a regular member!
    if (!botIsAdmin) {
      return false;
    }

    const dedupKey = `anti:${chatId}:${message?.key?.id || ""}`;
    if (!shouldHandleGroupAction(dedupKey)) {
      return false;
    }

    // 1. Delete offending message immediately in 0ms if bot is admin
    if (deleteMessage && message?.key?.remoteJid === chatId) {
      if (message?.key?.id) {
        removeCachedMessage(userId, message.key.id);
      }
      const deleteKey = {
        remoteJid: chatId,
        id: message.key.id,
        participant: message.key.participant || message.participant || sender,
        fromMe: Boolean(message.key.fromMe),
      };
      await (sock || activeSock).sendMessage(chatId, { delete: deleteKey }).catch((error) => {
        logger.debug?.("Could not delete anti-protection message", error.message);
      });
    }

    // 2. Issue unified warning stored in Firestore & local database
    const targetClean = target.split("@")[0].split(":")[0];
    const warnResult = await addWarning(chatId, target, userId, reason, [sender, ...senderJids]);

    // Identify the ONE admin linked to the bot
    const groupAdmins = (metadata?.participants || []).filter((p) => p.admin);
    const linkedAdmin = groupAdmins.find((p) =>
      botJids.some((bj) => bj && p.id && bj.split("@")[0].split(":")[0] === p.id.split("@")[0].split(":")[0])
    ) || groupAdmins[0] || { id: target };
    const adminClean = linkedAdmin?.id ? participantNumber(linkedAdmin.id) : (botNumber || linkedOwnerPhone || "Admin");
    const adminTag = `@${adminClean}`;
    const adminMentions = linkedAdmin?.id ? [normalizedUser(linkedAdmin.id)] : [];
    const allMentions = [...new Set([target, ...adminMentions].filter(Boolean))];

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

    // Discard ancient backlog messages older than 10 minutes (with clock drift tolerance)
    const rawTs = Number(message.messageTimestamp);
    const msgTimestampMs = rawTs ? (rawTs > 1e11 ? rawTs : rawTs * 1000) : (receivedAt || Date.now());
    if (!message.key?.fromMe && Math.abs(Date.now() - msgTimestampMs) > 10 * 60 * 1000) {
      return;
    }

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

    const text = getMessageText(message);
    const isCmd = Boolean(text && isCommand(text));

    // ULTRA-FAST ZERO-LATENCY COMMAND DISPATCH PATH:
    if (isCmd) {
      const senderIsOwner = isSenderLinkedOwner(message, chatId);
      // STRICT PRIVATE MODE (OWNER ONLY):
      // The bot only answers commands from its own linked WhatsApp account owner.
      if (!senderIsOwner) {
        return;
      }
      const { command, args, text: commandText } = parseCommand(text);
      const handler = commands.get(command);
      if (!handler) return;

      const isStealthCommand =
        command === "open" ||
        command === "vv" ||
        command === "viewonce" ||
        command === "status" ||
        command === "groupstatus" ||
        command === "gcstatus" ||
        command === "del" ||
        command === "delete";

      const getLiveSocket = () => sock || activeSock;

      const reply = async (body, options = {}) => {
        const live = getLiveSocket();
        if (!live) return null;
        try {
          if (typeof body === "string") {
            const res = await live.sendMessage(chatId, { text: body, ...options });
            if (res?.key?.id) markBotSent(res.key.id);
            return res;
          } else {
            const res = await live.sendMessage(chatId, { ...body, ...options });
            if (res?.key?.id) markBotSent(res.key.id);
            return res;
          }
        } catch (err) {
          if (err?.message?.includes("Connection Closed") || err?.message?.includes("connection closed")) {
            await new Promise((r) => setTimeout(r, 600));
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

        // Instant reaction (except .gcstatus / .gc which handles deliberate timer)
        if (message?.key && command !== "gcstatus" && command !== "gc") {
          const reactionEmoji = COMMAND_REACTIONS[command] || "⚡";
          getLiveSocket()?.sendMessage(chatId, { react: { text: reactionEmoji, key: message.key } }).catch(() => {});
        }

        const senderJids = messageSenderJids(message, chatId);
        const ownJid = activeSock?.user?.id || (botNumber ? `${botNumber}@s.whatsapp.net` : chatId);
        const sender = normalizedUser(message.key?.fromMe ? ownJid : (senderJids[0] || chatId));

        await handler({
          sock: getLiveSocket(),
          message,
          chatId,
          sender,
          senderJids,
          senderIsLinkedAccount: senderIsOwner,
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
    if (activeSock?.user?.id) registerOwnerIdentity(activeSock.user.id);
    if (activeSock?.user?.lid) registerOwnerIdentity(activeSock.user.lid);
    if (activeSock?.user?.phoneNumber) registerOwnerIdentity(activeSock.user.phoneNumber);
    if (credsMe?.id) registerOwnerIdentity(credsMe.id);
    if (credsMe?.lid) registerOwnerIdentity(credsMe.lid);

    const ownJids = [
      activeSock?.user?.id,
      activeSock?.user?.lid,
      activeSock?.user?.phoneNumber,
      credsMe?.id,
      credsMe?.lid,
      linkedOwnerPhone ? `${linkedOwnerPhone}@s.whatsapp.net` : "",
      linkedOwnerJid,
      linkedOwnerLid,
      botNumber ? `${botNumber}@s.whatsapp.net` : "",
      pairingNumber ? `${pairingNumber}@s.whatsapp.net` : "",
    ].filter(Boolean);

    // STRICT OWNER RESOLUTION:
    // A command is ONLY accepted if sent by the linked WhatsApp account owner.
    const senderIsLinkedAccount = isSenderLinkedOwner(message, chatId);
    const sender = message.key?.fromMe
      ? normalizedUser(ownJids[0] || senderJids[0] || chatId)
      : normalizedUser(senderJids[0] || chatId);
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
        const hasExternalLink = Boolean(text) && /(?:https?:\/\/|www\.|chat\.whatsapp\.com\/|wa\.me\/|t\.me\/|[a-zA-Z0-9-]+\.(?:com|org|net|io|me|ng|xyz|app|top|site|info|online|shop|link|live|club|store|ru|cn|in|us|uk|co|cc|to|gg|ly)\b)/i.test(text);

        // 3. Antibot Detection
        const isDotOrBotCommand = (Boolean(text) && /^\s*[.!\/#$,~?][a-zA-Z0-9_]/i.test(text)) ||
          Boolean(msgContent?.botInvokeMessage || msgContent?.interactiveResponseMessage);

        // 4. Antisticker Detection
        const hasSticker = Boolean(msgContent?.stickerMessage);

        const needsProtectionCheck =
          (Boolean(settings.antiStatus) && hasStatusMention) ||
          (Boolean(settings.antiLink) && hasExternalLink) ||
          (Boolean(settings.antiBot) && isDotOrBotCommand) ||
          (Boolean(settings.antiSticker) && hasSticker);

        // Only query groupMetadata when a protection rule is actually triggered
        if (needsProtectionCheck) {
          const groupMeta = await getSafeGroupMetadata(activeSock, chatId);
          if (!groupMeta) return;

          // If the bot account is not a group admin, it has no authority to enforce rules. Do not send anything!
          const botCheckJids = [
            activeSock.user?.id,
            activeSock.user?.lid,
            activeSock.user?.phoneNumber,
            linkedOwnerPhone ? `${linkedOwnerPhone}@s.whatsapp.net` : "",
            linkedOwnerJid,
            linkedOwnerLid,
            botNumber ? `${botNumber}@s.whatsapp.net` : "",
            pairingNumber ? `${pairingNumber}@s.whatsapp.net` : "",
          ].filter(Boolean);
          if (!isAdmin(groupMeta, botCheckJids)) {
            return;
          }

          const senderIsAdmin = isAdmin(groupMeta, [sender, ...senderJids, ...explicitParticipantJids]);

          // Strict Group Security: ONLY non-admins are subject to anti penalties.
          // Group Admins, Creators, and the Bot Owner are strictly exempted.
          if (!senderIsAdmin && !senderIsLinkedAccount) {
            if (Boolean(settings.antiStatus) && hasStatusMention) {
              await enforceProtection({
                chatId,
                message,
                sender,
                senderJids,
                groupMeta,
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
                groupMeta,
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
                groupMeta,
                reason: "Unauthorized Bot Command (.prefix)",
              });
              return;
            }

            if (Boolean(settings.antiSticker) && hasSticker) {
              await enforceProtection({
                chatId,
                message,
                sender,
                senderJids,
                groupMeta,
                reason: "Sending Unauthorized Stickers",
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

      // STRICT ZERO-EXCEPTION PRIVATE BOT ARCHITECTURE:
      // A bot MUST ONLY answer commands from its OWN linked WhatsApp account owner!
      // In DMs AND in Groups: If the sender is NOT the linked account owner of this bot instance,
      // the bot remains 100% silent and NEVER answers!
      // On NO occasion should any bot ever answer commands from other members or other bots!
      if (!senderIsLinkedAccount) {
        return;
      }

      const isStealthCommand =
        command === "open" ||
        command === "vv" ||
        command === "viewonce" ||
        command === "status" ||
        command === "groupstatus" ||
        command === "gcstatus" ||
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

        // Instant Reaction to command message (except .status / .gcstatus which handles its own deliberate timer)
        if (message?.key && command !== "status" && command !== "groupstatus" && command !== "gcstatus") {
          const reactionEmoji = COMMAND_REACTIONS[command] || "⚡";
          getLiveSocket()?.sendMessage(chatId, { react: { text: reactionEmoji, key: message.key } }).catch(() => {});
        }

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
      const credsMe = sock?.authState?.creds?.me;
      if (credsMe?.id) registerOwnerIdentity(credsMe.id);
      if (credsMe?.lid) registerOwnerIdentity(credsMe.lid);
      if (credsMe?.phoneNumber) registerOwnerIdentity(credsMe.phoneNumber);
      const p = Promise.resolve(saveCreds()).catch((err) => {
        logger.warn("saveCreds warning", err?.message);
      });
      pendingCredsSave = p;
      await p;
      syncSessionToSupabase(userId, userSessionDir);
    });
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      const currentSocket = sock;
      if (!currentSocket || !Array.isArray(messages)) return;
      // Skip pure history sync batches without message content
      if (type === "append" && messages.every((m) => m?.message?.protocolMessage?.historySyncNotification || !m?.message)) {
        return;
      }
      const now = Date.now();
      for (const message of messages) {
        if (!message?.message) continue;
        if (message.message?.protocolMessage?.historySyncNotification) continue;

        // Discard genuine multi-day or ancient offline backlog, but allow fresh messages & self-commands
        const rawTs = Number(message.messageTimestamp);
        const msgTs = rawTs ? (rawTs > 1e11 ? rawTs : rawTs * 1000) : now;
        if (!message.key?.fromMe && Math.abs(now - msgTs) > 10 * 60 * 1000) continue;

        const text = getMessageText(message);
        // ZERO-LATENCY EMERGENCY STOP INTERCEPT:
        // The instant a stop packet arrives, halt any active spam tasks synchronously!
        if (text) {
          const lowerText = text.trim().toLowerCase();
          if (
            lowerText === ".stop" ||
            lowerText === "stop" ||
            lowerText === "!stop" ||
            lowerText === "/stop" ||
            lowerText === "#stop" ||
            lowerText.startsWith(".stop ") ||
            lowerText.startsWith("stop ")
          ) {
            stopSpamTask(message.key?.remoteJid, userId);
            stopSpamTask(null, userId);
          }
        }

        if (text && isCommand(text)) {
          // Process commands with instant priority so they are never blocked by chat queue
          processMessage(message, currentSocket, now).catch((error) => {
            if (!error?.message?.includes("Connection Closed") && !error?.message?.includes("connection closed")) {
              logger.error("Command processing failed", error.stack || error.message);
            }
          });
        } else if (!message.key?.fromMe) {
          // Immediately process incoming messages so prohibited links, stickers, and status mentions are deleted instantly!
          processMessage(message, currentSocket, now).catch((error) => {
            if (!error?.message?.includes("Connection Closed") && !error?.message?.includes("connection closed")) {
              logger.error("Message processing failed", error.stack || error.message);
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

        // HIGH-SPEED BATCH ACCUMULATOR:
        // Greet every single newcomer or departing member. If multiple people join or leave within
        // a short window (e.g. 20 members added), batch them together into ONE bold, styled greeting
        // so no one is missed and responses are immediate!
        const batchKey = `${action}:${groupId}`;
        let batch = pendingParticipantBatches.get(batchKey);
        if (!batch) {
          batch = {
            groupId,
            action,
            members: new Map(),
            timer: null,
            metadata,
          };
          pendingParticipantBatches.set(batchKey, batch);
        }
        if (metadata) batch.metadata = metadata;

        for (const item of targetList) {
          batch.members.set(item.cleanNum, item);
        }

        if (batch.timer) clearTimeout(batch.timer);
        batch.timer = setTimeout(async () => {
          pendingParticipantBatches.delete(batchKey);
          const memberList = Array.from(batch.members.values());
          if (memberList.length === 0) return;

          const activeMetadata = batch.metadata || (await getSafeGroupMetadata(sock, groupId, 15000).catch(() => null));
          const groupName = activeMetadata?.subject || "the group";

          if (isWelcomeAction) {
            if (memberList.length === 1) {
              const { cleanNum, mentionJid } = memberList[0];
              const welcomeText = [
                "┏━━━━━━━〔 🌟 *WELCOME* 🌟 〕━━━━━━━┓",
                "┃",
                "┃ 👋 *WELCOME TO THE GROUP!*",
                `┃ 👤 *@${cleanNum}*`,
                `┃ 🏰 *Group:* *${groupName}*`,
                "┃ 💬 *Read group rules & enjoy your stay!* ❤️",
                "┃",
                "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛",
              ].join("\n");

              await sock.sendMessage(groupId, {
                text: welcomeText,
                mentions: [mentionJid],
              }).catch((err) => {
                logger.warn(`Could not send welcome message to @${cleanNum}`, err?.message);
              });
            } else {
              // Multi-member batch greeting (2+ or 20 newcomers added)
              const allMentions = memberList.map((t) => t.mentionJid);
              const tagList = memberList.map((t) => `@${t.cleanNum}`).join(" ");
              const welcomeText = [
                "┏━━━━━━━〔 🌟 *WELCOME* 🌟 〕━━━━━━━┓",
                "┃",
                "┃ 👋 *WELCOME TO THE GROUP!*",
                `┃ 👥 ${tagList}`,
                `┃ 🏰 *Group:* *${groupName}*`,
                "┃ 💬 *Read group rules & enjoy your stay!* ❤️",
                "┃",
                "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛",
              ].join("\n");

              await sock.sendMessage(groupId, {
                text: welcomeText,
                mentions: allMentions,
              }).catch((err) => {
                logger.warn("Could not send batched welcome message", err?.message);
              });
            }
          } else if (isGoodbyeAction) {
            if (memberList.length === 1) {
              const { cleanNum, mentionJid } = memberList[0];
              const goodbyeText = [
                "┏━━━━━━━〔 🚪 *GOODBYE* 🚪 〕━━━━━━━┓",
                "┃",
                "┃ 💔 *MEMBER DEPARTED*",
                `┃ 👤 *@${cleanNum}*`,
                `┃ 🏰 *Left:* *${groupName}*`,
                "┃ ✨ *Farewell & wishing you the best!*",
                "┃",
                "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛",
              ].join("\n");

              await sock.sendMessage(groupId, {
                text: goodbyeText,
                mentions: [mentionJid],
              }).catch((err) => {
                logger.warn(`Could not send goodbye message to @${cleanNum}`, err?.message);
              });
            } else {
              // Multi-member batch departure (2+ or 20 members left)
              const allMentions = memberList.map((t) => t.mentionJid);
              const tagList = memberList.map((t) => `@${t.cleanNum}`).join(" ");
              const goodbyeText = [
                "┏━━━━━━━〔 🚪 *GOODBYE* 🚪 〕━━━━━━━┓",
                "┃",
                "┃ 💔 *MEMBERS DEPARTED*",
                `┃ 👥 ${tagList}`,
                `┃ 🏰 *Left:* *${groupName}*`,
                "┃ ✨ *Farewell & wishing you the best!*",
                "┃",
                "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛",
              ].join("\n");

              await sock.sendMessage(groupId, {
                text: goodbyeText,
                mentions: allMentions,
              }).catch((err) => {
                logger.warn("Could not send batched goodbye message", err?.message);
              });
            }
          }
        }, 750);
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
        const previousStateWasPairing = state === "pairing";
        reconnectAttempt = 0;
        sessionRegistered = true;
        state = "connected";
        const rawUserId = nextSocket.user?.id || nextSocket.authState?.creds?.me?.id || "";
        botNumber = rawUserId.split(":")[0]?.split("@")[0] || botNumber || pairingNumber || "";
        if (nextSocket.user?.id) registerOwnerIdentity(nextSocket.user.id);
        if (nextSocket.user?.lid) registerOwnerIdentity(nextSocket.user.lid);
        if (nextSocket.user?.phoneNumber) registerOwnerIdentity(nextSocket.user.phoneNumber);
        if (nextSocket.authState?.creds?.me?.id) registerOwnerIdentity(nextSocket.authState.creds.me.id);
        if (nextSocket.authState?.creds?.me?.lid) registerOwnerIdentity(nextSocket.authState.creds.me.lid);
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
        const isRestartRequired = errorInfo.code === DisconnectReason.restartRequired || errorInfo.code === 515;
        if (isRestartRequired || hasValidCreds(nextSocket.authState?.creds)) {
          sessionRegistered = true;
        }
        const hasValidPairing = Boolean(pairingCode && (!pairingExpiresAt || pairingExpiresAt > Date.now()));
        const isPairingOrHandshake = hasValidPairing || (syncStepNumber >= 1 && syncStepNumber < 6);
        const pairingFailed = !isRestartRequired && !sessionRegistered && !hasValidPairing && (state === "pairing" || Boolean(pairingRequest));
        const shouldReconnect = !wasIntentional
          && (isRestartRequired || sessionRegistered || hasSavedSession() || hasValidPairing);

        if (state === "pairing" && !isRestartRequired && !sessionRegistered && !hasValidPairing) {
          pairingCode = "";
          pairingExpiresAt = 0;
          pairingNumber = "";
          state = "idle";
          setSyncStep(0, "Ready to pair");
          lastError = "WhatsApp pairing session timed out. Please generate a new code and enter it promptly.";
          lastErrorCode = "PAIRING_TIMEOUT";
        }

        if (wasIntentional) {
          state = "idle";
          lastError = "";
          lastErrorCode = null;
          sessionRegistered = false;
          fs.rm(userSessionDir, { recursive: true, force: true }).catch(() => {});
          deleteSessionFromSupabase(userId).catch(() => {});
        } else if (state !== "idle") {
          state = isPairingOrHandshake ? "pairing" : (pairingFailed ? "error" : "connecting");
        }

        if (isRestartRequired) {
          state = isPairingOrHandshake ? "pairing" : "connecting";
          if (!hasValidPairing) {
            pairingCode = "";
            pairingExpiresAt = 0;
            pairingNumber = "";
          }
        }

        lastError = (wasIntentional || shouldReconnect) ? "" : errorInfo.message;
        lastErrorCode = (wasIntentional || shouldReconnect) ? null : errorInfo.code;

        if (isRestartRequired) {
          lastError = "";
          lastErrorCode = null;
        }

        if (!wasIntentional) logger.warn("WhatsApp connection closed", `${errorInfo.code || "unknown"} ${errorInfo.message}`);
        rejectPairingReady(new Error(errorInfo.message));
        try { nextSocket.ws?.close(); } catch {}
        try { nextSocket.end?.(); } catch {}
        sock = null;
        const isLoggedOut = errorInfo.code === DisconnectReason.loggedOut;
        if (shouldReconnect) {
          if (errorInfo.code === 440) {
            reconnectAttempt += 1;
            const conflictDelay = Math.min(15000, 3000 + reconnectAttempt * 2000);
            logger.warn("WhatsApp stream conflict (440). Resuming session cleanly...", `${conflictDelay}ms`);
            clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(() => void connect(), conflictDelay);
            return;
          }

          reconnectAttempt = isRestartRequired ? 0 : reconnectAttempt + 1;
          const delay = isRestartRequired ? 1000 : Math.min(6000, 1000 * Math.min(reconnectAttempt, 4));
          logger.warn("Scheduling WhatsApp auto-reconnect", `${delay}ms`);
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => void connect(), delay);
        } else if (!wasIntentional) {
          // If we have a saved session on disk, NEVER sleep or stay disconnected!
          if (hasSavedSession() || sessionRegistered) {
            logger.warn("Unplanned socket disconnect detected. Enforcing automatic 24/7 reconnect...");
            clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(() => void connect(), 2000);
          } else if (isLoggedOut) {
            state = "idle";
          } else {
            state = "connecting";
            clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(() => void connect(), 3000);
          }
        }
      }
    });
  }

  async function connect(connectOptions = {}) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (connecting) return connecting;
    if (sock && sock.ws && (sock.ws.isOpen || sock.ws.socket?.readyState === 1) && state === "connected") return sock;
    if (sock) {
      try { sock.ws?.close(); } catch {}
      try { sock.end?.(); } catch {}
      sock = null;
    }
    intentionalDisconnect = false;
    connecting = (async () => {
      await pendingCredsSave.catch(() => {});
      await fs.mkdir(userSessionDir, { recursive: true });
      if (!connectOptions.isPairing) {
        await restoreSessionFromSupabase(userId, userSessionDir);
        await pruneOldSessionPreKeys(userSessionDir);
      }
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
          if (msgRetryMap.size > 500) {
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
          if (signalCacheMap.size > 600) {
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
        connectTimeoutMs: 90000,
        defaultQueryTimeoutMs: 90000,
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
        getMessage: async (key) => {
          if (!key?.id) return undefined;
          try {
            const cached = getCachedIncomingMessage(userId, key.id);
            if (cached?.rawMessage?.message) return cached.rawMessage.message;
            if (cached?.content) return cached.content;
          } catch {}
          return undefined;
        },
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

    // Unmark user from disconnected list as user is explicitly requesting to pair
    unmarkUserAsDisconnected(userId, phone);
    unmarkUserAsDisconnected(verifiedUid, phone);

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

    // If a pairing code was already generated within the last 90s for this phone and socket is still active, return it immediately
    if (pairingCode && pairingNumber === phone && pairingExpiresAt > Date.now() + 15000 && sock && sock.ws && (sock.ws.isOpen || sock.ws.socket?.readyState === 1)) {
      logger.info(`Returning active pairing code for ${phone} immediately`);
      return { code: formatPairingCode(pairingCode), rawCode: cleanCode(pairingCode), expiresAt: pairingExpiresAt, phone };
    }

    // Clean up any previous stale socket or old non-connected registration files
    await disconnect();
    intentionalDisconnect = false;
    sessionRegistered = false;

    // Remove any stale unlinked credentials so Baileys can issue a fresh pairing code without collision
    try {
      await fs.rm(userSessionDir, { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(userSessionDir, { recursive: true });
    } catch {}

    let trackedRequest;
    const request = (async () => {
      try {
        setSyncStep(1, "Connecting to WhatsApp gateway...");
        const readyPromise = beginPairingReadyWait(35000);
        const candidate = await connect({ isPairing: true });
        if (!candidate) throw new Error("WhatsApp connection could not be opened.");

        logger.info(`Waiting for real WhatsApp Baileys gateway handshake before requesting pairing code for ${phone}...`);
        setSyncStep(2, "Negotiating Noise handshake with WhatsApp gateway...");
        // Strictly wait for real Baileys companion handshake (qr / gateway readiness)
        await readyPromise;

        if (!sock || candidate !== sock) {
          throw new Error("WhatsApp connection reset during gateway handshake.");
        }
        logger.info(`WhatsApp companion handshake confirmed! Requesting official link_code_companion_reg for ${phone}...`);

        let code;
        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            if (!sock || candidate !== sock) throw new Error("WhatsApp connection reset.");
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
              await new Promise((r) => setTimeout(r, 1500));
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
        setSyncStep(3, "Real pairing code active & notification sent to device");
        return { code: formatPairingCode(code), rawCode: cleanCode(code), expiresAt: pairingExpiresAt, phone };
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
    markUserAsDisconnected(userId, botNumber);
    if (verifiedUid) markUserAsDisconnected(verifiedUid, botNumber);
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
    await deleteSessionFromSupabase(userId).catch(() => {});
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
    if (intentionalDisconnect || state === "expired") return;
    const isSocketOpen = Boolean(sock && sock.ws && (sock.ws.isOpen || sock.ws.socket?.readyState === 1) && state === "connected");
    if (isSocketOpen) return;

    if (hasSavedSession() && state !== "pairing" && state !== "connecting") {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      connecting = null;
      if (sock && (!sock.ws || (!sock.ws.isOpen && sock.ws.socket?.readyState !== 1))) {
        try { sock.ws?.close(); } catch {}
        try { sock.ws?.socket?.close(); } catch {}
        try { sock.end?.(); } catch {}
        sock = null;
      }
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

const DISCONNECTED_USERS_FILE = path.join(DATA_DIR, "data", "admin-disconnected-users.json");
let adminDisconnectedUsers = new Set();

function loadAdminDisconnectedUsers() {
  try {
    if (fsSync.existsSync(DISCONNECTED_USERS_FILE)) {
      const raw = fsSync.readFileSync(DISCONNECTED_USERS_FILE, "utf8");
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        adminDisconnectedUsers = new Set(list);
      }
    }
  } catch {}
}
loadAdminDisconnectedUsers();

function saveAdminDisconnectedUsers() {
  try {
    const dir = path.dirname(DISCONNECTED_USERS_FILE);
    if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
    fsSync.writeFileSync(DISCONNECTED_USERS_FILE, JSON.stringify([...adminDisconnectedUsers], null, 2));
  } catch {}
}

export function isUserMarkedDisconnected(userId) {
  if (!userId) return false;
  const clean = String(userId).trim();
  const bare = clean.replace(/^user_/, "");
  return adminDisconnectedUsers.has(clean) || adminDisconnectedUsers.has(bare) || adminDisconnectedUsers.has(`user_${bare}`);
}

export function markUserAsDisconnected(userId, optionalPhone = "") {
  if (!userId) return;
  const clean = String(userId).trim();
  const bare = clean.replace(/^user_/, "");
  adminDisconnectedUsers.add(clean);
  adminDisconnectedUsers.add(bare);
  adminDisconnectedUsers.add(`user_${bare}`);
  if (optionalPhone) {
    const cleanPhone = String(optionalPhone).replace(/\D/g, "");
    if (cleanPhone) adminDisconnectedUsers.add(cleanPhone);
  }
  saveAdminDisconnectedUsers();
}

export function unmarkUserAsDisconnected(userId, optionalPhone = "") {
  if (!userId) return;
  const clean = String(userId).trim();
  const bare = clean.replace(/^user_/, "");
  adminDisconnectedUsers.delete(clean);
  adminDisconnectedUsers.delete(bare);
  adminDisconnectedUsers.delete(`user_${bare}`);
  if (optionalPhone) {
    const cleanPhone = String(optionalPhone).replace(/\D/g, "");
    if (cleanPhone) adminDisconnectedUsers.delete(cleanPhone);
  }
  saveAdminDisconnectedUsers();
}

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
      if (isUserMarkedDisconnected(userId)) {
        logger.info(`Skipping auto-restore for user ${userId}: Explicitly disconnected by administrator/user.`);
        continue;
      }
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
    } else if (controller.hasSavedSession() && st.status !== "pairing" && st.status !== "connecting" && st.status !== "connected") {
      try {
        const licenseStatus = await getUserLicenseStatus(verifiedUid, userEmail);
        if (licenseStatus.status !== "expired") {
          await controller.ensureConnected();
        }
      } catch {}
    }
  }

  // 24/7/365 Universal Auto-Revival for ALL users:
  // Discovers any saved session on disk that was closed or offline, bringing it online immediately.
  try {
    if (fsSync.existsSync(SESSION_DIR)) {
      const entries = await fs.readdir(SESSION_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirUserId = entry.name;
          if (isUserMarkedDisconnected(dirUserId)) continue;
          const credsFile = path.join(SESSION_DIR, dirUserId, "creds.json");
          if (fsSync.existsSync(credsFile)) {
            const bareUid = dirUserId.replace(/^user_/, "");
            const lic = await getUserLicenseStatus(bareUid);
            if (lic.status !== "expired") {
              const ctrl = getWhatsAppController(dirUserId, { verifiedUid: bareUid });
              if (!ctrl.isConnected() && !ctrl.isConnecting()) {
                ctrl.ensureConnected().catch(() => {});
              }
            }
          }
        }
      }
    }
  } catch (scanErr) {
    logger.debug?.("auditActiveSessions disk scan notice:", scanErr.message);
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

  // Mark user as explicitly disconnected so auto-restore / site updates never reconnect it
  markUserAsDisconnected(cleanUid, targetPhone);

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

/**
 * Disconnects all active and saved WhatsApp sessions at once, wiping credentials so all accounts can pair fresh.
 */
export async function disconnectAllSessionsWithNotice(customMessage = null) {
  const allIds = new Set();
  for (const id of userControllers.keys()) {
    allIds.add(id);
    allIds.add(id.replace(/^user_/, ""));
  }
  if (fsSync.existsSync(SESSION_DIR)) {
    try {
      const entries = await fs.readdir(SESSION_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          allIds.add(entry.name);
          allIds.add(entry.name.replace(/^user_/, ""));
        }
      }
    } catch {}
  }
  return disconnectMultipleSessionsWithNotice([...allIds], customMessage);
}

function formatByteSize(bytes = 0) {
  const n = Number(bytes) || 0;
  if (n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatUptimeDuration(seconds = 0) {
  const s = Math.floor(seconds || 0);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

/**
 * Returns comprehensive transient storage, process memory, and direct Firebase storage diagnostics.
 */
export async function getTransientStorageDiagnostics() {
  let totalFiles = 0;
  let totalTransientFiles = 0;
  let totalTransientBytes = 0;
  let totalActiveKeys = 0;
  let totalActiveKeysBytes = 0;
  let totalLidFiles = 0;
  let totalDeviceListFiles = 0;
  let totalTcTokenFiles = 0;
  let totalPreKeys = 0;
  let totalCredsFiles = 0;
  let totalCredsBytes = 0;

  const sessionsBreakdown = [];

  try {
    if (fsSync.existsSync(SESSION_DIR)) {
      const entries = await fs.readdir(SESSION_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dirName = entry.name;
        const dirPath = path.join(SESSION_DIR, dirName);
        let files = [];
        try {
          files = await fs.readdir(dirPath);
        } catch {
          continue;
        }

        let dirTransientCount = 0;
        let dirTransientBytes = 0;
        let dirActiveKeysCount = 0;
        let dirActiveKeysBytes = 0;
        let hasCreds = false;
        let credsBytes = 0;
        let botNumber = "";

        const preKeysInDir = [];

        for (const f of files) {
          totalFiles++;
          const fullPath = path.join(dirPath, f);
          let stat = null;
          try {
            stat = fsSync.statSync(fullPath);
          } catch {}
          const sz = stat ? stat.size : 0;

          if (f.startsWith("lid-mapping-")) {
            totalLidFiles++;
            totalTransientFiles++;
            totalTransientBytes += sz;
            dirTransientCount++;
            dirTransientBytes += sz;
          } else if (f.startsWith("device-list-")) {
            totalDeviceListFiles++;
            totalTransientFiles++;
            totalTransientBytes += sz;
            dirTransientCount++;
            dirTransientBytes += sz;
          } else if (f.startsWith("tctoken-")) {
            totalTcTokenFiles++;
            totalTransientFiles++;
            totalTransientBytes += sz;
            dirTransientCount++;
            dirTransientBytes += sz;
          } else if (f.startsWith("pre-key-") && f.endsWith(".json")) {
            totalPreKeys++;
            preKeysInDir.push({ file: f, size: sz, mtime: stat ? stat.mtimeMs : 0 });
          } else if (f === "creds.json") {
            hasCreds = true;
            credsBytes = sz;
            totalCredsFiles++;
            totalCredsBytes += sz;
            totalActiveKeys++;
            totalActiveKeysBytes += sz;
            dirActiveKeysCount++;
            dirActiveKeysBytes += sz;
            try {
              const raw = JSON.parse(fsSync.readFileSync(fullPath, "utf8"));
              botNumber = raw?.me?.id?.split(":")[0]?.split("@")[0] || "";
            } catch {}
          } else {
            // Protected active ratchet key (session-*, sender-key-*, app-state-sync-key-*)
            totalActiveKeys++;
            totalActiveKeysBytes += sz;
            dirActiveKeysCount++;
            dirActiveKeysBytes += sz;
          }
        }

        // Prekeys: newest 150 are active; older ones are transient and clearable
        preKeysInDir.sort((a, b) => b.mtime - a.mtime);
        const keptPreKeys = preKeysInDir.slice(0, 150);
        const excessPreKeys = preKeysInDir.slice(150);

        for (const pk of keptPreKeys) {
          totalActiveKeys++;
          totalActiveKeysBytes += pk.size;
          dirActiveKeysCount++;
          dirActiveKeysBytes += pk.size;
        }
        for (const pk of excessPreKeys) {
          totalTransientFiles++;
          totalTransientBytes += pk.size;
          dirTransientCount++;
          dirTransientBytes += pk.size;
        }

        const ctrl = userControllers.get(dirName) || userControllers.get(dirName.replace(/^user_/, ""));
        const socketStatus = ctrl ? ctrl.getStatus() : null;
        const isLive = ctrl ? ctrl.isConnected() && Boolean(ctrl.getSocket()?.user) : false;

        sessionsBreakdown.push({
          userId: dirName,
          verifiedUid: dirName.replace(/^user_/, ""),
          botNumber: botNumber || (socketStatus ? socketStatus.botNumber : ""),
          status: isLive ? "connected" : (socketStatus ? socketStatus.status : (hasCreds ? "saved_on_disk" : "idle")),
          isLiveConnected: isLive,
          userEmail: ctrl?.getUserEmail ? ctrl.getUserEmail() : "",
          connectedAt: socketStatus?.connectedAt || null,
          totalFiles: files.length,
          transientFiles: dirTransientCount,
          transientBytes: dirTransientBytes,
          transientFormatted: formatByteSize(dirTransientBytes),
          activeKeys: dirActiveKeysCount,
          activeKeysBytes: dirActiveKeysBytes,
          activeKeysFormatted: formatByteSize(dirActiveKeysBytes),
          hasCreds,
          credsSizeBytes: credsBytes,
          credsFormatted: formatByteSize(credsBytes),
        });
      }
    }

    // Include any in-memory live controllers not present in SESSION_DIR scan
    for (const [memUid, memCtrl] of userControllers.entries()) {
      const bareUid = memUid.replace(/^user_/, "");
      const alreadyIncluded = sessionsBreakdown.some((s) => s.userId === memUid || s.verifiedUid === bareUid);
      if (!alreadyIncluded) {
        const memStatus = memCtrl ? memCtrl.getStatus() : null;
        const memLive = memCtrl ? memCtrl.isConnected() && Boolean(memCtrl.getSocket()?.user) : false;
        sessionsBreakdown.push({
          userId: memUid,
          verifiedUid: bareUid,
          botNumber: memStatus?.botNumber || "",
          status: memLive ? "connected" : (memStatus?.status || "connecting"),
          isLiveConnected: memLive,
          userEmail: memCtrl?.getUserEmail ? memCtrl.getUserEmail() : "",
          connectedAt: memStatus?.connectedAt || null,
          totalFiles: 1,
          transientFiles: 0,
          transientBytes: 0,
          transientFormatted: "0 B",
          activeKeys: 1,
          activeKeysBytes: 2048,
          activeKeysFormatted: "2.0 KB",
          hasCreds: true,
          credsSizeBytes: 2048,
          credsFormatted: "2.0 KB",
        });
      }
    }

    // Sort connected accounts to the top of the list
    sessionsBreakdown.sort((a, b) => {
      if (a.isLiveConnected && !b.isLiveConnected) return -1;
      if (!a.isLiveConnected && b.isLiveConnected) return 1;
      return a.userId.localeCompare(b.userId);
    });
  } catch (err) {
    logger.debug("Transient diagnostics scan note:", err.message);
  }

  // 2. Bot logs stats
  let logFileBytes = 0;
  let logFileLines = 0;
  try {
    if (fsSync.existsSync(LOG_FILE)) {
      const st = fsSync.statSync(LOG_FILE);
      logFileBytes = st.size;
      logFileLines = Math.round(logFileBytes / 120);
    }
  } catch {}

  // 3. Deleted messages cache
  const delMsgStats = getDeletedMessageCacheStats();

  // 4. Memory stats
  const mem = process.memoryUsage();
  const memoryInfo = {
    heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
    rssMb: Math.round(mem.rss / 1024 / 1024),
    externalMb: Math.round(mem.external / 1024 / 1024),
    uptimeSeconds: Math.round(process.uptime()),
    uptimeFormatted: formatUptimeDuration(Math.round(process.uptime())),
  };

  // 5. Firebase Firestore User Storage breakdown
  let firebaseUsers = [];
  let totalFirebaseUserBytes = 0;
  let totalFirebaseSessionsCount = 0;
  let totalFirebaseSessionsBytes = 0;

  try {
    const [rawUsers, rawLicenses, rawFsSessions] = await Promise.all([
      firestoreGetAll("users").catch(() => []),
      firestoreGetAll("user_licenses").catch(() => []),
      firestoreGetAll("whatsapp_sessions").catch(() => []),
    ]);

    const sessionsByUidMap = new Map();
    for (const fsSess of rawFsSessions || []) {
      const sid = String(fsSess.id || fsSess.safeUserId || "").trim();
      const bare = sid.replace(/^user_/, "");
      const sz = Number(fsSess.credsSizeBytes) || (fsSess.files && fsSess.files["creds.json"] ? Buffer.byteLength(fsSess.files["creds.json"], "utf8") : 2048);
      sessionsByUidMap.set(sid, { ...fsSess, sz });
      sessionsByUidMap.set(bare, { ...fsSess, sz });
      totalFirebaseSessionsCount++;
      totalFirebaseSessionsBytes += sz;
    }

    const licensesByUid = new Map();
    for (const lic of rawLicenses || []) {
      const uid = String(lic.id || lic.uid || "").replace(/^user_/, "");
      licensesByUid.set(uid, lic);
    }

    const mergedUserMap = new Map();
    for (const u of rawUsers || []) {
      const uid = String(u.id || u.uid || "");
      if (!uid) continue;
      mergedUserMap.set(uid, u);
    }
    for (const uid of licensesByUid.keys()) {
      if (!mergedUserMap.has(uid)) {
        mergedUserMap.set(uid, { id: uid, uid });
      }
    }
    for (const sid of sessionsByUidMap.keys()) {
      const bare = sid.replace(/^user_/, "");
      if (!mergedUserMap.has(bare)) {
        mergedUserMap.set(bare, { id: bare, uid: bare });
      }
    }

    for (const [uid, uDoc] of mergedUserMap.entries()) {
      const uLic = licensesByUid.get(uid) || {};
      const uSess = sessionsByUidMap.get(uid) || sessionsByUidMap.get(`user_${uid}`) || null;

      const userDocBytes = Buffer.byteLength(JSON.stringify(uDoc || {}), "utf8");
      const licDocBytes = Buffer.byteLength(JSON.stringify(uLic || {}), "utf8");
      const sessBytes = uSess ? (uSess.sz || 2048) : 0;
      const totalUserBytes = userDocBytes + licDocBytes + sessBytes;
      totalFirebaseUserBytes += totalUserBytes;

      const isUnl = Boolean(uLic.isUnlimited || uLic.is_unlimited || uLic.durationDays === "Unlimited");
      const isExp = !isUnl && uLic.expiresAt && new Date(uLic.expiresAt) <= new Date();
      const licStatus = isUnl ? "unlimited" : (isExp ? "expired" : (uLic.expiresAt ? "active" : "none"));

      firebaseUsers.push({
        uid,
        email: uDoc.email || uLic.email || "",
        displayName: uDoc.displayName || "User",
        role: uDoc.role || (isAdminEmail(uDoc.email) ? "admin" : "user"),
        licenseStatus: licStatus,
        isUnlimited: isUnl,
        hasFirebaseCreds: Boolean(uSess),
        credsSizeBytes: sessBytes,
        credsFormatted: sessBytes > 0 ? formatByteSize(sessBytes) : "—",
        userDocSizeBytes: userDocBytes + licDocBytes,
        totalFirestoreBytes: totalUserBytes,
        totalFirestoreFormatted: formatByteSize(totalUserBytes),
        updatedAt: uSess?.updatedAt || uDoc?.updatedAt || uLic?.updatedAt || null,
      });
    }
  } catch (fsErr) {
    logger.debug("Firebase users diagnostic notice:", fsErr.message);
  }

  return {
    success: true,
    transient: {
      totalFiles,
      transientFiles: totalTransientFiles,
      transientBytes: totalTransientBytes,
      transientFormatted: formatByteSize(totalTransientBytes),
      lidFiles: totalLidFiles,
      deviceListFiles: totalDeviceListFiles,
      tcTokenFiles: totalTcTokenFiles,
      preKeys: totalPreKeys,
      activeKeys: totalActiveKeys,
      activeKeysBytes: totalActiveKeysBytes,
      activeKeysFormatted: formatByteSize(totalActiveKeysBytes),
      credsFiles: totalCredsFiles,
      credsBytes: totalCredsBytes,
      credsFormatted: formatByteSize(totalCredsBytes),
    },
    logs: {
      logFileBytes,
      logFileFormatted: formatByteSize(logFileBytes),
      logFileLines,
      deletedMessagesCached: delMsgStats.totalRecords,
      deletedMessagesBytes: delMsgStats.estimatedBytes,
      deletedMessagesFormatted: formatByteSize(delMsgStats.estimatedBytes),
    },
    memory: memoryInfo,
    sessions: sessionsBreakdown,
    firebase: {
      totalUsers: firebaseUsers.length,
      totalStorageBytes: totalFirebaseUserBytes,
      totalStorageFormatted: formatByteSize(totalFirebaseUserBytes),
      syncedSessionsCount: totalFirebaseSessionsCount,
      syncedSessionsBytes: totalFirebaseSessionsBytes,
      syncedSessionsFormatted: formatByteSize(totalFirebaseSessionsBytes),
      usersList: firebaseUsers,
    },
  };
}

/**
 * Safely purges transient mapping/token files and consumed prekeys across session directories.
 * Strictly preserves creds.json, active session ratchets, and NEVER disconnects active Baileys sockets.
 * Directly syncs ultra-lean creds.json to Firebase Firestore and performs V8 garbage collection.
 */
export async function purgeTransientStorage(options = {}) {
  const {
    purgeTransient = true,
    truncateLogs = false,
    clearMsgCache = false,
    resyncCredsToFirebase = true,
    runGc = true,
    targetUserId = null,
  } = options;

  let purgedFilesCount = 0;
  let purgedBytes = 0;
  let remainingFilesCount = 0;
  let activeSocketsProtected = 0;
  let syncedToFirebaseCount = 0;

  const memBefore = process.memoryUsage();
  const heapBeforeMb = Math.round(memBefore.heapUsed / 1024 / 1024);

  // 1. Purge transient files across sessions
  if (purgeTransient && fsSync.existsSync(SESSION_DIR)) {
    const entries = await fs.readdir(SESSION_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirName = entry.name;
      if (targetUserId && dirName !== targetUserId && dirName !== `user_${targetUserId}`) {
        continue;
      }
      const dirPath = path.join(SESSION_DIR, dirName);
      let files = [];
      try {
        files = await fs.readdir(dirPath);
      } catch {
        continue;
      }

      const preKeysInDir = [];

      for (const f of files) {
        const fullPath = path.join(dirPath, f);
        let stat = null;
        try {
          stat = fsSync.statSync(fullPath);
        } catch {}
        const sz = stat ? stat.size : 0;

        if (
          f.startsWith("device-list-") ||
          f.startsWith("tctoken-") ||
          f.endsWith(".tmp") ||
          f.endsWith(".bak")
        ) {
          try {
            await fs.unlink(fullPath);
            purgedFilesCount++;
            purgedBytes += sz;
          } catch {}
        } else if (f.startsWith("pre-key-") && f.endsWith(".json")) {
          preKeysInDir.push({ file: fullPath, size: sz, mtime: stat ? stat.mtimeMs : 0 });
        } else {
          // Protected ratchet, app state sync, or creds
          remainingFilesCount++;
        }
      }

      // Pre-keys: keep freshest 100 to ensure fast disk I/O without breaking active WhatsApp ratchets
      if (preKeysInDir.length > 100) {
        preKeysInDir.sort((a, b) => b.mtime - a.mtime);
        const toKeep = preKeysInDir.slice(0, 100);
        const toDelete = preKeysInDir.slice(100);

        remainingFilesCount += toKeep.length;
        for (const pk of toDelete) {
          try {
            await fs.unlink(pk.file);
            purgedFilesCount++;
            purgedBytes += pk.size;
          } catch {}
        }
      } else {
        remainingFilesCount += preKeysInDir.length;
      }
    }
  }

  // Count active protected sockets
  for (const ctrl of userControllers.values()) {
    if (ctrl.isConnected()) {
      activeSocketsProtected++;
    }
  }

  // 2. Truncate bot logs if requested
  if (truncateLogs && fsSync.existsSync(LOG_FILE)) {
    try {
      const st = fsSync.statSync(LOG_FILE);
      purgedBytes += st.size;
      await fs.writeFile(LOG_FILE, "", "utf8");
      logger.info("[Storage Sanitation] Safely truncated bot.log to 0 bytes.");
    } catch (err) {
      logger.debug("Log truncate notice:", err.message);
    }
  }

  // 3. Clear deleted message cache if requested
  if (clearMsgCache) {
    try {
      const cleared = clearAllDeletedMessageCaches();
      logger.info(`[Storage Sanitation] Cleared ${cleared} cached deleted message records.`);
    } catch {}
  }

  // 4. Ultra-lightweight direct sync of creds.json to Firebase Firestore
  if (resyncCredsToFirebase && fsSync.existsSync(SESSION_DIR)) {
    try {
      const entries = await fs.readdir(SESSION_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dirName = entry.name;
        const credsFile = path.join(SESSION_DIR, dirName, "creds.json");
        if (fsSync.existsSync(credsFile)) {
          const credsContent = await fs.readFile(credsFile, "utf8");
          if (credsContent) {
            const sz = Buffer.byteLength(credsContent, "utf8");
            await firestoreUpsert("whatsapp_sessions", dirName, {
              safeUserId: dirName,
              userId: dirName,
              files: { "creds.json": credsContent },
              fileCount: 1,
              credsSizeBytes: sz,
              updatedAt: new Date().toISOString(),
            });
            syncedToFirebaseCount++;
          }
        }
      }
      logger.info(`[Direct Firebase Sync] Synced ${syncedToFirebaseCount} session credential(s) directly to Firebase Firestore.`);
    } catch (fbErr) {
      logger.debug("Direct Firebase creds sync notice:", fbErr.message);
    }
  }

  // 5. Proactive garbage collection
  if (runGc && typeof global.gc === "function") {
    try {
      global.gc();
      global.gc();
    } catch {}
  }

  const memAfter = process.memoryUsage();
  const heapAfterMb = Math.round(memAfter.heapUsed / 1024 / 1024);
  const memoryFreedMb = Math.max(0, heapBeforeMb - heapAfterMb);

  const message = `Purged ${purgedFilesCount.toLocaleString()} transient file(s) (${formatByteSize(purgedBytes)} freed). ${activeSocketsProtected} live WhatsApp account(s) 100% protected. Heap memory reduced from ${heapBeforeMb} MB to ${heapAfterMb} MB (${memoryFreedMb} MB freed). Synced ${syncedToFirebaseCount} credential(s) directly to Firebase Firestore.`;

  logger.info(`[Storage Sanitation] ${message}`);

  return {
    success: true,
    purgedFilesCount,
    purgedBytes,
    purgedBytesFormatted: formatByteSize(purgedBytes),
    remainingFilesCount,
    activeSocketsProtected,
    syncedToFirebaseCount,
    heapBeforeMb,
    heapAfterMb,
    memoryFreedMb,
    message,
  };
}

/**
 * Reads creds.json for all disk sessions and upserts them straight to Firebase Firestore.
 */
export async function resyncAllSessionsDirectlyToFirebase() {
  return purgeTransientStorage({
    purgeTransient: false,
    truncateLogs: false,
    clearMsgCache: false,
    resyncCredsToFirebase: true,
    runGc: true,
  });
}

/**
 * Dispatches a real WhatsApp DM notification directly to a user's phone number
 * using any available active connected bot socket.
 */
export async function sendWhatsAppNotificationToUser(targetPhoneOrUid, messageText) {
  if (!targetPhoneOrUid || !messageText) return false;
  let targetPhone = "";
  const cleanCandidate = String(targetPhoneOrUid).replace(/\D/g, "");
  if (cleanCandidate.length >= 7 && cleanCandidate.length <= 16) {
    targetPhone = cleanCandidate;
  } else {
    try {
      const { getLockedNumberForUid } = await import("./number-lock.js");
      const found = await getLockedNumberForUid(targetPhoneOrUid);
      if (found) targetPhone = String(found).replace(/\D/g, "");
    } catch {}
  }

  if (!targetPhone) {
    for (const [id, ctrl] of userControllers.entries()) {
      if (id === targetPhoneOrUid || id === `user_${targetPhoneOrUid}` || id.replace(/^user_/, "") === targetPhoneOrUid) {
        const st = ctrl.getStatus();
        if (st.botNumber) {
          targetPhone = String(st.botNumber).replace(/\D/g, "");
          break;
        }
      }
    }
  }

  if (!targetPhone) return false;
  const targetJid = `${targetPhone}@s.whatsapp.net`;

  // Prefer target user's own live socket; fallback to any connected bot socket
  let dispatchSocket = null;
  for (const [, ctrl] of userControllers.entries()) {
    const st = ctrl.getStatus();
    const s = ctrl.getSocket();
    if (s && (ctrl.isConnected() || st.status === "connected")) {
      const sockPhone = String(st.botNumber || "").replace(/\D/g, "");
      if (sockPhone === targetPhone) {
        dispatchSocket = s;
        break;
      }
      if (!dispatchSocket) {
        dispatchSocket = s;
      }
    }
  }

  if (dispatchSocket) {
    try {
      await dispatchSocket.sendMessage(targetJid, { text: messageText });
      logger.info(`Dispatched real WhatsApp notification to ${targetJid}`);
      return true;
    } catch (err) {
      logger.warn(`Could not dispatch WhatsApp notification to ${targetJid}: ${err.message}`);
    }
  }
  return false;
}

// -------------------------------------------------------------
// AUTOMATED 30-SECOND CLEANER & 24/7 ACTIVE KEEP-ALIVE LOOPS
// -------------------------------------------------------------

// Automated 5-minute periodic cleaner across every account:
// Prunes useless transient files and logs gently without breaking encryption or freezing the event loop
setInterval(() => {
  purgeTransientStorage({
    purgeTransient: true,
    truncateLogs: true,
    clearMsgCache: true,
    resyncCredsToFirebase: false,
    runGc: false,
  }).catch((err) => {
    logger.debug("[Periodic Cleaner] notice:", err.message);
  });
}, 5 * 60 * 1000).unref();

// Active 24/7 Socket Keep-Alive Ping Loop (Every 25 seconds):
// Pings WhatsApp servers and WebSocket frames across all active sockets
// so connections NEVER sleep, go idle, or get closed by Railway or carrier proxies.
setInterval(() => {
  for (const [, ctrl] of userControllers.entries()) {
    try {
      if (ctrl && ctrl.isConnected()) {
        const sock = ctrl.getSocket();
        if (sock) {
          sock.sendPresenceUpdate("available").catch(() => {});
          if (sock.ws && typeof sock.ws.ping === "function") {
            try { sock.ws.ping(); } catch {}
          }
        }
      }
    } catch {}
  }
}, 25 * 1000).unref();



