import fs from "node:fs";
import path from "node:path";
import { BOT_NAME, OWNER_NAME } from "../lib/config.js";

const SOLVATECH_LOGO_URL = "https://solvatechofficial.github.io/WHATSAPP-BOT-/solva.webp";
const LOCAL_LOGO_PATH = path.resolve("solva.webp");

export default async function alive({ reply }) {
  const imagePayload = fs.existsSync(LOCAL_LOGO_PATH)
    ? fs.readFileSync(LOCAL_LOGO_PATH)
    : { url: SOLVATECH_LOGO_URL };

  await reply({
    image: imagePayload,
    caption: `⚡ *${BOT_NAME} IS ONLINE*\n👤 *Owner:* ${OWNER_NAME}\n🟢 *Status:* Active & Listening`,
  });
}