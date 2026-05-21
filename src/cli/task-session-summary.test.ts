import assert from "node:assert/strict";
import { test } from "bun:test";

import { renderTaskSessionSummary } from "./task-session-summary";

test("renderTaskSessionSummary 只输出日志路径", () => {
  assert.equal(
    renderTaskSessionSummary({
      kind: "log-only",
      logFilePath: "/tmp/agent-team/logs/tasks/task-123.log",
    }),
    "\n日志：/tmp/agent-team/logs/tasks/task-123.log",
  );
});

test("renderTaskSessionSummary 在提供网页地址时会一并输出网页地址", () => {
  assert.equal(
    renderTaskSessionSummary({
      kind: "with-url",
      logFilePath: "/tmp/agent-team/logs/tasks/task-123.log",
      taskUrl: "http://localhost:4310/",
    }),
    [
      "",
      "日志：/tmp/agent-team/logs/tasks/task-123.log",
      "网页：http://localhost:4310/",
    ].join("\n"),
  );
});
