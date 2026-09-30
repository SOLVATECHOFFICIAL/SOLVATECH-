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
      const run = previous.then(task, task);
      const settled = run.catch(() => {});
      tails.set(queueKey, settled);
      settled.finally(() => {
        if (tails.get(queueKey) === settled) tails.delete(queueKey);
      });
      return run;
    },
  };
}