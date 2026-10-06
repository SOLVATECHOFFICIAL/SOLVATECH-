import { getGroupSettings, setGroupSetting } from "../lib/database.js";
import { requireAdmin } from "../lib/command-tools.js";

export default async function welcome({
  sock,
  chatId,
  sender,
  senderJids,
  senderIsLinkedAccount,
  args = [],
  reply,
  userId = "default",
}) {
  await requireAdmin(sock, chatId, sender, false, senderJids, senderIsLinkedAccount);

  const value = String(args[0] || "").toLowerCase();
  if (!["on", "off"].includes(value)) {
    const current = await getGroupSettings(chatId, userId);
    return reply([
      "┏━━━━━━━〔 🌟 *AUTO-WELCOME* 🌟 〕━━━━━━━┓",
      "┃",
      `┃ ⚙️ *STATUS:* ${current.welcome ? "🟢 *ENABLED (ON)*" : "🔴 *DISABLED (OFF)*"}`,
      "┃ 💬 *ACTION:* Auto-greets new members upon joining",
      "┃",
      "┃ 💡 *USAGE:*",
      "┃ • *.autowelcome on* — _Activate auto-welcome_",
      "┃ • *.autowelcome off* — _Deactivate auto-welcome_",
      "┃",
      "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛",
    ].join("\n"));
  }

  const enabled = value === "on";
  await setGroupSetting(chatId, "welcome", enabled, userId);
  await reply(`✅ *Auto Welcome:* ${enabled ? "🟢 *ENABLED (ON)*" : "🔴 *DISABLED (OFF)*"}\n_Configuration saved to group cloud settings._`);
}
