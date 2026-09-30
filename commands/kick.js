import { requireAdmin, findTarget, targetIsAdmin, targetIsOwner } from "../lib/command-tools.js";

export default async function kick({ sock, chatId, sender, senderJids, senderIsLinkedAccount, message, reply }) {
  const metadata = await requireAdmin(sock, chatId, sender, true, senderJids, senderIsLinkedAccount);
  const target = findTarget(message);
  if (!target) return reply("❌ Please mention a user.");
  if (targetIsAdmin(metadata, target) || targetIsOwner(metadata, target)) return reply("❌ I cannot kick a group admin or owner.");
  await sock.groupParticipantsUpdate(chatId, [target], "remove");
  await reply(`✅ Removed @${target.split("@")[0]}.`, { mentions: [target] });
}