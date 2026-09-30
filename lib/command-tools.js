import { getGroupSettings, setGroupSetting } from "./database.js";
import { groupMentions, mentionText, normalizedUser } from "./helpers.js";
import { assertAdmin, isAdmin, isBotAdmin, isOwner, targetFromMessage } from "./permissions.js";

export async function getGroup(sock, chatId, sender) {
  const metadata = await sock.groupMetadata(chatId);
  return { metadata, sender };
}

export async function requireAdmin(sock, chatId, sender, botRequired = false, senderAliases = [], isBotOwner = false) {
  const { metadata } = await getGroup(sock, chatId, sender);
  const botJid = [
    sock.user?.id,
    sock.user?.lid,
    sock.user?.phoneNumber,
  ].filter(Boolean).map(normalizedUser);

  if (isBotOwner) {
    if (botRequired && !isBotAdmin(metadata, botJid)) {
      throw new Error("❌ I need to be a group admin.");
    }
    return metadata;
  }

  assertAdmin(metadata, [sender, ...senderAliases], botRequired, botJid);
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