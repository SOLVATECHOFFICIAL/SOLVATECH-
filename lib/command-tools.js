import { getGroupSettings, setGroupSetting } from "./database.js";
import { groupMentions, isGroup, mentionText, normalizedUser } from "./helpers.js";
import { assertAdmin, isAdmin, isBotAdmin, isOwner, targetFromMessage } from "./permissions.js";

const groupMetaCache = new Map();

export async function getSafeMetadata(sock, chatId) {
  if (!chatId || !isGroup(chatId)) return null;
  const cached = groupMetaCache.get(chatId);
  // Return cached metadata instantly with zero network delay
  if (cached && Date.now() - cached.timestamp < 600000) {
    return cached.data;
  }
  if (!sock) return cached?.data || null;

  try {
    let timer = null;
    const meta = await Promise.race([
      sock.groupMetadata(chatId),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 1500);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (meta && meta.id) {
      groupMetaCache.set(chatId, { timestamp: Date.now(), data: meta });
      return meta;
    }
  } catch {}
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
  const { metadata } = await getGroup(sock, chatId, sender);
  const allAliases = [sender, ...(Array.isArray(senderAliases) ? senderAliases : [])];
  const senderIsGroupAdmin = isAdmin(metadata, allAliases);

  if (!isBotOwner && !senderIsGroupAdmin) {
    throw new Error("❌ Only group administrators can execute this command.");
  }
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