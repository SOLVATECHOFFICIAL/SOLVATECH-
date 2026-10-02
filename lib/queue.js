export function createSerialQueue() {
  let tail = Promise.resolve();
  return {
    add(task) {
      const run = tail.then(task, task);
      tail = run.catch(() => {});
      return run;
    },
  };
}

// A slow download in one chat must not block every other WhatsApp chat.
// Keep ordering inside a chat, while allowing unrelated chats to run at once.
export function createKeyedQueue(timeoutMs = 45000) {
  const tails = new Map();
  return {
    add(key, task) {
      const queueKey = String(key || "global");
      const previous = tails.get(queueKey) || Promise.resolve();
      // Ensure each task completes or times out cleanly without leaking timers or blocking the chat queue
      const run = previous.then(async () => {
        let timerId = null;
        try {
          return await Promise.race([
            Promise.resolve().then(() => task()),
            new Promise((resolve) => {
              timerId = setTimeout(() => {
                resolve(null);
              }, timeoutMs);
            }),
          ]);
        } finally {
          if (timerId) clearTimeout(timerId);
        }
      });
      const settled = run.catch(() => {});
      tails.set(queueKey, settled);
      settled.finally(() => {
        if (tails.get(queueKey) === settled) tails.delete(queueKey);
      });
      return run;
    },
  };
}
