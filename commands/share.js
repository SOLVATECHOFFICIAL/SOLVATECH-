import { formatReferralLink, getReferralStats, ensureUserReferralData } from "../lib/referral.js";

export default async function share({
  reply,
  userId = "default",
  verifiedUid = "",
  userEmail = "",
  text = "",
  message,
}) {
  let referralLink = "https://solvatech.name.ng/";

  const rawUid =
    verifiedUid && verifiedUid !== "default"
      ? verifiedUid
      : userId && userId !== "default"
      ? userId
      : "";
  const effectiveUid = String(rawUid || "").replace(/^user_/, "");

  if (effectiveUid) {
    try {
      const stats = await getReferralStats(effectiveUid);
      if (stats?.referralLink) {
        referralLink = stats.referralLink;
      } else if (stats?.referralCode) {
        referralLink = formatReferralLink(stats.referralCode);
      } else {
        const ensured = await ensureUserReferralData(effectiveUid, userEmail);
        if (ensured?.referralLink) {
          referralLink = ensured.referralLink;
        }
      }
    } catch {
      referralLink = "https://solvatech.name.ng/";
    }
  }

  const shareText = [
    "╭━━━〔 🤖 *GET YOUR OWN SOLVATECH BOT* 〕━━━╮",
    "",
    "┃ ⚡ *Features & Automation Capabilities:*",
    "┃ • _Deleted-Message Recovery directly to your DM_",
    "┃ • _View-Once Decryption & Media Tools_",
    "┃ • _Group Protection (Anti-Link, Anti-Bot, Anti-Status)_",
    "┃ • _High-Precision OCR & Image Text Extraction_",
    "┃ • _Stickers & Animated Video Converter_",
    "┃ • _Full AI Assistant & Group Trivia Games_",
    "",
    "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
    "",
    "╭──〔 🌐 *OFFICIAL ACCESS LINK* 〕──╮",
    "│",
    `│ 🔗 ${referralLink}`,
    "│",
    "╰──────────────────────────────────",
    "",
    "╭──〔 🚀 *HOW TO GET STARTED* 〕──╮",
    "│",
    "│ 1️⃣ _Open the link above in your browser._",
    "│ 2️⃣ _Tap *ENTER DASHBOARD* & Sign in with Google._",
    "│ 3️⃣ _Obtain your *SOLVATECH BOT* license key._",
    "│ 4️⃣ _Enter license key & link your WhatsApp device._",
    "│",
    "╰──────────────────────────────────",
    "",
    "🎁 *REFER & EARN:* _Refer friends and earn *3 FREE DAYS* when their qualifying purchases reach ₦1,000!_",
  ].join("\n");

  // Optional mention handling if @user was tagged
  const mentions = [];
  if (text) {
    const rawMatches = text.match(/\b\d{7,15}\b/g) || [];
    for (const num of rawMatches) {
      const jid = `${num}@s.whatsapp.net`;
      if (!mentions.includes(jid)) mentions.push(jid);
    }
  }
  if (message?.message?.extendedTextMessage?.contextInfo?.mentionedJid) {
    for (const jid of message.message.extendedTextMessage.contextInfo.mentionedJid) {
      if (!mentions.includes(jid)) mentions.push(jid);
    }
  }

  const options = mentions.length > 0 ? { mentions } : {};
  await reply(shareText, options);
}
