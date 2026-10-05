// Ultra-Fast Resilient Spam & Task Lifecycle Manager
// Uses AbortController and multi-key normalization for <1ms instantaneous halts

const activeTasks = new Map();
const userTaskKeys = new Map(); // userId -> Set<chatKey>

export function normalizeChatKey(chatId) {
  if (!chatId) return "";
  const str = String(chatId).trim();
  const [userPart, domain] = str.split("@");
  if (!domain) return str.split(":")[0];
  const cleanUser = userPart.split(":")[0];
  return `${cleanUser}@${domain}`;
}

export function startSpamTask(chatId, targetCount = Infinity, userId = "default") {
  const rawKey = String(chatId || "").trim();
  const normKey = normalizeChatKey(chatId);

  // Instantly cancel any prior tasks in this chat or for this user in this chat
  stopSpamTask(chatId, userId);

  const abortController = new AbortController();
  const task = {
    cancelled: false,
    sentCount: 0,
    targetCount: Number(targetCount) > 0 ? Number(targetCount) : Infinity,
    startedAt: Date.now(),
    chatId: rawKey,
    normKey,
    userId,
    abortController,
    cancel() {
      this.cancelled = true;
      try {
        this.abortController.abort();
      } catch {}
    },
  };

  activeTasks.set(rawKey, task);
  if (normKey && normKey !== rawKey) {
    activeTasks.set(normKey, task);
  }

  if (userId) {
    if (!userTaskKeys.has(userId)) {
      userTaskKeys.set(userId, new Set());
    }
    userTaskKeys.get(userId).add(rawKey);
    userTaskKeys.get(userId).add(normKey);
  }

  return task;
}

export function stopSpamTask(chatId = null, userId = null) {
  let stopped = false;
  const rawKey = chatId ? String(chatId).trim() : null;
  const normKey = chatId ? normalizeChatKey(chatId) : null;

  // 1. Direct match by raw key
  if (rawKey && activeTasks.has(rawKey)) {
    const task = activeTasks.get(rawKey);
    if (task) {
      task.cancel();
      stopped = true;
    }
    activeTasks.delete(rawKey);
  }

  // 2. Direct match by normalized key
  if (normKey && activeTasks.has(normKey)) {
    const task = activeTasks.get(normKey);
    if (task) {
      task.cancel();
      stopped = true;
    }
    activeTasks.delete(normKey);
  }

  // 3. Scan active tasks for matching chatId in object or userId
  for (const [key, task] of activeTasks.entries()) {
    if (!task) {
      activeTasks.delete(key);
      continue;
    }

    const matchesChat = (rawKey && (task.chatId === rawKey || task.normKey === normKey || key === rawKey || key === normKey));
    const matchesUser = (userId && task.userId === userId);

    if (matchesChat || matchesUser) {
      task.cancel();
      stopped = true;
      activeTasks.delete(key);
    }
  }

  // 4. Cleanup user map
  if (userId && userTaskKeys.has(userId)) {
    const keys = userTaskKeys.get(userId);
    for (const k of keys) {
      if (activeTasks.has(k)) {
        const t = activeTasks.get(k);
        if (t) {
          t.cancel();
          stopped = true;
        }
        activeTasks.delete(k);
      }
    }
    userTaskKeys.delete(userId);
  }

  return stopped;
}

export function isTaskCancelled(task) {
  if (!task) return true;
  if (task.cancelled) return true;
  if (task.abortController?.signal?.aborted) return true;
  if (task.sentCount >= task.targetCount) return true;
  return false;
}

export function getSpamTask(chatId) {
  const rawKey = String(chatId || "").trim();
  const normKey = normalizeChatKey(chatId);
  return activeTasks.get(rawKey) || activeTasks.get(normKey) || null;
}

export function stopAllSpamTasks() {
  let count = 0;
  for (const [key, task] of activeTasks.entries()) {
    if (task) {
      task.cancel();
      count++;
    }
  }
  activeTasks.clear();
  userTaskKeys.clear();
  return count > 0;
}
