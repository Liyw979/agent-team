import assert from "node:assert/strict";
import test from "node:test";

import { renderTaskSessionSummary } from "./task-session-summary";

test("renderTaskSessionSummary 会输出日志路径、taskId 和 task show 命令", () => {
  assert.equal(
    renderTaskSessionSummary({
      logFilePath: "/tmp/agentflow/logs/agentflow.log",
      taskId: "task-123",
    }),
    [
      "日志: /tmp/agentflow/logs/agentflow.log",
      "taskId: task-123",
      'show: npm run cli -- task show "task-123"',
    ].join("\n"),
  );
});
