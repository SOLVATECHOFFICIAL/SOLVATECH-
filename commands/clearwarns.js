import { clearWarning, getGroupSettings } from "../lib/database.js";
import { requireAdmin } from "../lib/command-tools.js";
import { assertAdmin, resolveGroupTargetJids } from "../lib/permissions.js";

export default async function clearwarns({
  sock,
  chatId,
  sender,
  senderJids,
  senderIsLinkedAccount,
  args = [],
  message,
  reply,
  userId = "default",
}) {
  const metadata = await requireAdmin(sock, chatId, sender, true, senderJids, senderIsLinkedAccount);
  assertAdmin(metadata, [sender, ...(Array.isArray(senderJids) ? senderJids : [])], true, [
    sock.user?.id,
    sock.user?.lid,
    sock.user?.phoneNumber,
  ].filter(Boolean));

  const resolved = resolveGroupTargetJids(metadata, message, args);
  if (!resolved || !resolved.canonicalJid) {
    return reply("❌ *Target Missing:* Please tag or reply to the member whose warnings you wish to clear.\n_Usage: *.clearwarns @user*_");
  }

  await clearWarning(chatId, resolved.allJids, userId);
  const settings = await getGroupSettings(chatId, userId);
  const limit = settings.warningLimit || 3;
  const num = resolved.canonicalJid.split("@")[0].split(":")[0];
  const mentions = [...new Set([resolved.canonicalJid, resolved.mentionJid].filter(Boolean))];
  await reply(`✅ *Warnings Cleared:* @${num} is now at *0/${limit}* warnings.\n_Record updated and synchronized to Firebase._`, { mentions });
}
