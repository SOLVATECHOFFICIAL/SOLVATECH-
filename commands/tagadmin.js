import { mentionAdmins } from "../lib/command-tools.js";
import { isGroup } from "../lib/helpers.js";

export default async function tagadmin({ sock, chatId, reply }) {
  if (!isGroup(chatId)) {
    return reply("❌ This command only works in groups.");
  }
  const metadata = await sock.groupMetadata(chatId);
  const result = await mentionAdmins(metadata);
  await reply(result.text, { mentions: result.mentions });
}