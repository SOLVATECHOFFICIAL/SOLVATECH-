import { isGroup, normalizeNumber, normalizedUser, unwrapMediaMessage } from "../lib/helpers.js";

export default async function profile({ sock, message, chatId, sender, args, reply }) {
  // 1. Resolve Target User JID:
  // Priority: (a) Mentioned JID in contextInfo, (b) Quoted message sender, (c) Phone number in args, (d) Command sender
  let targetJid = null;

  const content = unwrapMediaMessage(message);
  const contextInfo =
    content?.extendedTextMessage?.contextInfo ||
    content?.imageMessage?.contextInfo ||
    content?.videoMessage?.contextInfo ||
    content?.documentMessage?.contextInfo;

  if (contextInfo?.mentionedJid && contextInfo.mentionedJid.length > 0) {
    targetJid = contextInfo.mentionedJid[0];
  } else if (contextInfo?.participant) {
    targetJid = contextInfo.participant;
  } else if (args && args.length > 0) {
    const rawNumber = String(args[0]).replace(/[@+\s-]/g, "");
    if (/^\d{7,16}$/.test(rawNumber)) {
      targetJid = `${rawNumber}@s.whatsapp.net`;
    }
  }

  if (!targetJid) {
    targetJid = sender || sock.user?.id;
  }

  if (!targetJid) {
    return reply("❌ Could not identify the target profile.");
  }

  const normalizedTarget = normalizedUser(targetJid);
  const phoneNumber = normalizedTarget.split("@")[0].split(":")[0];
  const mentionTag = `@${phoneNumber}`;

  // 2. Fetch real Baileys / WhatsApp profile data
  let aboutStatus = "Not available or restricted by privacy";
  let statusSetAt = "";
  try {
    const statusData = await sock.fetchStatus(normalizedTarget).catch(() => null);
    if (statusData && statusData.status) {
      aboutStatus = statusData.status;
      if (statusData.setAt) {
        statusSetAt = new Date(statusData.setAt).toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
      }
    }
  } catch {}

  let profilePicUrl = null;
  try {
    profilePicUrl = await sock.profilePictureUrl(normalizedTarget, "image").catch(() => null);
  } catch {}

  // 3. Determine Group Role if in a group
  let groupRole = "N/A (Direct Message)";
  if (isGroup(chatId)) {
    try {
      const metadata = await sock.groupMetadata(chatId);
      const participant = (metadata?.participants || []).find((p) => {
        const pNum = (p.id || "").split("@")[0].split(":")[0];
        return pNum === phoneNumber || p.id === targetJid || p.id === normalizedTarget;
      });

      if (participant) {
        if (participant.admin === "superadmin") {
          groupRole = "👑 Group Creator / Superadmin";
        } else if (participant.admin === "admin" || participant.admin === true) {
          groupRole = "⭐ Group Admin";
        } else {
          groupRole = "👤 Member";
        }
      } else {
        groupRole = "Non-member";
      }
    } catch {}
  }

  // 4. Check for Business Profile if available
  let businessInfo = null;
  try {
    const biz = await sock.getBusinessProfile(normalizedTarget).catch(() => null);
    if (biz && (biz.description || biz.category || biz.email || biz.website)) {
      businessInfo = biz;
    }
  } catch {}

  // 5. Construct Profile Card
  const profileLines = [
    "╭━━〔 👤 *WHATSAPP USER PROFILE* 〕━━╮",
    `┃ 📱 *User:* ${mentionTag}`,
    `┃ 📞 *Number:* +${phoneNumber}`,
    `┃ 💬 *About / Bio:* ${aboutStatus}`,
    ...(statusSetAt ? [`┃ 🗓️ *Bio Updated:* ${statusSetAt}`] : []),
    `┃ 🏷️ *JID:* ${normalizedTarget}`,
    ...(isGroup(chatId) ? [`┃ 🛡️ *Group Role:* ${groupRole}`] : []),
    ...(businessInfo?.category ? [`┃ 🏢 *Business Category:* ${businessInfo.category}`] : []),
    ...(businessInfo?.description ? [`┃ 📝 *Business Info:* ${businessInfo.description}`] : []),
    "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
  ];

  const cardText = profileLines.join("\n");

  if (profilePicUrl) {
    try {
      return await sock.sendMessage(chatId, {
        image: { url: profilePicUrl },
        caption: cardText,
        mentions: [normalizedTarget],
      });
    } catch {
      // Fallback to text if image fails to send
    }
  }

  await reply(cardText, {
    mentions: [normalizedTarget],
  });
}
