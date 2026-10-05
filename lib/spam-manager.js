// Active spam tasks: Map<chatId, { cancelled: boolean, sentCount: number, targetCount: number, startedAt: number, chatId: string, userId: string }>
const activeTasks = new Map();

function cleanChatId(chatId) {
  return String(chatId || "").trim();
}

export function startSpamTask(chatId, targetCount = Infinity, userId = "default") {
  const key = cleanChatId(chatId);
  // Cancel any prior task in this chat immediately
  if (activeTasks.has(key)) {
    const prev = activeTasks.get(key);
    if (prev) {
      prev.cancelled = true;
    }
  }
  const task = {
    cancelled: false,
    sentCount: 0,
    targetCount: Number(targetCount) > 0 ? Number(targetCount) : Infinity,
    startedAt: Date.now(),
    chatId: key,
    userId,
  };
  activeTasks.set(key, task);
  return task;
}

export function stopSpamTask(chatId, userId = null) {
  const key = cleanChatId(chatId);
  let stopped = false;
  if (activeTasks.has(key)) {
    const task = activeTasks.get(key);
    if (task) {
      task.cancelled = true;
      stopped = true;
    }
    activeTasks.delete(key);
  }
  if (userId) {
    for (const [k, t] of activeTasks.entries()) {
      if (t && t.userId === userId) {
        t.cancelled = true;
        activeTasks.delete(k);
        stopped = true;
      }
    }
  }
  return stopped;
}

export function isTaskCancelled(task) {
  if (!task) return true;
  if (task.cancelled) return true;
  if (task.sentCount >= task.targetCount) return true;
  return false;
}

export function getSpamTask(chatId) {
  return activeTasks.get(cleanChatId(chatId)) || null;
}

export function stopAllSpamTasks() {
  for (const task of activeTasks.values()) {
    if (task) {
      task.cancelled = true;
    }
  }
  activeTasks.clear();
}
