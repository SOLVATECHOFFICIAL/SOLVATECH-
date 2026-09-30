// Active spam tasks: Map<key, { cancelled: boolean }>
const activeTasks = new Map();

function taskKey(userId, chatId) {
  return `${userId || "default"}:${chatId}`;
}

export function startSpamTask(userId, chatId) {
  const key = taskKey(userId, chatId);
  // Cancel any prior task in this chat/account
  if (activeTasks.has(key)) {
    const prev = activeTasks.get(key);
    if (prev) {
      prev.cancelled = true;
    }
  }
  const task = { cancelled: false };
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
  return Boolean(task?.cancelled);
}

export function stopAllSpamTasks() {
  for (const task of activeTasks.values()) {
    if (task) {
      task.cancelled = true;
    }
  }
  activeTasks.clear();
}
