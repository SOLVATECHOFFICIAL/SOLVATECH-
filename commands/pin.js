import { requireAdmin } from "../lib/command-tools.js";
import { getQuotedMessage, isGroup } from "../lib/helpers.js";

export default async function pin({ sock, message, chatId, sender, senderJids, senderIsLinkedAccount, reply }) {
  if (!isGroup(chatId)) {
    return reply("❌ This command only works in groups.");
  }

  const quoted = getQuotedMessage(message, sock);
  if (!quoted?.key?.id) {
    return reply("❌ Reply to a message with *.pin* to pin it in the group.");
  }

  await requireAdmin(sock, chatId, sender, true, senderJids, senderIsLinkedAccount);

  try {
    const pinKey = {
      remoteJid: chatId,
      fromMe: Boolean(quoted.key.fromMe),
      id: quoted.key.id,
      ...(quoted.key.participant ? { participant: quoted.key.participant } : {}),
    };

    // Pin message for 7 days (604800 seconds)
    await sock.sendMessage(chatId, {
      pin: pinKey,
      type: 1, // 1 = PIN, 2 = UNPIN
      time: 604800, // 7 days in seconds
    });
    await reply("📌 *Message pinned successfully.*");
  } catch (error) {
    await reply(`❌ Failed to pin message: ${error.message || "Permission denied or pin unsupported"}`);
  }
}
