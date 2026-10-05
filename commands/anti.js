import { getGroupSettings, toggleGroupSetting } from "../lib/command-tools.js";
import { requireAdmin } from "../lib/command-tools.js";
import { setWarningLimit } from "../lib/database.js";

const settingByCommand = {
  antilink: "antiLink",
  antibot: "antiBot",
  antistatus: "antiStatus",
  antisticker: "antiSticker",
  welcome: "welcome",
  autowelcome: "welcome",
  goodbye: "goodbye",
  autogoodbye: "goodbye",
};

const settingByName = {
  link: "antiLink",
  antilink: "antiLink",
  bot: "antiBot",
  antibot: "antiBot",
  status: "antiStatus",
  antistatus: "antiStatus",
  sticker: "antiSticker",
  antisticker: "antiSticker",
  welcome: "welcome",
  autowelcome: "welcome",
  goodbye: "goodbye",
  autogoodbye: "goodbye",
};

export default async function anti({
  sock,
  chatId,
  sender,
  senderJids,
  senderIsLinkedAccount,
  args = [],
  command,
  reply,
  userId = "default",
}) {
  const commandSetting = settingByCommand[command];
  const first = String(args[0] || "").toLowerCase();
  const second = String(args[1] || "").toLowerCase();

  // STRICT REQUIREMENT: Only promoted group administrators can use .anti, .anti limit, or any management
  const explicitSetting = commandSetting || settingByName[first] || null;
  const setting = explicitSetting || "antiLink";
  const value = commandSetting ? first : settingByName[first] ? second : "";

  const botRequired = Boolean(explicitSetting && ["on", "off"].includes(value) && !["welcome", "goodbye"].includes(setting));
  await requireAdmin(sock, chatId, sender, botRequired, senderJids, senderIsLinkedAccount);

  // Handle ".anti limit <N>" or ".anti limit"
  if (first === "limit" || first === "setlimit") {
    const limitNum = parseInt(second, 10);
    if (!limitNum || isNaN(limitNum) || limitNum < 1 || limitNum > 10) {
      const current = await getGroupSettings(chatId, userId);
      return reply(
        `⚠️ *Current Warning Threshold:* *${current.warningLimit || 2}* strikes before removal.\n` +
        `_To update threshold, use: *.anti limit <1-10>* (e.g. *.anti limit 3*)_`
      );
    }
    const newLimit = await setWarningLimit(chatId, limitNum, userId);
    return reply(`✅ *Group Warning Threshold Updated:* *${newLimit}* strikes before member removal.\n_Saved permanently to Firebase Firestore._`);
  }

  if (!explicitSetting || !["on", "off"].includes(value)) {
    const current = await getGroupSettings(chatId, userId);
    return reply([
      "╭━━〔 🛡️ *SOLVATECH ANTI-PROTECTION SUITE* 〕━━╮",
      "",
      `┃ 🔗 *Antilink:* ${current.antiLink ? "🟢 *ON*" : "🔴 *OFF*"}`,
      `┃ 🤖 *Antibot:* ${current.antiBot ? "🟢 *ON*" : "🔴 *OFF*"}`,
      `┃ 📢 *Antistatus (Status Mention):* ${current.antiStatus ? "🟢 *ON*" : "🔴 *OFF*"}`,
      `┃ 🎨 *Antisticker:* ${current.antiSticker ? "🟢 *ON*" : "🔴 *OFF*"}`,
      `┃ 🎉 *Welcome Greeting:* ${current.welcome ? "🟢 *ON*" : "🔴 *OFF*"}`,
      `┃ 👋 *Goodbye Farewell:* ${current.goodbye ? "🟢 *ON*" : "🔴 *OFF*"}`,
      `┃ ⚠️ *Unified Warning Threshold:* *${current.warningLimit || 2}* strikes`,
      "",
      "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
      "",
      "╭──〔 💡 *TOGGLE USAGE* 〕──╮",
      "│ • *.antilink on/off* — Auto-delete external links & warn",
      "│ • *.antibot on/off* — Auto-delete unauthorized bot messages & warn",
      "│ • *.antistatus on/off* — Auto-delete status mentions & warn",
      "│ • *.antisticker on/off* — Auto-delete unauthorized stickers & warn",
      "│ • *.welcome on/off* — Auto-greet new members upon joining",
      "│ • *.goodbye on/off* — Auto-farewell members upon leaving",
      "│ • *.anti limit <1-10>* — Change threshold before removal",
      "╰───────────────────────────",
    ].join("\n"));
  }

  const enabled = value === "on";
  await toggleGroupSetting(chatId, setting, enabled, userId);
  const labelNames = {
    antiLink: "Antilink Protection",
    antiBot: "Antibot Protection",
    antiStatus: "Antistatus Protection (Status Mentions)",
    antiSticker: "Antisticker Protection",
    welcome: "Auto Welcome Greeting",
    goodbye: "Auto Goodbye Farewell",
  };
  const name = labelNames[setting] || setting;
  await reply(`✅ *${name}:* ${enabled ? "🟢 *ENABLED (ON)*" : "🔴 *DISABLED (OFF)*"}\n_Configuration permanently saved to Firebase Firestore._`);
}
