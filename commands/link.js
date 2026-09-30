import { isGroup } from "../lib/helpers.js";

export default async function link({ sock, chatId, reply }) {
  if (!isGroup(chatId)) {
    return reply("❌ This command only works in groups.");
  }
  try {
    const code = await sock.groupInviteCode(chatId);
    if (!code) {
      return reply("❌ Could not retrieve group invite link. Ensure the bot is an admin.");
    }
    await reply(`🔗 *Group Invite Link:*\nhttps://chat.whatsapp.com/${code}`);
  } catch (error) {
    if (error?.data === 403 || error?.output?.statusCode === 403 || String(error?.message || "").includes("admin")) {
      return reply("❌ I need to be a group admin to retrieve the invite link.");
    }
    return reply(`❌ Error retrieving group invite link: ${error.message || "Permission denied"}`);
  }
}
