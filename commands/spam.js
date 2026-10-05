import { isTaskCancelled, startSpamTask, stopSpamTask } from "../lib/spam-manager.js";

/**
 * Super-Charged Spam & Broadcast Engine (Light-Speed Resilient Dispatch)
 * • Dispatches with high-concurrency non-blocking pipelined window.
 * • Strict limit requirement: Requires count at end (.spam <text> <count>) or start (.spam <count> <text>).
 * • If no limit is provided (.spam okay), requires count instead of infinite flooding.
 * • Never stops prematurely on network blips or backgrounding until target count is reached.
 */
export default async function spam({ sock, chatId, text, reply, userId = "default" }) {
  const rawInput = String(text || "").trim();
  if (!rawInput) {
    return reply(
      `⚡ *SUPER-SPEED SPAM BROADCAST*\n\n` +
      `• *Usage:* \`.spam <message> <count>\`\n` +
      `  _Example: \`.spam wassup 20\` or \`.spam okay 50\`_\n\n` +
      `_Send *.stop* anytime to halt active dispatch._`
    );
  }

  const words = rawInput.split(/\s+/);
  let targetCount = null;
  let messageText = "";

  // 1. Check last word for count (.spam wassup 20, .spam okay 50)
  const lastWord = words[words.length - 1];
  const lastCount = parseInt(lastWord, 10);
  if (!isNaN(lastCount) && lastCount > 0 && String(lastCount) === lastWord) {
    targetCount = lastCount;
    messageText = words.slice(0, -1).join(" ").trim();
  }

  // 2. Check first word for count (.spam 20 wassup, .spam 50 okay)
  if (!targetCount && words.length >= 2) {
    const firstWord = words[0];
    const firstCount = parseInt(firstWord, 10);
    if (!isNaN(firstCount) && firstCount > 0 && String(firstCount) === firstWord) {
      targetCount = firstCount;
      messageText = words.slice(1).join(" ").trim();
    }
  }

  // 3. User must provide limit: "if user use .spam okay don't anser say pit limit etc"
  if (!targetCount) {
    return reply(
      `❌ *Limit Missing:* Please put a count limit at the end of your message.\n` +
      `_Example: *.spam wassup 20* or *.spam okay 50*_`
    );
  }

  if (!messageText) {
    return reply(`❌ *Message Missing:* Please include text to send.\n_Example: *.spam wassup 20*_`);
  }

  const task = startSpamTask(chatId, targetCount, userId);

  await reply(
    `⚡ *LIGHT-SPEED BROADCAST LAUNCHED*\n` +
    `• *Target Count:* ${targetCount.toLocaleString()} Messages\n` +
    `• *Throughput:* Ultra-Speed Pipelined Concurrency\n` +
    `• *Message:* "${messageText}"\n` +
    `_Dispatching at light speed without delay..._`
  );

  // Background non-blocking high-speed dispatcher
  (async () => {
    const CONCURRENCY = 20;
    let activeSends = 0;
    let finished = false;

    const sendOne = async () => {
      if (isTaskCancelled(task) || finished) return;
      activeSends++;
      try {
        if (sock) {
          await sock.sendMessage(chatId, { text: messageText });
          task.sentCount++;
        }
      } catch (err) {
        // Resilient: transient network slips do not abort task
        if (err?.message?.includes("Connection Closed") || err?.message?.includes("connection closed")) {
          await new Promise((r) => setTimeout(r, 20));
        }
      } finally {
        activeSends--;
      }
    };

    try {
      while (!isTaskCancelled(task) && task.sentCount + activeSends < targetCount) {
        if (!sock) {
          await new Promise((r) => setTimeout(r, 30));
          continue;
        }

        const canLaunch = Math.min(
          CONCURRENCY - activeSends,
          Math.max(0, targetCount - (task.sentCount + activeSends))
        );

        if (canLaunch > 0) {
          for (let i = 0; i < canLaunch; i++) {
            if (isTaskCancelled(task)) break;
            sendOne();
          }
        }

        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 4);
          if (task.abortController?.signal) {
            task.abortController.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve();
            }, { once: true });
          }
        });
      }

      // Wait for any remaining in-flight sends
      while (activeSends > 0 && !isTaskCancelled(task)) {
        await new Promise((r) => setTimeout(r, 10));
      }
    } catch {
      // Guard
    } finally {
      finished = true;
      stopSpamTask(chatId, userId);
      const total = task.sentCount;
      await reply(`🛑 *Operation Completed:* Successfully delivered *${total.toLocaleString()}* message${total === 1 ? "" : "s"}.`).catch(() => {});
    }
  })();
}
