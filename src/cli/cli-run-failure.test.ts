import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { bindCurrentTaskLog, buildTaskLogFilePath, initAppFileLogger } from "../runtime/app-log";
import { reportCliRunFailure } from "./cli-run-failure";

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-cli-run-failure-"));
}

test("reportCliRunFailure 在已有当前 task 日志时写入 cli.run_failed 并打印诊断路径", () => {
  const userDataPath = createTempDir();
  initAppFileLogger(userDataPath);

  const taskId = "task-cli-run-failed";
  bindCurrentTaskLog(taskId);
  const taskLogFilePath = buildTaskLogFilePath(userDataPath, taskId);
  const printedLogPaths: string[] = [];

  const printed = reportCliRunFailure({
    context: {
      kind: "task",
      logFilePath: taskLogFilePath,
    },
    message: "boom",
    cwd: "/workspace/demo",
    didPrintDiagnostics: false,
    printDiagnostics: (logFilePath) => {
      printedLogPaths.push(logFilePath);
    },
  });

  assert.equal(printed, true);
  assert.deepEqual(printedLogPaths, [taskLogFilePath]);

  const lines = fs.readFileSync(taskLogFilePath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]!);
  assert.equal(record.event, "cli.run_failed");
  assert.equal(record.message, "boom");
  assert.equal(record.taskId, taskId);
});
