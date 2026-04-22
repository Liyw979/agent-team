import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { appendAppLog, buildTaskLogFilePath, initAppFileLogger } from "./app-log";

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-app-log-"));
}

test("appendAppLog writes task-scoped records into logs/tasks/<taskId>.log", () => {
  const userDataPath = createTempDir();
  initAppFileLogger(userDataPath);

  appendAppLog("info", "task.started", { cwd: "/workspace" }, { taskId: "task-123" });
  appendAppLog("error", "task.failed", { reason: "boom" }, { runtimeKey: "task-123" });

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

  appendAppLog("warn", "task.warning", { message: "check" }, { taskId: "task-456" });

  assert.equal(
    fs.existsSync(path.join(userDataPath, "logs", "agent-team.log")),
    false,
  );
  assert.equal(
    fs.existsSync(buildTaskLogFilePath(userDataPath, "task-456")),
    true,
  );
});

test("appendAppLog ignores entries without a task-scoped log id", () => {
  const userDataPath = createTempDir();
  initAppFileLogger(userDataPath);

  appendAppLog("info", "cli.run_failed", { message: "missing task scope" });
  appendAppLog("info", "cli.run_failed", { message: "path runtime key" }, {
    runtimeKey: "D:\\workspace",
  });

  const taskLogDir = path.join(userDataPath, "logs", "tasks");
  const logFiles = fs.existsSync(taskLogDir) ? fs.readdirSync(taskLogDir) : [];
  assert.deepEqual(logFiles, []);
});
