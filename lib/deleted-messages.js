import { downloadMediaMessage, jidNormalizedUser } from "@whiskeysockets/baileys";
import { getMessageContent, getMessageText, isGroup, jidAliases, mediaTypeFromMessage, participantNumber, unwrapMediaMessage } from "./helpers.js";
import { logger } from "./logger.js";
import { getFirebaseServerFirestore } from "./auth.js";
import { getUserPreferences } from "./database.js";

async function syncDeletedMessageToFirestore(userId, record) {
  const db = getFirebaseServerFirestore();
  if (!db || !record) return;
  try {
    const { doc, setDoc } = await import("firebase/firestore");
    const docId = `${userId}_${record.id}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    await setDoc(doc(db, "deleted_messages", docId), {
      userId,
      originalId: record.id,
      remoteJid: record.remoteJid,
      sender: record.sender,
      text: record.text || "",
      mediaType: record.mediaType || null,
      deletedAt: record.deletedAt || Date.now(),
      originalTimestamp: record.originalTimestamp || Date.now(),
      updatedAt: new Date().toISOString(),
    }, { merge: true });
  } catch (err) {
    logger.debug(`Could not sync deleted message metadata to Firestore for user ${userId}`, err.message);
  }
}

const TTL_24_HOURS_MS = 24 * 60 * 60 * 1000;

// Scoped per userId: Map<userId, { messages: Map<string, CachedMessage>, deleted: Map<string, DeletedMessage>, recentDddAlerts: Map<string, string>, handledDeletedIds: Map<string, number> }>
const userStores = new Map();

function getStore(userId = "default") {
  if (!userStores.has(userId)) {
    userStores.set(userId, {
      messages: new Map(), // key: id -> cached message
      deleted: new Map(),  // key: id -> deleted message record
      recentDddAlerts: new Map(), // key: alertMessageId -> originalDeletedId
      handledDeletedIds: new Map(), // key: deletedId -> timestamp
    });
  }
  return userStores.get(userId);
}

function pruneStore(store) {
  const cutoff = Date.now() - TTL_24_HOURS_MS;
  for (const [id, msg] of store.messages.entries()) {
    if (msg.timestamp < cutoff) {
      store.messages.delete(id);
    }
  }
  for (const [id, del] of store.deleted.entries()) {
    if (del.deletedAt < cutoff) {
      store.deleted.delete(id);
    }
  }
  if (store.handledDeletedIds) {
    for (const [id, time] of store.handledDeletedIds.entries()) {
      if (time < cutoff) {
        store.handledDeletedIds.delete(id);
      }
    }
  }

  // Bounded Memory Cap: Enforce max 300 cached messages per store to prevent OOM
  if (store.messages.size > 300) {
    const overflowCount = store.messages.size - 300;
    const keys = store.messages.keys();
    for (let i = 0; i < overflowCount; i++) {
      const firstKey = keys.next().value;
      if (firstKey) store.messages.delete(firstKey);
    }
  }
}

function isOwnIdentity(jid, sock) {
  if (!jid || !sock?.user) return false;
  const ownJids = [
    sock.user.id,
    sock.user.lid,
    sock.user.phoneNumber,
    sock.user.name,
  ].filter(Boolean);
  const ownAliases = new Set(ownJids.flatMap(jidAliases));
  return jidAliases(jid).some((alias) => ownAliases.has(alias));
}

/**
 * Cache an incoming message metadata for up to 24 hours.
 * Strictly ignores bot's own messages.
 * Note: Media is downloaded ON DEMAND when a message is deleted or requested,
 * avoiding pre-buffering heavy media into RAM.
 */
export function recordIncomingMessage(userId, rawMessage, sock, isOwnMessage = false) {
  if (!rawMessage?.key?.id) return;
  if (rawMessage.key.fromMe || isOwnMessage) return;

  const key = rawMessage.key;
  const id = key.id;
  const remoteJid = key.remoteJid || "";
  const sender = key.participant || rawMessage.participant || remoteJid;

  if (isOwnIdentity(sender, sock)) return;

  const store = getStore(userId);
  pruneStore(store);

  const text = getMessageText(rawMessage);
  const content = getMessageContent(rawMessage);
  const mediaType = mediaTypeFromMessage(rawMessage);

  const entry = {
    id,
    remoteJid,
    sender,
    key,
    text,
    content,
    rawMessage,
    mediaType,
    fromMe: false,
    timestamp: (Number(rawMessage.messageTimestamp) * 1000) || Date.now(),
    mediaBuffer: null,
  };

  store.messages.set(id, entry);
}

/**
 * On-demand helper to download media buffer for a cached or deleted message when requested.
 */
export async function ensureMediaDownloaded(record, sock) {
  if (!record) return null;
  if (record.mediaBuffer) return record.mediaBuffer;
  if (!record.mediaType || !record.rawMessage || !sock) return null;

  try {
    const buf = await downloadMediaMessage(record.rawMessage, "buffer", {}, {
      logger: sock.logger,
      reuploadRequest: sock.updateMediaMessage,
    });
    if (buf && buf.length > 0) {
      record.mediaBuffer = buf;
      return buf;
    }
  } catch (err) {
    logger.debug(`On-demand media download failed for message ${record.id}: ${err.message}`);
  }
  return null;
}

/**
 * Retrieve a cached incoming message by its ID for a user session.
 * Used for instant view-once recovery and quoted media lookups.
 */
export function getCachedIncomingMessage(userId, messageId) {
  if (!messageId) return null;
  const store = getStore(userId);
  return store.messages.get(messageId) || null;
}

/**
 * Handle a protocol revoke message (DDD - Deleted Message Detected).
 * Works in BOTH groups and 1-to-1/private chats.
 * Strictly ignores bot's own deleted messages.
 */
export async function handleDeletedMessage(userId, payload, sock, botSentMessageIds = null) {
  if (!payload || !sock) return null;

  // Extract key information whether payload is a wrapped object, raw protocol message, or update
  const targetKey = payload.targetKey ||
    payload.protocolMessage?.key ||
    payload.update?.protocolMessage?.key ||
    payload.key ||
    payload;

  const originalId = targetKey?.id || payload.protocolMessage?.key?.id || payload.id;
  if (!originalId) return null;

  // 1. NEVER reply to or store bot's own deleted messages
  if (targetKey.fromMe) return null;
  if (botSentMessageIds?.has(originalId)) return null;
  if (targetKey.participant && isOwnIdentity(targetKey.participant, sock)) return null;

  const store = getStore(userId);
  pruneStore(store);

  // Deduplication: Avoid double-firing if both messages.upsert and messages.update deliver the event
  if (store.handledDeletedIds.has(originalId)) {
    return store.deleted.get(originalId) || null;
  }

  const original = store.messages.get(originalId);

  // If original was marked fromMe or sent by bot, ignore completely
  if (original?.fromMe || original?.rawMessage?.key?.fromMe) {
    store.handledDeletedIds.set(originalId, Date.now());
    return null;
  }
  if (original?.sender && isOwnIdentity(original.sender, sock)) {
    store.handledDeletedIds.set(originalId, Date.now());
    return null;
  }

  const remoteJid = targetKey.remoteJid || original?.remoteJid || payload.remoteJid || payload.chatId || "";
  if (!remoteJid) {
    logger.warn(`Could not determine remoteJid for deleted message ${originalId}`);
    return null;
  }

  // If chat is a 1-to-1 self chat with bot, ignore
  if (!isGroup(remoteJid) && isOwnIdentity(remoteJid, sock)) {
    store.handledDeletedIds.set(originalId, Date.now());
    return null;
  }

  const sender = targetKey.participant || original?.sender || (isGroup(remoteJid) ? "" : remoteJid);

  // If sender matches bot's own WhatsApp identity, ignore completely
  if (sender && isOwnIdentity(sender, sock)) {
    store.handledDeletedIds.set(originalId, Date.now());
    return null;
  }

  const record = {
    id: originalId,
    key: {
      id: originalId,
      remoteJid,
      participant: sender,
      fromMe: false,
    },
    remoteJid,
    sender: sender || remoteJid,
    text: original?.text || "",
    mediaType: original?.mediaType || null,
    mediaBuffer: original?.mediaBuffer || null,
    rawMessage: original?.rawMessage || null,
    content: original?.content || null,
    deletedAt: Date.now(),
    originalTimestamp: original?.timestamp || Date.now(),
  };

  store.deleted.set(originalId, record);
  store.handledDeletedIds.set(originalId, Date.now());

  // Sync deleted message record to Firestore (Permanent Source of Truth)
  syncDeletedMessageToFirestore(userId, record);

  // Automatic forwarding directly to owner's personal WhatsApp DM (Zero trace in group)
  try {
    const prefs = await getUserPreferences(userId);
    if (prefs.autoDeletedToDm !== false) {
      const ownerJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : (sock.user?.phoneNumber ? `${sock.user.phoneNumber}@s.whatsapp.net` : "");
      if (ownerJid) {
        let groupName = "";
        if (isGroup(remoteJid)) {
          try {
            const meta = await sock.groupMetadata(remoteJid);
            if (meta?.subject) groupName = meta.subject;
          } catch {}
        }

        const senderPhone = sender ? participantNumber(sender) : "Unknown Member";
        const locationStr = isGroup(remoteJid) ? (groupName || "WhatsApp Group") : "Private DM";
        const timeStr = new Date(record.originalTimestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

        if (record.mediaType && record.rawMessage) {
          const buffer = await ensureMediaDownloaded(record, sock);
          const caption = [
            `🗑️ *DELETED ${record.mediaType.toUpperCase()} RECOVERED*`,
            `👤 *Sender:* @${senderPhone}`,
            `📍 *Source:* ${locationStr}`,
            `🕒 *Original Time:* ${timeStr}`,
            record.text ? `💬 *Caption:* ${record.text}` : "",
          ].filter(Boolean).join("\n");

          if (buffer && buffer.length > 0) {
            let payload = {};
            if (record.mediaType === "image") payload = { image: buffer, caption, mentions: [sender].filter(Boolean) };
            else if (record.mediaType === "video") payload = { video: buffer, caption, mentions: [sender].filter(Boolean) };
            else if (record.mediaType === "audio") payload = { audio: buffer, mimetype: "audio/mp4", caption, mentions: [sender].filter(Boolean) };
            else if (record.mediaType === "sticker") payload = { sticker: buffer };
            else payload = { document: buffer, mimetype: "application/octet-stream", fileName: "deleted-file", caption, mentions: [sender].filter(Boolean) };

            await sock.sendMessage(ownerJid, payload);
          } else {
            await sock.sendMessage(ownerJid, {
              text: `${caption}\n⚠️ _(Media could not be downloaded before deletion)_`,
              mentions: [sender].filter(Boolean),
            });
          }
        } else if (record.text) {
          const body = [
            `🗑️ *DELETED MESSAGE RECOVERED*`,
            `👤 *Sender:* @${senderPhone}`,
            `📍 *Source:* ${locationStr}`,
            `🕒 *Original Time:* ${timeStr}`,
            ``,
            `💬 *Message:*`,
            record.text,
          ].join("\n");

          await sock.sendMessage(ownerJid, {
            text: body,
            mentions: [sender].filter(Boolean),
          });
        }
      }
    }
  } catch (error) {
    logger.warn("Could not forward deleted message to owner DM", error.message);
  }

  return record;
}

/**
 * Retrieve a deleted message for restoration (.rd).
 * Strictly isolated by userId and chat (groups & private chats).
 */
export function getDeletedMessageForRestore(userId, chatId, quotedStanzaId = null) {
  const store = getStore(userId);
  pruneStore(store);

  // 1. If user replied to a DDD alert or deleted message ID
  if (quotedStanzaId) {
    if (store.recentDddAlerts.has(quotedStanzaId)) {
      const origId = store.recentDddAlerts.get(quotedStanzaId);
      const rec = store.deleted.get(origId) || store.messages.get(origId);
      if (rec && (!chatId || rec.remoteJid === chatId)) return rec;
    }
    if (store.deleted.has(quotedStanzaId)) {
      const rec = store.deleted.get(quotedStanzaId);
      if (rec && (!chatId || rec.remoteJid === chatId)) return rec;
    }
    if (store.messages.has(quotedStanzaId)) {
      const rec = store.messages.get(quotedStanzaId);
      if (rec && (!chatId || rec.remoteJid === chatId)) return rec;
    }
  }

  // 2. Otherwise get the most recent deleted message for this chat within 24h
  const candidates = [...store.deleted.values()]
    .filter((item) => (!chatId || item.remoteJid === chatId) && Date.now() - item.deletedAt <= TTL_24_HOURS_MS)
    .sort((a, b) => b.deletedAt - a.deletedAt);

  return candidates[0] || null;
}
