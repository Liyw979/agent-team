import fs from "node:fs";
import path from "node:path";

let appLogFilePath: string | null = null;

export function initAppFileLogger(userDataPath: string) {
  const logDir = path.join(userDataPath, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  appLogFilePath = path.join(logDir, "agentflow.log");
  fs.closeSync(fs.openSync(appLogFilePath, "a"));
  return appLogFilePath;
}

export function getAppLogFilePath() {
  return appLogFilePath;
}

export function appendAppLog(
  level: "info" | "warn" | "error",
  event: string,
  payload: Record<string, unknown>,
) {
  if (!appLogFilePath) {
    return;
  }

  const record = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...payload,
  };

  try {
    fs.appendFileSync(appLogFilePath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Never let log write failures block the main flow.
  }
}
