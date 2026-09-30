import { resetWarnings } from "../lib/database.js";
import { requireAdmin } from "../lib/command-tools.js";

export default async function resetwarns({
  sock,
  chatId,
  sender,
  senderJids,
  senderIsLinkedAccount,
  reply,
  userId = "default",
}) {
  await requireAdmin(sock, chatId, sender, true, senderJids, senderIsLinkedAccount);

  await resetWarnings(chatId, userId);
  await reply([
    "╭━━〔 🔄 *GROUP WARNINGS RESET* 〕━━╮",
    "",
    "┃ 🟢 *All active member warnings have been reset to 0.*",
    "┃ 📊 *Status:* _Clean group slate_",
    "",
    "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
    "",
    "_Group data synced with Firebase Firestore._",
  ].join("\n"));
}
