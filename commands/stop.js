import { stopSpamTask, stopAllSpamTasks } from "../lib/spam-manager.js";

/**
 * .stop command: Immediately halts any running spam or broadcast task.
 * Can be executed anywhere, anytime by the owner.
 */
export default async function stop({ chatId, reply, userId = "default", text = "" }) {
  const arg = String(text || "").trim().toLowerCase();
  let stopped = false;

  if (arg === "all" || arg === "global") {
    stopped = stopAllSpamTasks();
  } else {
    // 1. Try stopping by chatId and userId
    stopped = stopSpamTask(chatId, userId);

    // 2. If not stopped, try stopping by chatId alone
    if (!stopped) {
      stopped = stopSpamTask(chatId, null);
    }

    // 3. If still not stopped, try stopping by userId alone
    if (!stopped && userId) {
      stopped = stopSpamTask(null, userId);
    }

    // 4. If any task is active on the server, halt it immediately
    if (!stopped) {
      stopped = stopAllSpamTasks();
    }
  }

  if (stopped) {
    await reply("🛑 *Operation stopped immediately.* All broadcast transmissions halted.");
  } else {
    await reply("ℹ️ No active repeated operation is currently running in this chat.");
  }
}
