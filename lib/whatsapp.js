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

const SOLVATECH_PUBLIC_LOGO = "https://solvatechofficial.github.io/WHATSAPP-BOT-/solva.webp";

// Map of userId -> debounce timer for syncing session files to Firestore
const sessionSyncTimers = new Map();

async function restoreSessionFromFirestore(safeUserId, userSessionDir) {
  const credsFile = path.join(userSessionDir, "creds.json");
  if (fsSync.existsSync(credsFile)) return true;

  const db = getFirebaseServerFirestore();
  if (!db) return false;

  try {
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
    logger.info(`Restored WhatsApp session files from Firestore for user ${safeUserId}`);
    return fsSync.existsSync(credsFile);
  } catch (err) {
    logger.warn(`Could not restore WhatsApp session from Firestore for user ${safeUserId}`, err.message);
    return false;
  }
}

async function syncSessionToFirestore(safeUserId, userSessionDir) {
  const db = getFirebaseServerFirestore();
  if (!db) return;

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
        const { doc, setDoc } = await import("firebase/firestore");
        await setDoc(doc(db, "whatsapp_sessions", safeUserId), {
          updatedAt: new Date().toISOString(),
          fileCount: Object.keys(filesMap).length,
          files: filesMap,
        }, { merge: true });
        logger.debug(`Synced WhatsApp session files to Firestore for user ${safeUserId}`);
      }
    } catch (err) {
      logger.warn(`Failed to sync WhatsApp session to Firestore for user ${safeUserId}`, err.message);
    }
  }, 1500);

  sessionSyncTimers.set(safeUserId, timer);
}

async function deleteSessionFromFirestore(safeUserId) {
  if (sessionSyncTimers.has(safeUserId)) {
    clearTimeout(sessionSyncTimers.get(safeUserId));
    sessionSyncTimers.delete(safeUserId);
  }

  const db = getFirebaseServerFirestore();
  if (!db) return;

  try {
    const { doc, deleteDoc } = await import("firebase/firestore");
    await deleteDoc(doc(db, "whatsapp_sessions", safeUserId));
    logger.info(`Deleted WhatsApp session from Firestore for user ${safeUserId}`);
  } catch (err) {
    logger.warn(`Could not delete WhatsApp session from Firestore for user ${safeUserId}`, err.message);
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

  // Persistent Heartbeat to keep WhatsApp bot socket live forever (even when tab/phone is closed)
  let heartbeatTimer = null;
  function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(async () => {
      if (intentionalDisconnect || state === "logged_out" || state === "expired") return;
      if (sock && state === "connected") {
        try {
          await sock.sendPresenceUpdate("available").catch(() => {});
        } catch (err) {
          logger.debug("Heartbeat presence update notice", err?.message);
        }
      } else if (hasSavedSession() && state !== "connecting" && state !== "pairing") {
        logger.info(`[Heartbeat] Resuming persistent WhatsApp session for ${userId}`);
        ensureConnected().catch(() => {});
      }
    }, 20000);
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
    if (state === "connected") {
      step = 6;
      label = "Bot Online & Syncing Active";
    } else if (state === "pairing" || pairingCode) {
      if (step < 1) step = 1;
      if (step === 1) label = "Pairing code generated & dropped to phone";
    } else if (state === "connecting") {
      if (sessionRegistered) {
        step = Math.max(step, 4);
        label = step >= 5 ? "Opening live WhatsApp session..." : "Syncing authenticated keys...";
      } else {
        step = Math.max(step, 2);
        label = "Negotiating connection handshake...";
      }
    } else if (state === "idle" || state === "logged_out" || state === "disconnected") {
      if (state !== "connected") {
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
    return {
      status: state,
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
  function shouldHandleGroupAction(key) {
    if (!key) return true;
    if (processedGroupActions.has(key)) return false;
    processedGroupActions.add(key);
    setTimeout(() => processedGroupActions.delete(key), 45000);
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

    // 1. Delete offending message immediately if bot is admin
    if (deleteMessage && message?.key?.remoteJid === chatId) {
      if (botIsAdmin) {
        await sock.sendMessage(chatId, { delete: message.key }).catch((error) => {
          logger.debug?.("Could not delete anti-protection message", error.message);
        });
      }
    }

    // 2. Issue unified warning stored in Firestore & local database
    const targetClean = target.split("@")[0].split(":")[0];
    const warnResult = await addWarning(chatId, target, userId, reason);
    const mentions = [target];

    if (warnResult.exceeded) {
      if (botIsAdmin) {
        try {
          await sock.groupParticipantsUpdate(chatId, [target], "remove");
          await sock.sendMessage(chatId, {
            text: `🚨 *Warning Threshold Reached:* @${targetClean} reached *${warnResult.count}/${warnResult.limit}* warnings (*${reason}*) and was removed from the group.`,
            mentions,
          });
          return true;
        } catch (removeErr) {
          await sock.sendMessage(chatId, {
            text: `⚠️ @${targetClean} reached *${warnResult.count}/${warnResult.limit}* warnings (*${reason}*), but could not be removed: ${removeErr.message}`,
            mentions,
          });
          return true;
        }
      } else {
        await sock.sendMessage(chatId, {
          text: `⚠️ @${targetClean} reached *${warnResult.count}/${warnResult.limit}* warnings (*${reason}*). _(Bot requires admin privileges to remove members)_`,
          mentions,
        });
        return true;
      }
    }

    // Strike count within limit -> Issue warning alert
    await sock.sendMessage(chatId, {
      text: `⚠️ *Rule Violation:* @${targetClean} has received a warning (*${warnResult.count}/${warnResult.limit}*) for *${reason}*.\n_Your message was deleted. Reaching ${warnResult.limit} warnings will result in removal._`,
      mentions,
    });
    return true;
  }

  async function processMessage(message) {
    if (!sock || !message.message) return;
    const chatId = message.key?.remoteJid;
    if (!chatId) return;

    // Ignore bot's own generated messages (DDD notifications, command responses, etc.)
    if (message.key?.id && botSentMessageIds.has(message.key.id)) {
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
      await handleDeletedMessage(userId, { targetKey, rawMessage: message, protocolMessage: protocolMsg }, sock, botSentMessageIds);
      return;
    }
    recordIncomingMessage(userId, message, sock, Boolean(message.key.fromMe));

    const senderJids = messageSenderJids(message, chatId);
    const credsMe = sock.authState?.creds?.me || {};
    const ownJids = [
      sock.user?.id,
      sock.user?.lid,
      sock.user?.phoneNumber,
      credsMe.id,
      credsMe.lid,
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
          groupMeta = await sock.groupMetadata(chatId);
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

      // STRICT OWNER-ONLY COMMAND RESTRICTION:
      // Commands can ONLY be triggered and executed by the linked account / owner of this bot.
      // One bot for one person: nobody else can command, trigger, or control another user's bot.
      if (!senderIsLinkedAccount && isGroup(chatId)) {
        try {
          const meta = groupMeta || await sock.groupMetadata(chatId);
          const senderAliasSet = new Set([sender, ...senderJids].flatMap(jidAliases));
          const matchedParticipant = (meta?.participants || []).find((p) =>
            [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).flatMap(jidAliases).some((a) => senderAliasSet.has(a))
          );
          if (matchedParticipant) {
            const partAliases = [matchedParticipant.id, matchedParticipant.lid, matchedParticipant.phoneNumber, matchedParticipant.jid]
              .filter(Boolean)
              .flatMap(jidAliases);
            if (partAliases.some((a) => ownAliases.has(a))) {
              senderIsLinkedAccount = true;
            }
          }
        } catch {}
      }
      if (!senderIsLinkedAccount) {
        return;
      }

      // FAST RESPONSE SYSTEM:
      // 1. Immediately send the configured processing reaction before expensive operations
      await sock.sendMessage(chatId, {
        react: { text: "⏳", key: message.key },
      }).catch(() => {});

      await sock.sendPresenceUpdate("composing", chatId).catch(() => {});

      const reply = (body, options = {}) => {
        if (typeof body === "string") {
          return sock.sendMessage(chatId, { text: body, ...options });
        }
        return sock.sendMessage(chatId, { ...body, ...options });
      };

      try {
        await handler({
          sock,
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
        await sock.sendMessage(chatId, {
          react: { text: "✅", key: message.key },
        }).catch(() => {});
      } catch (err) {
        // Set error reaction without crashing
        await sock.sendMessage(chatId, {
          react: { text: "❌", key: message.key },
        }).catch(() => {});
        throw err;
      } finally {
        await sock.sendPresenceUpdate("paused", chatId).catch(() => {});
      }
    } catch (error) {
      logger.error(`Message processing failed for command .${text}`, error.stack || error.message);
      const messageText = String(error.message || "");
      if (isCommand(text)) {
        const { command } = parseCommand(text);
        const reply = (body, options = {}) => sock.sendMessage(chatId, { text: body, ...options });
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
      for (const message of messages) {
        messageQueue.add(message.key?.remoteJid, () => processMessage(message)).catch((error) => {
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
        const { id: rawGroupId, participants, action } = event || {};
        if (!rawGroupId || !Array.isArray(participants) || participants.length === 0) return;

        const groupId = String(rawGroupId).split("@")[0].split(":")[0] + "@g.us";
        const settings = await getGroupSettings(groupId, userId);
        if (!settings.welcome && !settings.goodbye) return;

        const validParticipants = participants.filter(Boolean);
        if (validParticipants.length === 0) return;

        // Dedup by action + group + sorted participants to prevent rapid duplicate event triggers
        const sortedParts = [...validParticipants].sort().join(",");
        const dedupKey = `event:${action}:${groupId}:${sortedParts}`;
        if (!shouldHandleGroupAction(dedupKey)) return;

        const mentionList = validParticipants.map(normalizedUser);
        const mentionTags = validParticipants
          .map((p) => `@${participantNumber(p)}`)
          .join(", ");

        if (action === "add" && settings.welcome) {
          let metadata = null;
          try { metadata = await sock.groupMetadata(groupId).catch(() => null); } catch {}
          const groupName = metadata?.subject || "the group";

          // Short-form friendly greeting for all joined members together (even if 20 are added at once)
          const text = validParticipants.length === 1
            ? `🎉 *Welcome to ${groupName}!* ${mentionTags}\n_Please read group guidelines and feel at home!_`
            : `🎉 *Welcome to ${groupName}!* ${mentionTags}\n_Welcome to all new members! Please check group rules and feel at home!_`;

          await sock.sendMessage(groupId, {
            text,
            mentions: mentionList,
          }).catch((err) => {
            logger.warn("Could not send welcome message", err?.message);
          });
        } else if ((action === "remove" || action === "leave") && settings.goodbye) {
          // Short-form farewell for all departed/kicked/warned members together
          const text = validParticipants.length === 1
            ? `👋 *Goodbye* ${mentionTags}. _We wish you all the best!_`
            : `👋 *Goodbye* ${mentionTags}. _Wishing you all the best!_`;

          await sock.sendMessage(groupId, {
            text,
            mentions: mentionList,
          }).catch((err) => {
            logger.warn("Could not send goodbye message", err?.message);
          });
        }
      } catch (err) {
        logger.debug?.("group-participants.update notice", err.message);
      }
    });
    sock.ev.on("connection.update", ({ connection, lastDisconnect, qr, isNewLogin }) => {
      // Wait for Baileys' initial pair-device signal rather than only the
      // WebSocket opening. The latter can happen before the Noise handshake
      // is ready, which makes WhatsApp reject an otherwise valid code request.
      if (qr || connection === "open" || (connection === "connecting" && nextSocket.ws?.isOpen)) {
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
          return syncSessionToFirestore(userId, userSessionDir);
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
        Promise.resolve(saveCreds()).then(() => syncSessionToFirestore(userId, userSessionDir)).catch(() => {});

        // Verify permanent WhatsApp number lock
        if (botNumber && verifiedUid) {
          const currentUid = verifiedUid;
          const currentEmail = userEmail;
          checkNumberLock(botNumber, currentUid).then((lockCheck) => {
            if (!lockCheck.allowed) {
              logger.warn(`Rejecting WhatsApp connection for ${botNumber}: ${lockCheck.message}`);
              intentionalDisconnect = true;
              try { nextSocket.ws?.close(); } catch {}
              sock = null;
              state = "error";
              lastError = lockCheck.message;
              lastErrorCode = lockCheck.reason;
            } else {
              lockNumberToUser(botNumber, currentUid, currentEmail).catch((err) => {
                logger.error("Failed to store number lock", err.message);
              });
            }
          }).catch((err) => {
            logger.error("Number lock check error", err.message);
          });
        }
      }
      if (connection === "connecting") state = "connecting";
      if (connection === "close") {
        stopAllSpamTasks();
        if (sock !== nextSocket) return;
        const errorInfo = describeSocketError(lastDisconnect?.error);
        const wasIntentional = intentionalDisconnect;
        const isLoggedOut = errorInfo.code === DisconnectReason.loggedOut || errorInfo.code === 401;
        const isRestartRequired = errorInfo.code === DisconnectReason.restartRequired || errorInfo.code === 515;
        if (isRestartRequired || hasValidCreds(nextSocket.authState?.creds)) {
          sessionRegistered = true;
        }
        const pairingFailed = !isRestartRequired && !sessionRegistered && (state === "pairing" || Boolean(pairingRequest));
        const shouldReconnect = !wasIntentional
          && !isLoggedOut
          && (isRestartRequired || sessionRegistered || hasSavedSession() || !pairingFailed);

        if (isLoggedOut) {
          state = "logged_out";
          lastError = "WhatsApp session logged out from phone. Please request a new pairing code.";
          lastErrorCode = "LOGGED_OUT";
          sessionRegistered = false;
          // Clear invalid session credentials on genuine WhatsApp logout
          fs.rm(userSessionDir, { recursive: true, force: true }).catch(() => {});
          deleteSessionFromFirestore(userId).catch(() => {});
        } else {
          state = wasIntentional ? "idle" : pairingFailed ? "error" : "connecting";
        }

        if (isRestartRequired) {
          state = "connecting";
          pairingCode = "";
          pairingExpiresAt = 0;
          pairingNumber = "";
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
        sock = null;
        if (shouldReconnect) {
          reconnectAttempt = isRestartRequired ? 0 : reconnectAttempt + 1;
          const delay = isRestartRequired ? 500 : Math.min(15000, 1000 * Math.min(reconnectAttempt, 10));
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
    if (sock) return sock;
    intentionalDisconnect = false;
    connecting = (async () => {
      await pendingCredsSave.catch(() => {});
      await fs.mkdir(userSessionDir, { recursive: true });
      await restoreSessionFromFirestore(userId, userSessionDir);
      const { state: authState, saveCreds } = await useMultiFileAuthState(userSessionDir);
      let version;
      try {
        const latest = await fetchLatestBaileysVersion();
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
        retryRequestDelayMs: 500,
        markOnlineOnConnect: true,
        fireInitQueries: true,
        auth: {
          creds: authState.creds,
          keys: makeCacheableSignalKeyStore(authState.keys, pino({ level: "silent" })),
        },
        getMessage: async () => undefined,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        // WhatsApp's pairing-code validator expects a canonical browser label.
        // "Desktop" works for ordinary logins but can be rejected at pairing.
        browser: Browsers.macOS("Chrome"),
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
    const lockCheck = await checkNumberLock(phone, verifiedUid);
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

    // Clean up any previous stale socket or old non-connected registration files
    await disconnect();
    intentionalDisconnect = false;

    let trackedRequest;
    const request = (async () => {
      try {
        const ready = beginPairingReadyWait();
        const candidate = await connect();
        if (!candidate || candidate !== sock) throw new Error("WhatsApp connection closed before pairing.");
        if (candidate.ws?.isOpen) resolvePairingReady();
        await ready;
        if (candidate !== sock || !candidate.ws?.isOpen) {
          throw new Error("WhatsApp pairing socket closed before the pairing request was sent.");
        }

        let code;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await new Promise((r) => setTimeout(r, attempt === 0 ? 600 : 1500));
            if (candidate !== sock || !candidate.ws?.isOpen) {
              throw new Error("WhatsApp pairing socket closed before pairing request could be completed.");
            }
            code = await candidate.requestPairingCode(phone);
            if (code) break;
          } catch (err) {
            if (attempt === 2) throw err;
            logger.warn(`Pairing code attempt ${attempt + 1} retry:`, err.message);
          }
        }
        if (!code) throw new Error("Could not retrieve pairing code from WhatsApp. Please try again in a few seconds.");

        pairingCode = code;
        pairingExpiresAt = Date.now() + PAIRING_TTL_MS;
        pairingNumber = phone;
        state = "pairing";
        lastError = "";
        lastErrorCode = null;
        setSyncStep(1, "Pairing code generated & dropped to phone");
        logger.info("Real WhatsApp pairing code generated", `for ${phone}; socket remains active`);
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
    await deleteSessionFromFirestore(userId);
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
    await restoreSessionFromFirestore(userId, userSessionDir);
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
    return connect();
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

    // 2. Scan Firestore for saved sessions (survives full Railway volume wipes)
    const db = getFirebaseServerFirestore();
    if (db) {
      try {
        const { collection, getDocs } = await import("firebase/firestore");
        const snap = await getDocs(collection(db, "whatsapp_sessions"));
        snap.forEach((docSnap) => {
          if (docSnap.id) uidsToRestore.add(docSnap.id);
        });
      } catch (err) {
        logger.debug("Firestore session scan notice during auto-restore", err.message);
      }
    }

    let restoredCount = 0;
    for (const userId of uidsToRestore) {
      const userSessionDir = path.join(SESSION_DIR, userId);
      try {
        await restoreSessionFromFirestore(userId, userSessionDir);
        const credsFile = path.join(userSessionDir, "creds.json");
        if (fsSync.existsSync(credsFile)) {
          const controller = getWhatsAppController(userId, { verifiedUid: userId });
          const licenseStatus = await getUserLicenseStatus(userId);
          if (licenseStatus.hasActiveLicense) {
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
    if (st.status === "connected" || st.status === "connecting" || st.status === "pairing") {
      try {
        const licenseStatus = await getUserLicenseStatus(verifiedUid, userEmail);
        if (!licenseStatus.hasActiveLicense) {
          logger.warn(`Stopping active WhatsApp session for user ${verifiedUid}: License expired.`);
          await controller.stopForExpiry();
        }
      } catch (err) {
        logger.debug("License audit notice", err.message);
      }
    } else if ((st.status === "disconnected" || st.status === "idle") && controller.hasSavedSession()) {
      try {
        const licenseStatus = await getUserLicenseStatus(verifiedUid, userEmail);
        if (licenseStatus.hasActiveLicense) {
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
