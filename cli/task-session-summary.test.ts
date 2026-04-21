import assert from "node:assert/strict";
import test from "node:test";

import { renderTaskSessionSummary } from "./task-session-summary";

test("renderTaskSessionSummary outputs the task log path and task id", () => {
  assert.equal(
    renderTaskSessionSummary({
      logFilePath: "/tmp/agent-team/logs/tasks/task-123.log",
      taskId: "task-123",
    }),
    [
      "日志: /tmp/agent-team/logs/tasks/task-123.log",
      "taskId: task-123",
    ].join("\n"),
  );
});
