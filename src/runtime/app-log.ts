import fs from "node:fs";
import path from "node:path";

const INVALID_LOG_FILE_SEGMENT_PATTERN = /[\\/:*?"<>|]/;

let appLogRootPath: string | null = null;

export interface AppLogScope {
  taskId?: string | null;
  runtimeKey?: string | null;
}

export function buildTaskLogFilePath(userDataPath: string, taskId: string) {
  return path.join(userDataPath, "logs", "tasks", `${taskId}.log`);
}

function isTaskLogId(value: string): boolean {
  const normalized = value.trim();
  return normalized.length > 0
    && normalized !== "."
    && normalized !== ".."
    && !INVALID_LOG_FILE_SEGMENT_PATTERN.test(normalized);
}

function resolveTaskLogId(scope?: AppLogScope): string | null {
  if (typeof scope?.taskId === "string" && isTaskLogId(scope.taskId)) {
    return scope.taskId.trim();
  }
  if (typeof scope?.runtimeKey === "string" && isTaskLogId(scope.runtimeKey)) {
    return scope.runtimeKey.trim();
  }
  return null;
}

export function initAppFileLogger(userDataPath: string) {
  const taskLogDir = path.join(userDataPath, "logs", "tasks");
  fs.mkdirSync(taskLogDir, { recursive: true });
  appLogRootPath = userDataPath;
  return taskLogDir;
}

export function appendAppLog(
  level: "info" | "warn" | "error",
  event: string,
  payload: Record<string, unknown>,
  scope?: AppLogScope,
) {
  if (!appLogRootPath) {
    return;
  }
  const taskId = resolveTaskLogId(scope);
  if (!taskId) {
    return;
  }
  const appLogFilePath = buildTaskLogFilePath(appLogRootPath, taskId);

  const record = {
    timestamp: new Date().toISOString(),
    level,
    event,
    taskId,
    ...payload,
  };

  try {
    fs.mkdirSync(path.dirname(appLogFilePath), { recursive: true });
    fs.appendFileSync(appLogFilePath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Never let log write failures block the main flow.
  }
}
