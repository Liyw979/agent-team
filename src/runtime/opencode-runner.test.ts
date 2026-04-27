import test from "node:test";
import assert from "node:assert/strict";

import { OpenCodeRunner } from "./opencode-runner";

for (const scenario of [
  {
    errorMessage: "terminated",
    timestamp: "2026-04-17T06:17:06.782Z",
    completedAt: "2026-04-17T06:17:06.782Z",
    messageTimestamp: "2026-04-17T06:16:08.105Z",
  },
  {
    errorMessage: "fetch failed",
    timestamp: "2026-04-27T03:49:02.477Z",
    completedAt: "2026-04-27T03:49:02.477Z",
    messageTimestamp: "2026-04-27T03:48:31.000Z",
  },
]) {
  test(`submitMessage 返回 ${scenario.errorMessage} 后，若同一 session 稍后补出正式回复，runner 应恢复该结果`, async () => {
    const expectedResult = {
      status: "completed" as const,
      finalMessage: "补回来的正式回复",
      messageId: "msg-final",
      timestamp: scenario.timestamp,
      rawMessage: {
        id: "msg-final",
        content: "补回来的正式回复",
        sender: "assistant",
        timestamp: scenario.messageTimestamp,
        completedAt: scenario.completedAt,
        error: null,
        raw: null,
      },
    };

    const client = {
      submitMessage: async () => {
        throw new Error(scenario.errorMessage);
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
        assert.equal(errorMessage, scenario.errorMessage);
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
}
