import assert from "node:assert/strict";
import test from "node:test";

import { renderTaskSessionSummary } from "./task-session-summary";

test("renderTaskSessionSummary 会输出日志路径和 taskId", () => {
  assert.equal(
    renderTaskSessionSummary({
      logFilePath: "/tmp/agentflow/logs/agentflow.log",
      taskId: "task-123",
    }),
    [
      "日志: /tmp/agentflow/logs/agentflow.log",
      "taskId: task-123",
    ].join("\n"),
  );
});
