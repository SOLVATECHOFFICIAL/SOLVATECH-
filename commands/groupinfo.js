import { isGroup } from "../lib/helpers.js";

export default async function groupinfo({ sock, chatId, reply }) {
  if (!isGroup(chatId)) {
    return reply("❌ This command only works inside a WhatsApp group.");
  }

  try {
    const metadata = await sock.groupMetadata(chatId);
    if (!metadata) {
      return reply("❌ Could not retrieve group metadata.");
    }

    const participants = metadata.participants || [];
    const admins = participants.filter((p) => p.admin === "admin" || p.admin === "superadmin" || p.admin === true);
    const superAdmins = participants.filter((p) => p.admin === "superadmin");
    const regularMembers = participants.filter((p) => !p.admin);

    const ownerJid = metadata.owner || metadata.ownerPn || metadata.subjectOwner || "";
    const ownerDisplay = ownerJid ? `@${ownerJid.split("@")[0].split(":")[0]}` : "Unavailable";

    let creationDateStr = "Unavailable";
    if (metadata.creation) {
      const creationMs = Number(metadata.creation) * 1000;
      if (!isNaN(creationMs) && creationMs > 0) {
        creationDateStr = new Date(creationMs).toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
      }
    }

    const isAnnounce = Boolean(metadata.announce);
    const isRestricted = Boolean(metadata.restrict);
    const ephemeralDuration = metadata.ephemeralDuration
      ? `${Math.round(metadata.ephemeralDuration / 86400)} day(s)`
      : "Off";

    const adminMentions = admins.map((a) => a.id).filter(Boolean);
    const allMentions = ownerJid ? [ownerJid, ...adminMentions] : adminMentions;

    const lines = [
      `╭━━〔 👥 *${metadata.subject || "GROUP INFO"}* 〕━━╮`,
      `┃ 🏷️ *Group ID:* ${chatId}`,
      `┃ 👑 *Creator / Owner:* ${ownerDisplay}`,
      `┃ 📅 *Created On:* ${creationDateStr}`,
      `┃ 👥 *Total Members:* ${participants.length}`,
      `┃ ⭐ *Admins:* ${admins.length} (${superAdmins.length} superadmin)`,
      `┃ 👤 *Regular Members:* ${regularMembers.length}`,
      `┃ 🔒 *Messaging:* ${isAnnounce ? "Admins Only" : "All Members"}`,
      `┃ ⚙️ *Edit Group Info:* ${isRestricted ? "Admins Only" : "All Members"}`,
      `┃ ⏳ *Disappearing Messages:* ${ephemeralDuration}`,
      "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
    ];

    if (metadata.desc) {
      const cleanDesc = String(metadata.desc).trim();
      if (cleanDesc) {
        lines.push("", `📝 *Group Description:*`, cleanDesc.length > 300 ? `${cleanDesc.slice(0, 300)}...` : cleanDesc);
      }
    }

    await reply(lines.join("\n"), {
      mentions: [...new Set(allMentions)],
    });
  } catch (error) {
    await reply(`❌ Could not fetch group info: ${error.message || "Unknown error"}`);
  }
}
