import { getGroupSettings, setGroupSetting } from "./database.js";
import { groupMentions, isGroup, mentionText, normalizedUser } from "./helpers.js";
import { assertAdmin, isAdmin, isBotAdmin, isOwner, targetFromMessage } from "./permissions.js";

const groupMetaCache = new Map();

export async function getSafeMetadata(sock, chatId) {
  if (!chatId || !isGroup(chatId)) return null;
  const cached = groupMetaCache.get(chatId);
  if (cached && Date.now() - cached.timestamp < 180000) {
    return cached.data;
  }
  try {
    const meta = await sock.groupMetadata(chatId);
    if (meta) {
      groupMetaCache.set(chatId, { timestamp: Date.now(), data: meta });
      return meta;
    }
  } catch (err) {
    // If cached data is available (even older), use it
    if (cached?.data) {
      return cached.data;
    }
    // If connection was interrupted, attempt a brief retry
    if (err?.message?.includes("Connection Closed") || err?.message?.includes("connection closed")) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const retryMeta = await sock.groupMetadata(chatId);
        if (retryMeta) {
          groupMetaCache.set(chatId, { timestamp: Date.now(), data: retryMeta });
          return retryMeta;
        }
      } catch {}
    }
    throw new Error("❌ Group metadata is temporarily unavailable (connection interrupted). Please try again.");
  }
  return cached?.data || null;
}

export async function getGroup(sock, chatId, sender) {
  if (!isGroup(chatId)) {
    throw new Error("❌ This command only works in groups.");
  }
  const metadata = await getSafeMetadata(sock, chatId);
  if (!metadata) {
    throw new Error("❌ Could not retrieve group information. Please try again.");
  }
  return { metadata, sender };
}

export async function requireAdmin(sock, chatId, sender, botRequired = false, senderAliases = [], isBotOwner = false) {
  if (!isBotOwner) {
    throw new Error("❌ Private Bot: Only the linked WhatsApp account owner can execute commands.");
  }
  const { metadata } = await getGroup(sock, chatId, sender);
  const botJid = [
    sock.user?.id,
    sock.user?.lid,
    sock.user?.phoneNumber,
    sock.authState?.creds?.me?.id,
    sock.authState?.creds?.me?.lid,
  ].filter(Boolean).map(normalizedUser);

  if (botRequired && !isBotAdmin(metadata, botJid)) {
    throw new Error("❌ I need to be a group admin.");
  }
  return metadata;
}

export function findTarget(message) {
  return targetFromMessage(message);
}

export function targetIsAdmin(metadata, target) {
  return isAdmin(metadata, target);
}

export function targetIsOwner(metadata, target) {
  return isOwner(metadata, target);
}

export async function toggleGroupSetting(chatId, key, value, userId = "default") {
  return setGroupSetting(chatId, key, value, userId);
}

export async function mentionAdmins(metadata) {
  return groupMentions(metadata.participants.filter((item) => item.admin), "Group admins:");
}

export async function mentionMembers(metadata, message) {
  return groupMentions(metadata.participants, message);
}

export { getGroupSettings, mentionText };