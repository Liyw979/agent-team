import test from "node:test";
import assert from "node:assert/strict";

import { OpenCodeRunner } from "./opencode-runner";

test("submitMessage 返回 terminated 后，若同一 session 稍后补出正式回复，runner 应恢复该结果", async () => {
  const expectedResult = {
    status: "completed" as const,
    finalMessage: "补回来的正式回复",
    fallbackMessage: null,
    messageId: "msg-final",
    timestamp: "2026-04-17T06:17:06.782Z",
    rawMessage: {
      id: "msg-final",
      content: "补回来的正式回复",
      sender: "assistant",
      timestamp: "2026-04-17T06:16:08.105Z",
      completedAt: "2026-04-17T06:17:06.782Z",
      error: null,
      raw: null,
    },
  };

  const client = {
    submitMessage: async () => {
      throw new Error("terminated");
    },
    resolveExecutionResult: async () => {
      throw new Error("不应该走到 resolveExecutionResult");
    },
    recoverExecutionResultAfterTransportError: async (
      projectPath: string,
      sessionId: string,
      startedAt: string,
      errorMessage: string,
    ) => {
      assert.equal(projectPath, "/tmp/project");
      assert.equal(sessionId, "session-1");
      assert.match(startedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(errorMessage, "terminated");
      return expectedResult;
    },
  };

  const runner = new OpenCodeRunner(client as never);
  const result = await runner.run({
    projectPath: "/tmp/project",
    sessionId: "session-1",
    content: "给出 poc",
    agent: "安全负责人",
  });

  assert.deepEqual(result, expectedResult);
});
