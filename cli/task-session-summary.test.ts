import assert from "node:assert/strict";
import test from "node:test";

import { renderTaskSessionSummary } from "./task-session-summary";

test("renderTaskSessionSummary 只输出日志路径", () => {
  assert.equal(
    renderTaskSessionSummary({
      logFilePath: "/tmp/agent-team/logs/tasks/task-123.log",
    }),
    "日志: /tmp/agent-team/logs/tasks/task-123.log",
  );
});

test("renderTaskSessionSummary 在提供网页地址时会一并输出 url", () => {
  assert.equal(
    renderTaskSessionSummary({
      logFilePath: "/tmp/agent-team/logs/tasks/task-123.log",
      taskUrl: "http://localhost:4310/?taskId=task-123",
    }),
    [
      "日志: /tmp/agent-team/logs/tasks/task-123.log",
      "url: http://localhost:4310/?taskId=task-123",
    ].join("\n"),
  );
});
