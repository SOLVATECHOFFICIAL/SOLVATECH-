import { BOT_NAME, OWNER_NAME } from "../lib/config.js";

const SOLVATECH_LOGO_URL = "https://solvatechofficial.github.io/WHATSAPP-BOT-/solva.webp";

export default async function alive({ reply }) {
  await reply({
    image: SOLVATECH_LOGO_URL,
    caption: `⚡ *${BOT_NAME} IS ONLINE*\n👤 *Owner:* ${OWNER_NAME}\n🟢 *Status:* Active & Listening`,
  });
}