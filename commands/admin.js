import { isGroup, mentionText } from "../lib/helpers.js";

export default async function admin({ sock, chatId, reply }) {
  if (!isGroup(chatId)) {
    return reply("❌ This command only works in groups.");
  }
  const metadata = await sock.groupMetadata(chatId);
  const adminParticipants = (metadata.participants || []).filter((p) => p.admin);

  if (!adminParticipants.length) {
    return reply("ℹ️ No admins found in this group.");
  }

  const mentions = adminParticipants.map((p) => p.id);
  const listText = adminParticipants
    .map((p, idx) => `${idx + 1}. ${mentionText(p.id)} ${p.admin === "superadmin" ? "👑 (Owner)" : "⭐ (Admin)"}`)
    .join("\n");

  const message = [
    `🛡️ *GROUP ADMINS (${adminParticipants.length})*`,
    `Group: *${metadata.subject}*`,
    "",
    listText,
  ].join("\n");

  await reply(message, { mentions });
}
