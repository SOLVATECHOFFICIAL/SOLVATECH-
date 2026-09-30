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
  await requireAdmin(sock, chatId, sender, true, senderJids, senderIsLinkedAccount);

  const value = String(args[0] || "").toLowerCase();
  if (!["on", "off"].includes(value)) {
    const current = await getGroupSettings(chatId, userId);
    return reply([
      "╭━━〔 🎈 *SOLVATECH AUTO-WELCOME* 〕━━╮",
      "",
      `┃ ⚙️ *Current Status:* ${current.welcome ? "🟢 *ENABLED (ON)*" : "🔴 *DISABLED (OFF)*"}`,
      "┃ 💬 *Action:* _Greets new members automatically upon joining_",
      "",
      "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
      "",
      "╭──〔 💡 *COMMAND USAGE* 〕──╮",
      "│",
      "│ • *.autowelcome on* — _Activate auto-welcome for this group_",
      "│ • *.autowelcome off* — _Deactivate auto-welcome for this group_",
      "│",
      "╰────────────────────────────",
    ].join("\n"));
  }

  const enabled = value === "on";
  await setGroupSetting(chatId, "welcome", enabled, userId);
  await reply(`✅ *Auto Welcome:* ${enabled ? "🟢 *ENABLED (ON)*" : "🔴 *DISABLED (OFF)*"}\n_Configuration saved to group cloud settings._`);
}
