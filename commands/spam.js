import { isTaskCancelled, startSpamTask, stopSpamTask } from "../lib/spam-manager.js";

/**
 * Super-Charged Spam & Broadcast Engine (10 messages/second Light-Speed Dispatch)
 * • Instantly deletes the incoming .spam command message.
 * • No starting announcement — completely silent launch.
 * • Strict rate of exactly 10 messages per second (100ms interval).
 * • Executes to the last phase without stopping prematurely.
 * • When finished, simply sends "done".
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

  // Background dispatcher: exactly 10 messages per second, executes to the last phase
  (async () => {
    try {
      while (!isTaskCancelled(task) && task.sentCount < targetCount) {
        if (!sock) {
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }

        try {
          await sock.sendMessage(chatId, { text: messageText });
          task.sentCount++;
        } catch (err) {
          // Resilient: keep going to the last phase even on transient network slips
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }

        // 10 messages per second = 100ms delay between dispatches
        if (task.sentCount < targetCount && !isTaskCancelled(task)) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 100);
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
      }
    } catch {
      // Guard
    } finally {
      stopSpamTask(chatId, userId);
      // When finished, simply say "done" without any announcement
      if (!isTaskCancelled(task) && sock) {
        await sock.sendMessage(chatId, { text: "done" }).catch(() => {});
      }
    }
  })();
}
