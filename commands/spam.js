import { isTaskCancelled, startSpamTask, stopSpamTask } from "../lib/spam-manager.js";

// 10 times faster than before (50ms interval = ~20 messages/sec)
const INTERVAL_MS = 50;

async function interruptibleSleep(ms, task) {
  const step = 10;
  let elapsed = 0;
  while (elapsed < ms && !isTaskCancelled(task)) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(step, ms - elapsed)));
    elapsed += step;
  }
}

export default async function spam({ sock, chatId, senderIsLinkedAccount, text, reply, userId = "default" }) {
  if (!senderIsLinkedAccount) {
    // Strictly personal controller-only: completely ignore unauthorized users
    return;
  }

  const messageText = String(text || "").trim();
  if (!messageText) {
    return reply(
      `❌ *Usage:* \`.spam <message>\`\n` +
      `Example: \`.spam Important update\`\n` +
      `_Use *.stop* anytime to stop infinite messaging._`
    );
  }

  // Cancel any prior active task for this chat/account and start fresh task
  const task = startSpamTask(userId, chatId);

  await reply(
    `⚡ *High-Speed Infinite Broadcast started (10x Faster)*\n` +
    `_Running infinitely without stopping until you send *.stop*._`
  );

  // Run infinite repeated operation asynchronously with rapid 50ms rate
  (async () => {
    let sentCount = 0;
    try {
      while (!isTaskCancelled(task)) {
        // Send message at maximum speed
        await sock.sendMessage(chatId, { text: messageText });
        sentCount++;

        if (isTaskCancelled(task)) {
          break;
        }

        // 10x faster rate interval (50ms), checking cancellation in real-time
        await interruptibleSleep(INTERVAL_MS, task);
      }
    } catch {
      // Socket error or disconnect handling
    } finally {
      stopSpamTask(userId, chatId);
      await reply(`🛑 *Operation stopped:* Successfully delivered ${sentCount} message${sentCount === 1 ? "" : "s"}.`).catch(() => {});
    }
  })();
}

