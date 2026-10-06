import { mentionMembers, getSafeMetadata } from "../lib/command-tools.js";
import { isGroup } from "../lib/helpers.js";

export default async function tagall({ sock, chatId, text, reply }) {
  if (!isGroup(chatId)) {
    return reply("❌ This command only works in groups.");
  }
  const metadata = await getSafeMetadata(sock, chatId);
  if (!metadata) {
    return reply("❌ Could not retrieve group information. Please try again.");
  }
  const heading = text ? `📢 *ANNOUNCEMENT:* ${text}` : "📢 *ATTENTION EVERYONE*";
  const result = await mentionMembers(metadata, heading);
  await reply(result.text, { mentions: result.mentions });
}