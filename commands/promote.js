import { requireAdmin } from "../lib/command-tools.js";
import { resolveGroupTargetJids } from "../lib/permissions.js";

export default async function promote({ sock, chatId, sender, senderJids, senderIsLinkedAccount, args = [], message, reply }) {
  const metadata = await requireAdmin(sock, chatId, sender, true, senderJids, senderIsLinkedAccount);
  const resolved = resolveGroupTargetJids(metadata, message, args);
  if (!resolved || !resolved.canonicalJid) {
    return reply("❌ Please tag, reply to, or provide the phone number of the member to promote.");
  }
  const target = resolved.canonicalJid;
  const mentions = [...new Set([target, resolved.mentionJid].filter(Boolean))];
  await sock.groupParticipantsUpdate(chatId, [target], "promote");
  await reply(`✅ Promoted @${resolved.targetClean || target.split("@")[0].split(":")[0]}.`, { mentions });
}