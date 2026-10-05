import { isGroup } from "../lib/helpers.js";
import { getGroupSettings } from "../lib/database.js";

export default async function groupinfo({ sock, chatId, reply, userId = "default" }) {
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
    const ownerClean = ownerJid ? ownerJid.split("@")[0].split(":")[0] : "";
    const ownerDisplay = ownerClean ? `@${ownerClean}` : "Unavailable";

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

    // Fetch active protection settings
    let protections = null;
    try {
      protections = await getGroupSettings(chatId, userId);
    } catch {}

    // Fetch group invite link if bot is admin
    let inviteUrl = null;
    try {
      const botJids = [
        sock.user?.id,
        sock.user?.lid,
        sock.user?.phoneNumber,
      ].filter(Boolean);
      const isBotAdmin = admins.some((a) =>
        botJids.some((b) => b && a.id && b.split("@")[0].split(":")[0] === a.id.split("@")[0].split(":")[0])
      );
      if (isBotAdmin && typeof sock.groupInviteCode === "function") {
        const code = await sock.groupInviteCode(chatId).catch(() => null);
        if (code) {
          inviteUrl = `https://chat.whatsapp.com/${code}`;
        }
      }
    } catch {}

    // Fetch group profile picture
    let groupPicUrl = null;
    try {
      if (typeof sock.profilePictureUrl === "function") {
        groupPicUrl = await sock.profilePictureUrl(chatId, "image").catch(() => null);
      }
    } catch {}

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
      `┃ ⭐ *Admins:* ${admins.length} (${superAdmins.length} creator/superadmin)`,
      `┃ 👤 *Regular Members:* ${regularMembers.length}`,
      `┃ 💬 *Messaging Permission:* ${isAnnounce ? "🔒 Admins Only" : "🌐 All Members"}`,
      `┃ ⚙️ *Edit Group Info:* ${isRestricted ? "🔒 Admins Only" : "🌐 All Members"}`,
      `┃ ⏳ *Disappearing Messages:* ${ephemeralDuration}`,
      ...(inviteUrl ? [`┃ 🔗 *Invite Link:* ${inviteUrl}`] : []),
      "",
      "┣━━〔 🛡️ *SECURITY & AUTOMATION* 〕━━┫",
      `┃ 🔗 *Antilink:* ${protections?.antiLink ? "🟢 Active" : "🔴 Inactive"}`,
      `┃ 🤖 *Antibot:* ${protections?.antiBot ? "🟢 Active" : "🔴 Inactive"}`,
      `┃ 📢 *Antistatus:* ${protections?.antiStatus ? "🟢 Active" : "🔴 Inactive"}`,
      `┃ 🎨 *Antisticker:* ${protections?.antiSticker ? "🟢 Active" : "🔴 Inactive"}`,
      `┃ 🎉 *Welcome Greeting:* ${protections?.welcome ? "🟢 Active" : "🔴 Inactive"}`,
      `┃ 👋 *Goodbye Farewell:* ${protections?.goodbye ? "🟢 Active" : "🔴 Inactive"}`,
      `┃ ⚠️ *Warning Threshold:* *${protections?.warningLimit || 2}* strikes before kick`,
      "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
    ];

    if (metadata.desc) {
      const cleanDesc = String(metadata.desc).trim();
      if (cleanDesc) {
        lines.push("", `📝 *Group Description:*`, cleanDesc.length > 300 ? `${cleanDesc.slice(0, 300)}...` : cleanDesc);
      }
    }

    const cardText = lines.join("\n");
    const uniqueMentions = [...new Set(allMentions)];

    // Send with group profile picture if available
    if (groupPicUrl) {
      try {
        return await sock.sendMessage(chatId, {
          image: { url: groupPicUrl },
          caption: cardText,
          mentions: uniqueMentions,
        });
      } catch (imgErr) {
        // Fallback to text if sending image fails
      }
    }

    await reply(cardText, {
      mentions: uniqueMentions,
    });
  } catch (error) {
    await reply(`❌ Could not fetch group info: ${error.message || "Unknown error"}`);
  }
}
