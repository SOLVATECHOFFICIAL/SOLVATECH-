import { requireAdmin } from "../lib/command-tools.js";
import { isAdmin, isOwner, resolveGroupTargetJids } from "../lib/permissions.js";

export default async function kick({ sock, chatId, sender, senderJids, senderIsLinkedAccount, args = [], message, reply }) {
  const metadata = await requireAdmin(sock, chatId, sender, true, senderJids, senderIsLinkedAccount);
  const resolved = resolveGroupTargetJids(metadata, message, args);
  if (!resolved || !resolved.canonicalJid) {
    return reply("❌ Please tag, reply to, or provide the phone number of the user to remove.");
  }
  if (isAdmin(metadata, resolved.allJids) || isOwner(metadata, resolved.allJids)) {
    return reply("❌ I cannot kick a group admin or owner.");
  }
  const target = resolved.canonicalJid;
  const mentions = [...new Set([target, resolved.mentionJid].filter(Boolean))];
  await sock.groupParticipantsUpdate(chatId, [target], "remove");
  await reply(`✅ Removed @${resolved.targetClean || target.split("@")[0].split(":")[0]}.`, { mentions });
}