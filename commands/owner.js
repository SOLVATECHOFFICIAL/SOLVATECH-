export default async function owner({ reply }) {
  // Official, immutable SOLVATECH BOT developer/owner contact
  const OWNER_NAME = "SOLVATECH OFFICIAL";
  const OWNER_PHONE = "+234 904 997 9183";
  const OWNER_WA_LINK = "https://wa.me/2349049979183";
  const OFFICIAL_SITE = "https://solvatech.name.ng";

  const message = [
    "╭━━〔 *SOLVATECH BOT OWNER* 〕━━╮",
    `┃ 👑 *Developer:* ${OWNER_NAME}`,
    `┃ 📞 *Contact:* ${OWNER_PHONE}`,
    `┃ 💬 *WhatsApp Direct:* ${OWNER_WA_LINK}`,
    `┃ 🌐 *Official Platform:* ${OFFICIAL_SITE}`,
    `┃ 🛡️ *License & Support:* Active`,
    "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
    "",
    `_For official bot updates, custom feature inquiries, or licensing assistance, contact ${OWNER_NAME} via WhatsApp._`,
  ].join("\n");

  await reply(message);
}
