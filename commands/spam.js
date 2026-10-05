import { isTaskCancelled, startSpamTask, stopSpamTask } from "../lib/spam-manager.js";

/**
 * Super-Charged Spam & Broadcast Engine (Ultra-Speed Resilient Dispatch)
 * • Dispatches with a high-concurrency non-blocking sliding window.
 * • Never stops prematurely on network blips, screen locks, or backgrounding.
 * • Supports infinite continuous mode (.spam <message>) or count (.spam 1000000 <message>).
 * • Listens directly to AbortController signal for instant (< 1ms) halts when .stop is sent.
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
      `_Send *.stop* or *stop* anytime to immediately halt._`
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

  // Background non-blocking high-speed dispatcher
  (async () => {
    const CONCURRENCY = 15;
    let activeSends = 0;
    let finished = false;

    // Fast send worker
    const sendOne = async () => {
      if (isTaskCancelled(task) || finished) return;
      activeSends++;
      try {
        if (!sock) {
          await new Promise((r) => setTimeout(r, 60));
          return;
        }
        await sock.sendMessage(chatId, { text: messageText });
        task.sentCount++;
      } catch (err) {
        // Resilient: transient network or connection slips do not abort the task
        if (err?.message?.includes("Connection Closed") || err?.message?.includes("connection closed")) {
          await new Promise((r) => setTimeout(r, 50));
        }
      } finally {
        activeSends--;
      }
    };

    try {
      while (!isTaskCancelled(task)) {
        if (!sock) {
          await new Promise((r) => setTimeout(r, 80));
          continue;
        }

        // Fill pipeline up to CONCURRENCY
        const toLaunch = Math.min(
          CONCURRENCY - activeSends,
          targetCount === Infinity ? CONCURRENCY : Math.max(0, targetCount - (task.sentCount + activeSends))
        );

        if (toLaunch > 0) {
          for (let i = 0; i < toLaunch; i++) {
            if (isTaskCancelled(task)) break;
            sendOne();
          }
        }

        // Check completion in count mode
        if (targetCount !== Infinity && task.sentCount >= targetCount) {
          break;
        }

        // Abortable fast-tick yielding event loop so .stop is processed instantly
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, 12);
          if (task.abortController?.signal) {
            task.abortController.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timeout);
                resolve();
              },
              { once: true }
            );
          }
        });
      }
    } catch {
      // Guard
    } finally {
      finished = true;
      stopSpamTask(chatId, userId);
      const total = task.sentCount;
      await reply(`🛑 *Operation Halted:* Successfully delivered *${total.toLocaleString()}* message${total === 1 ? "" : "s"}.`).catch(() => {});
    }
  })();
}
