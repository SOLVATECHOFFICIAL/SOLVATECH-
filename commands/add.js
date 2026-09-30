import { normalizeNumber } from "../lib/helpers.js";
import { requireAdmin } from "../lib/command-tools.js";

export default async function add({ sock, chatId, sender, senderJids, senderIsLinkedAccount, args, reply }) {
  const metadata = await requireAdmin(sock, chatId, sender, true, senderJids, senderIsLinkedAccount);
  const number = normalizeNumber(args[0]);
  if (!number || number.length < 7) return reply("❌ Please provide a valid number with country code.");
  try {
    await sock.groupParticipantsUpdate(chatId, [`${number}@s.whatsapp.net`], "add");
    await reply(`✅ Added ${number} to the group.`);
  } catch (error) {
    await reply("❌ I couldn't add that number.");
    throw error;
  }
  return metadata;
}