import { stopSpamTask, stopAllSpamTasks } from "../lib/spam-manager.js";

/**
 * .stop command: Immediately halts all running spam or broadcast tasks.
 * Can be executed anywhere, anytime by the owner.
 */
export default async function stop({ chatId, reply, userId = "default" }) {
  stopSpamTask(chatId, userId);
  stopSpamTask(chatId, null);
  if (userId) stopSpamTask(null, userId);
  stopAllSpamTasks();

  await reply("🛑 *Operation stopped immediately.* All broadcast transmissions halted.");
}
