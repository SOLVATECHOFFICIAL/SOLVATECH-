// Active spam tasks: Map<key, { cancelled: boolean, sentCount: number, targetCount: number, startedAt: number }>
const activeTasks = new Map();

function taskKey(userId, chatId) {
  return `${userId || "default"}:${chatId}`;
}

export function startSpamTask(userId, chatId, targetCount = Infinity) {
  const key = taskKey(userId, chatId);
  // Cancel any prior task in this chat/account
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
  };
  activeTasks.set(key, task);
  return task;
}

export function stopSpamTask(userId, chatId) {
  const key = taskKey(userId, chatId);
  const task = activeTasks.get(key);
  if (task) {
    task.cancelled = true;
    activeTasks.delete(key);
    return true;
  }
  return false;
}

export function isTaskCancelled(task) {
  if (!task) return true;
  if (task.cancelled) return true;
  if (task.sentCount >= task.targetCount) return true;
  return false;
}

export function getSpamTask(userId, chatId) {
  return activeTasks.get(taskKey(userId, chatId)) || null;
}

export function stopAllSpamTasks() {
  for (const task of activeTasks.values()) {
    if (task) {
      task.cancelled = true;
    }
  }
  activeTasks.clear();
}

