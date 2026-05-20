import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  appendAppLog,
  bindCurrentTaskLog,
  buildTaskLogFilePath,
  initAppFileLogger,
} from "./app-log";

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-app-log-"));
}

test("appendAppLog writes task-scoped records into logs/tasks/<taskId>.log", () => {
  const userDataPath = createTempDir();
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog("task-123");

  appendAppLog("info", "task.started", { cwd: "/workspace" });
  appendAppLog("error", "task.failed", { reason: "boom" });

  const logFilePath = buildTaskLogFilePath(userDataPath, "task-123");
  const lines = fs.readFileSync(logFilePath, "utf8").trim().split("\n");

  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]!).event, "task.started");
  assert.equal(JSON.parse(lines[0]!).taskId, "task-123");
  assert.equal(JSON.parse(lines[1]!).event, "task.failed");
  assert.equal(JSON.parse(lines[1]!).taskId, "task-123");
});

test("appendAppLog does not recreate the legacy agent-team.log file", () => {
  const userDataPath = createTempDir();
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog("task-456");

  appendAppLog("warn", "task.warning", { message: "check" });

  assert.equal(
    fs.existsSync(path.join(userDataPath, "logs", "agent-team.log")),
    false,
  );
  assert.equal(
    fs.existsSync(buildTaskLogFilePath(userDataPath, "task-456")),
    true,
  );
});

test("appendAppLog exposes missing current task log binding", () => {
  const previousUserDataPath = createTempDir();
  initAppFileLogger(previousUserDataPath);
  bindCurrentTaskLog("task-before-reset");
  appendAppLog("info", "task.before_reset", {});

  const nextUserDataPath = createTempDir();
  initAppFileLogger(nextUserDataPath);
  assert.throws(
    () => appendAppLog("info", "task.after_reset", {}),
    /当前进程尚未绑定 Task 日志/u,
  );
});

test("bindCurrentTaskLog rejects empty task log id", () => {
  assert.throws(
    () => bindCurrentTaskLog(""),
    /Task 日志 id 不能为空/u,
  );
});
