import { getGroupSettings, toggleGroupSetting } from "../lib/command-tools.js";
import { requireAdmin } from "../lib/command-tools.js";

const settingByCommand = {
  antilink: "antiLink",
  antibot: "antiBot",
  antistatus: "antiStatus",
};

const settingByName = {
  link: "antiLink",
  antilink: "antiLink",
  bot: "antiBot",
  antibot: "antiBot",
  status: "antiStatus",
  antistatus: "antiStatus",
};

export default async function anti({ sock, chatId, sender, senderJids, senderIsLinkedAccount, args = [], command, reply, userId = "default" }) {
  await requireAdmin(sock, chatId, sender, true, senderJids, senderIsLinkedAccount);
  const commandSetting = settingByCommand[command];
  const first = String(args[0] || "").toLowerCase();
  const second = String(args[1] || "").toLowerCase();
  const setting = commandSetting || settingByName[first] || "antiLink";
  const value = commandSetting ? first : settingByName[first] ? second : first;

  if (!["on", "off"].includes(value)) {
    const current = await getGroupSettings(chatId, userId);
    return reply([
      "╭━━〔 🛡️ *SOLVATECH ANTI-PROTECTION SUITE* 〕━━╮",
      "",
      `┃ 🔗 *Antilink:* ${current.antiLink ? "🟢 *ON*" : "🔴 *OFF*"}`,
      `┃ 🤖 *Antibot:* ${current.antiBot ? "🟢 *ON*" : "🔴 *OFF*"}`,
      `┃ 📢 *Antistatus (Status Mention):* ${current.antiStatus !== false ? "🟢 *ON*" : "🔴 *OFF*"}`,
      `┃ ⚠️ *Unified Warning Threshold:* *${current.warningLimit || 3}* strikes`,
      "",
      "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
      "",
      "╭──〔 💡 *TOGGLE USAGE* 〕──╮",
      "│ • *.antilink on/off* — Auto-delete external links & warn",
      "│ • *.antibot on/off* — Auto-delete unauthorized bot messages & warn",
      "│ • *.antistatus on/off* — Auto-delete status mentions & warn",
      "│ • *.warns limit <1-10>* — Change threshold before removal",
      "╰───────────────────────────",
    ].join("\n"));
  }

  const enabled = value === "on";
  await toggleGroupSetting(chatId, setting, enabled, userId);
  const labelNames = {
    antiLink: "Antilink Protection",
    antiBot: "Antibot Protection",
    antiStatus: "Antistatus Protection (Status Mentions)",
  };
  const name = labelNames[setting] || setting;
  await reply(`✅ *${name}:* ${enabled ? "🟢 *ENABLED (ON)*" : "🔴 *DISABLED (OFF)*"}\n_Configuration permanently saved to Firebase Firestore._`);
}