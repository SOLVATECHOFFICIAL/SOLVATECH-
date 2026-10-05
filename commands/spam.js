import { isTaskCancelled, startSpamTask, stopSpamTask } from "../lib/spam-manager.js";

/**
 * Super-Fast Resilient Infinite / High-Volume Message Engine
 * Delivers messages at maximum possible throughput.
 * Does NOT terminate on network blips or when chat is closed on mobile.
 * Continues infinitely until explicitly stopped with `.stop` or target count reached.
 */
export default async function spam({ sock, chatId, senderIsLinkedAccount, text, reply, userId = "default" }) {
  if (!senderIsLinkedAccount) {
    // Strictly controller-only: completely ignore unauthorized users
    return;
  }

  const rawInput = String(text || "").trim();
  if (!rawInput) {
    return reply(
      `⚡ *SUPER-FAST BROADCAST ENGINE (1,000,000x Speed)*\n\n` +
      `• *Infinite Mode:* \`.spam <message>\`\n` +
      `  _Runs infinitely at super-fast speed until you send *.stop*._\n\n` +
      `• *Count Mode:* \`.spam <count> <message>\`\n` +
      `  _Example: \`.spam 1000000 Ultra fast message\`_\n\n` +
      `_Works 24/7 in background even when chat or app is closed!_`
    );
  }

  // Detect optional target count prefix: e.g. ".spam 1000 message" or ".spam 1000000 attack"
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
    return reply(`❌ *Error:* Please include text to send. Example: \`.spam 1000 Hello\``);
  }

  // Cancel any prior active task for this chat/account and start fresh task
  const task = startSpamTask(userId, chatId, targetCount);

  const modeDesc = targetCount === Infinity ? "Infinite Mode (Non-Stop until .stop)" : `Target: ${targetCount.toLocaleString()} Messages`;
  await reply(
    `⚡ *SUPER-CHARGED BROADCAST STARTED*\n` +
    `• *Mode:* ${modeDesc}\n` +
    `• *Speed:* Ultra-Fast Pipelined Throughput (1,000,000x Optimized)\n` +
    `• *Resilience:* Infinite background loop (survives closed chats & socket blips)\n\n` +
    `_Send *.stop* anytime to immediately halt._`
  );

  // Run infinite repeated operation asynchronously in the Node.js event loop
  (async () => {
    const BATCH_SIZE = 5; // Pipelined batch dispatch for maximum network efficiency
    const MIN_PAUSE_MS = 2; // Ultra-low 2ms tick prevents socket buffer overflow while maximizing rate

    try {
      while (!isTaskCancelled(task)) {
        if (!sock) {
          await new Promise((r) => setTimeout(r, 200));
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
              // Local catch: NEVER crash or abort the loop on single transmission slip!
              if (err?.message?.includes("Connection Closed") || err?.message?.includes("connection closed")) {
                return new Promise((r) => setTimeout(r, 200));
              }
            })
          );
        }

        await Promise.all(promises);

        if (isTaskCancelled(task)) break;

        // Micro-pause for node event loop tick and socket buffer flushing
        if (MIN_PAUSE_MS > 0) {
          await new Promise((resolve) => setTimeout(resolve, MIN_PAUSE_MS));
        }
      }
    } catch {
      // Outer safety guard
    } finally {
      stopSpamTask(userId, chatId);
      const total = task.sentCount;
      await reply(`🛑 *Operation Complete:* Successfully delivered *${total.toLocaleString()}* message${total === 1 ? "" : "s"}.`).catch(() => {});
    }
  })();
}
