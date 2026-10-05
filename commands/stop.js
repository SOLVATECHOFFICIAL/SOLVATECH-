import { stopSpamTask } from "../lib/spam-manager.js";

/**
 * .stop command: Immediately halts any running spam or broadcast task in the chat.
 * Can be executed anywhere, anytime by the owner or any chat member.
 */
export default async function stop({ chatId, reply, userId = "default" }) {
  const stopped = stopSpamTask(chatId, userId);
  if (stopped) {
    await reply("🛑 *Operation stopped immediately.* All broadcast transmissions halted.");
  } else {
    await reply("ℹ️ No active repeated operation is currently running in this chat.");
  }
}
