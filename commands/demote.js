import { requireAdmin, findTarget, targetIsOwner } from "../lib/command-tools.js";

export default async function demote({ sock, chatId, sender, senderJids, senderIsLinkedAccount, message, reply }) {
  const metadata = await requireAdmin(sock, chatId, sender, true, senderJids, senderIsLinkedAccount);
  const target = findTarget(message);
  if (!target) return reply("❌ Please mention a user.");
  if (targetIsOwner(metadata, target)) return reply("❌ I cannot demote the group owner.");
  await sock.groupParticipantsUpdate(chatId, [target], "demote");
  await reply(`✅ Demoted @${target.split("@")[0]}.`, { mentions: [target] });
}