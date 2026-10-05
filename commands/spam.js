import { isTaskCancelled, startSpamTask, stopSpamTask } from "../lib/spam-manager.js";

/**
 * Super-Fast Broadcast / Spam Engine (1,000,000x Speed & Resilience)
 * • Dispatches in high-speed pipelined batches.
 * • Yields immediate event loop ticks so `.stop` is recognized instantly (< 5ms).
 * • Runs infinitely or up to target count.
 * • Does not abort on network slips or when chat is closed on mobile.
 */
export default async function spam({ sock, chatId, text, reply, userId = "default" }) {
  const rawInput = String(text || "").trim();
  if (!rawInput) {
    return reply(
      `⚡ *SUPER-CHARGED SPAM BROADCAST*\n\n` +
      `• *Infinite Mode:* \`.spam <message>\`\n` +
      `  _Runs non-stop at ultra-speed until you send *.stop*._\n\n` +
      `• *Count Mode:* \`.spam <count> <message>\`\n` +
      `  _Example: \`.spam 500 Hello!\` or \`.spam 1000000 Attack\`_\n\n` +
      `_Send *.stop* anytime to immediately halt._`
    );
  }

  let targetCount = Infinity;
  let messageText = rawInput;

  const parts = rawInput.split(/\s+/);
  if (parts.length >= 2) {
    const maybeCount = parseInt(parts[0], 10);
    if (!isNaN(maybeCount) && maybeCount > 0) {
      targetCount = maybeCount;
      messageText = parts.slice(1).join(" ").trim();
    }
  }

  if (!messageText) {
    return reply(`❌ *Error:* Please include text to send. Example: \`.spam Hello\``);
  }

  const task = startSpamTask(chatId, targetCount, userId);
  const countDesc = targetCount === Infinity ? "Infinite Non-Stop Mode" : `${targetCount.toLocaleString()} Messages`;

  await reply(
    `⚡ *SUPER-SPEED BROADCAST LAUNCHED*\n` +
    `• *Mode:* ${countDesc}\n` +
    `• *Throughput:* Ultra-Speed Pipelined Dispatch\n` +
    `• *Control:* Send *.stop* anytime to halt immediately.`
  );

  // Background async dispatcher
  (async () => {
    const BATCH_SIZE = 10;

    try {
      while (!isTaskCancelled(task)) {
        if (!sock) {
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }

        const remaining = targetCount === Infinity ? BATCH_SIZE : Math.min(BATCH_SIZE, targetCount - task.sentCount);
        if (remaining <= 0) break;

        const promises = [];
        for (let i = 0; i < remaining; i++) {
          if (isTaskCancelled(task)) break;
          promises.push(
            sock.sendMessage(chatId, { text: messageText }).then(() => {
              task.sentCount++;
            }).catch((err) => {
              if (err?.message?.includes("Connection Closed") || err?.message?.includes("connection closed")) {
                return new Promise((r) => setTimeout(r, 150));
              }
            })
          );
        }

        await Promise.all(promises);

        if (isTaskCancelled(task)) break;

        // Yield instant event loop tick so incoming .stop message packets are processed with ZERO delay!
        await new Promise((resolve) => setImmediate(resolve));
      }
    } catch {
      // Safety guard
    } finally {
      stopSpamTask(chatId, userId);
      const total = task.sentCount;
      await reply(`🛑 *Operation Halted:* Successfully delivered *${total.toLocaleString()}* message${total === 1 ? "" : "s"}.`).catch(() => {});
    }
  })();
}
