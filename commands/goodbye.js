import { getGroupSettings, setGroupSetting } from "../lib/database.js";
import { requireAdmin } from "../lib/command-tools.js";

export default async function goodbye({
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
      "┏━━━━━━━〔 🚪 *AUTO-GOODBYE* 🚪 〕━━━━━━━┓",
      "┃",
      `┃ ⚙️ *STATUS:* ${current.goodbye ? "🟢 *ENABLED (ON)*" : "🔴 *DISABLED (OFF)*"}`,
      "┃ 💬 *ACTION:* Sends farewell notice automatically when members leave",
      "┃",
      "┃ 💡 *USAGE:*",
      "┃ • *.autogoodbye on* — _Activate auto-goodbye_",
      "┃ • *.autogoodbye off* — _Deactivate auto-goodbye_",
      "┃",
      "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛",
    ].join("\n"));
  }

  const enabled = value === "on";
  await setGroupSetting(chatId, "goodbye", enabled, userId);
  await reply(`✅ *Auto Goodbye:* ${enabled ? "🟢 *ENABLED (ON)*" : "🔴 *DISABLED (OFF)*"}\n_Configuration saved to group cloud settings._`);
}
