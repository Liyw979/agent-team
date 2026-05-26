import fs from "node:fs";
import path from "node:path";
import { toUtcIsoTimestamp } from "@shared/types";

// 2026-05-26: 用户要求网络日志只写入文件，不输出到控制台。
let appLogRootPath = "";
let currentTaskLogId = "";

type AppLogOutput = "file-and-stdout" | "file-only";

export function buildTaskLogFilePath(userDataPath: string, taskId: string) {
  return path.join(userDataPath, "logs", "tasks", `${taskId}.log`);
}

export function initAppFileLogger(userDataPath: string) {
  const taskLogDir = path.join(userDataPath, "logs", "tasks");
  fs.mkdirSync(taskLogDir, { recursive: true });
  appLogRootPath = userDataPath;
  currentTaskLogId = "";
  return taskLogDir;
}

export function bindCurrentTaskLog(taskId: string) {
  if (taskId.length === 0) {
    throw new Error("Task 日志 id 不能为空");
  }
  currentTaskLogId = taskId;
}

export function appendAppLog(
  level: "info" | "warn" | "error",
  event: string,
  payload: Record<string, unknown>,
  output: AppLogOutput = "file-and-stdout",
) {
  if (!appLogRootPath) {
    throw new Error("应用日志目录尚未初始化");
  }
  if (!currentTaskLogId) {
    throw new Error("当前进程尚未绑定 Task 日志");
  }
  const appLogFilePath = buildTaskLogFilePath(appLogRootPath, currentTaskLogId);

  const record = {
    timestamp: toUtcIsoTimestamp(new Date().toISOString()),
    level,
    event,
    taskId: currentTaskLogId,
    ...payload,
  };

  fs.mkdirSync(path.dirname(appLogFilePath), { recursive: true });
  const line = `${JSON.stringify(record)}\n`;
  fs.appendFileSync(appLogFilePath, line, "utf8");
  if (output === "file-and-stdout") {
    process.stdout.write(line);
  }
}
