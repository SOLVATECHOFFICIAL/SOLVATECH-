import { isTaskCancelled, startSpamTask, stopSpamTask } from "../lib/spam-manager.js";

/**
 * Super-Charged Spam & Broadcast Engine (Ultra High-Speed Resilient Dispatch)
 * • Instantly deletes the incoming .spam command message.
 * • No starting announcement — completely silent launch.
 * • Dispatches at 20x speed with 5ms pipelined concurrency.
 * • Executes to the last phase without stopping prematurely.
 * • When finished, simply replies "done".
 */
export default async function spam({ sock, chatId, text, reply, userId = "default", message }) {
  // Instantly delete the user's .spam trigger message (Zero-Trace)
  if (message?.key && sock) {
    sock.sendMessage(chatId, { delete: message.key }).catch(() => {});
  }

  const rawInput = String(text || "").trim();
  if (!rawInput) {
    return reply(
      `❌ *Limit Missing:* Please specify the count limit at the end.\n` +
      `_Example: *.spam wassup 20* or *.spam okay 50*_`
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

  // If no count provided, require it: "if user use .spam okay don't anser say pit limit etc"
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

  // Background dispatcher: 20x faster pipelined concurrency, executes to the last phase
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
        // Resilient: keep going to the last phase even on transient network slips
        if (err?.message?.includes("Connection Closed") || err?.message?.includes("connection closed")) {
          await new Promise((r) => setTimeout(r, 10));
        }
      } finally {
        activeSends--;
      }
    };

    try {
      while (!isTaskCancelled(task) && task.sentCount + activeSends < targetCount) {
        if (!sock) {
          await new Promise((r) => setTimeout(r, 20));
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

        // 20x faster dispatch tick (5ms interval)
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 5);
          if (task.abortController?.signal) {
            task.abortController.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true }
            );
          }
        });
      }

      // Wait for any remaining in-flight sends
      while (activeSends > 0 && !isTaskCancelled(task)) {
        await new Promise((r) => setTimeout(r, 5));
      }
    } catch {
      // Guard
    } finally {
      finished = true;
      stopSpamTask(chatId, userId);
      // When finished, simply say "done"
      if (!isTaskCancelled(task) && sock) {
        await sock.sendMessage(chatId, { text: "done" }).catch(() => {});
      }
    }
  })();
}
