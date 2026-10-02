import { getGroupSettings, setGroupSetting } from "./database.js";
import { groupMentions, isGroup, mentionText, normalizedUser } from "./helpers.js";
import { assertAdmin, isAdmin, isBotAdmin, isOwner, targetFromMessage } from "./permissions.js";

export async function getGroup(sock, chatId, sender) {
  if (!isGroup(chatId)) {
    throw new Error("❌ This command only works in groups.");
  }
  const metadata = await sock.groupMetadata(chatId);
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