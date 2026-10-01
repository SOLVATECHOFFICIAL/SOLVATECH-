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
export function createKeyedQueue() {
  const tails = new Map();
  return {
    add(key, task) {
      const queueKey = String(key || "global");
      const previous = tails.get(queueKey) || Promise.resolve();
      // Ensure each task completes or times out within 30s so the queue never gets stuck
      const run = previous.then(async () => {
        try {
          await Promise.race([
            Promise.resolve().then(() => task()),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Queue task execution timeout")), 30000))
          ]);
        } catch (err) {
          // Keep queue moving forward to the next message even if one task fails
          throw err;
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