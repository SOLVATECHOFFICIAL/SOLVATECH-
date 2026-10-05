import { clearWarning, getGroupSettings, resetWarnings } from "../lib/database.js";
import { requireAdmin } from "../lib/command-tools.js";
import { resolveGroupTargetJids } from "../lib/permissions.js";

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
  const metadata = await requireAdmin(sock, chatId, sender, false, senderJids, senderIsLinkedAccount);

  const firstArg = String(args[0] || "").toLowerCase();
  if (firstArg === "all" || firstArg === "*") {
    await resetWarnings(chatId, userId);
    return reply([
      "╭━━〔 🔄 *GROUP WARNINGS CLEARED* 〕━━╮",
      "",
      "┃ 🟢 *All active member warnings have been cleared.*",
      "┃ 📊 *Status:* _Clean group slate_",
      "",
      "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
    ].join("\n"));
  }

  const resolved = resolveGroupTargetJids(metadata, message, args);
  if (!resolved || !resolved.canonicalJid) {
    return reply(
      "❌ *Target Missing:* Please tag (@user), reply to a message, or provide the phone number of the member whose warnings you wish to clear.\n" +
      "_Usage: *.clearwarns @user* or *.clearwarns all*_"
    );
  }

  // Gather all possible aliases for this participant from metadata (LID, JID, phone number)
  const targetClean = String(resolved.canonicalJid).split("@")[0].split(":")[0].replace(/\D/g, "");
  const allParticipantAliases = new Set(resolved.allJids || []);
  allParticipantAliases.add(resolved.canonicalJid);
  if (resolved.mentionJid) allParticipantAliases.add(resolved.mentionJid);

  if (metadata && Array.isArray(metadata.participants)) {
    for (const p of metadata.participants) {
      const pAliases = [p.id, p.jid, p.lid, p.phoneNumber].filter(Boolean);
      const hasMatch = pAliases.some((a) => {
        const d = String(a).split("@")[0].split(":")[0].replace(/\D/g, "");
        return (targetClean && d && d === targetClean) || allParticipantAliases.has(a);
      });
      if (hasMatch) {
        pAliases.forEach((a) => allParticipantAliases.add(a));
      }
    }
  }

  await clearWarning(chatId, [...allParticipantAliases], userId);
  const settings = await getGroupSettings(chatId, userId);
  const limit = settings.warningLimit || 3;
  const num = resolved.canonicalJid.split("@")[0].split(":")[0];
  const mentions = [...new Set([resolved.canonicalJid, resolved.mentionJid].filter(Boolean))];

  await reply(`✅ *Warnings Cleared:* @${num} is now at *0/${limit}* warnings.\n_Record cleared and synchronized to cloud._`, { mentions });
}
