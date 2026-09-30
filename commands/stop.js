import { stopSpamTask } from "../lib/spam-manager.js";

export default async function stop({ senderIsLinkedAccount, chatId, reply, userId = "default" }) {
  if (!senderIsLinkedAccount) {
    // Strictly controller-only: completely ignore anyone else
    return;
  }

  const stopped = stopSpamTask(userId, chatId);
  if (stopped) {
    await reply("🛑 *Active repeated operation stopped immediately.*");
  } else {
    await reply("ℹ️ No active repeated operation is running in this chat.");
  }
}
