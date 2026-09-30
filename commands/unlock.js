import { requireAdmin } from "../lib/command-tools.js";

export default async function unlock({ sock, chatId, sender, senderJids, senderIsLinkedAccount, reply }) {
  await requireAdmin(sock, chatId, sender, true, senderJids, senderIsLinkedAccount);
  await sock.groupSettingUpdate(chatId, "not_announcement");
  await reply("🔓 Group unlocked. All members can send messages.");
}