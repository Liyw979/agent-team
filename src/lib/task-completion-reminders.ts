import type { TaskRecord } from "@shared/types";

const TASK_COMPLETION_REMINDER_STORAGE_KEY = "agentflow.task-completion-reminders.v1";

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

export type TaskCompletionReminderAcks = Record<string, string>;

function isTerminalTask(task: Pick<TaskRecord, "status">) {
  return task.status === "finished" || task.status === "failed";
}

export function loadTaskCompletionReminderAcks(
  storage: StorageReader | null | undefined,
): TaskCompletionReminderAcks {
  if (!storage) {
    return {};
  }

  try {
    const raw = storage.getItem(TASK_COMPLETION_REMINDER_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string" && entry[0].length > 0,
      ),
    );
  } catch {
    return {};
  }
}

export function persistTaskCompletionReminderAcks(
  storage: StorageWriter | null | undefined,
  acks: TaskCompletionReminderAcks,
) {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(TASK_COMPLETION_REMINDER_STORAGE_KEY, JSON.stringify(acks));
  } catch {
    // 忽略浏览器存储不可用场景，避免阻断主界面逻辑。
  }
}

export function shouldShowTaskCompletionReminder(
  task: Pick<TaskRecord, "id" | "status" | "completedAt">,
  acks: TaskCompletionReminderAcks,
) {
  if (!isTerminalTask(task) || !task.completedAt) {
    return false;
  }

  return acks[task.id] !== task.completedAt;
}

export function acknowledgeTaskCompletionReminder(
  acks: TaskCompletionReminderAcks,
  task: Pick<TaskRecord, "id" | "status" | "completedAt">,
) {
  if (!isTerminalTask(task) || !task.completedAt || acks[task.id] === task.completedAt) {
    return acks;
  }

  return {
    ...acks,
    [task.id]: task.completedAt,
  };
}

export function pruneTaskCompletionReminderAcks(
  acks: TaskCompletionReminderAcks,
  tasks: Array<Pick<TaskRecord, "id" | "status" | "completedAt">>,
) {
  const latestCompletedAtByTaskId = new Map(
    tasks
      .filter((task) => isTerminalTask(task) && typeof task.completedAt === "string")
      .map((task) => [task.id, task.completedAt]),
  );

  let changed = false;
  const next: TaskCompletionReminderAcks = {};
  for (const [taskId, completedAt] of Object.entries(acks)) {
    if (latestCompletedAtByTaskId.get(taskId) === completedAt) {
      next[taskId] = completedAt;
      continue;
    }
    changed = true;
  }

  return changed ? next : acks;
}

export function countVisibleTaskCompletionReminders(
  tasks: Array<Pick<TaskRecord, "id" | "status" | "completedAt">>,
  acks: TaskCompletionReminderAcks,
) {
  return tasks.filter((task) => shouldShowTaskCompletionReminder(task, acks)).length;
}
