import { test } from "bun:test";
import assert from "node:assert/strict";

import { OpenCodeRunner } from "./opencode-runner";
import { toUtcIsoTimestamp } from "@shared/types";

function createCompletedMessage(
  id: string,
  content: string,
  timestamp: string,
  sender: string,
) {
  return {
    id,
    content,
    sender,
    timestamp: toUtcIsoTimestamp(timestamp),
    raw: {},
  };
}

function createErrorMessage(
  id: string,
  content: string,
  timestamp: string,
  sender: string,
  error: string,
) {
  return {
    id,
    content,
    sender,
    timestamp: toUtcIsoTimestamp(timestamp),
    error,
    raw: {},
  };
}

function createRecoveryResult(result: {
  status: "completed" | "error";
  finalMessage: string;
  messageId: string;
  timestamp: string;
  rawMessage: ReturnType<typeof createCompletedMessage> | ReturnType<typeof createErrorMessage>;
}) {
  return {
    kind: "recovered" as const,
    result: {
      ...result,
      timestamp: toUtcIsoTimestamp(result.timestamp),
    },
  };
}

function createTimedOutRecoveryResult() {
  return {
    kind: "timed_out" as const,
  };
}

function createClockRecorder() {
  const delays: number[] = [];
  return {
    delays,
    clock: {
      async sleep(ms: number) {
        delays.push(ms);
      },
    },
  };
}

for (const scenario of [
  {
    errorMessage: "terminated",
    timestamp: toUtcIsoTimestamp("2026-04-17T06:17:06.782Z"),
    messageTimestamp: "2026-04-17T06:16:08.105Z",
  },
  {
    errorMessage: "fetch failed",
    timestamp: toUtcIsoTimestamp("2026-04-27T03:49:02.477Z"),
    messageTimestamp: "2026-04-27T03:48:31.000Z",
  },
]) {
  test(`submitMessage 返回 ${scenario.errorMessage} 后，若同一 session 稍后补出正式回复，runner 应恢复该结果`, async () => {
    const expectedResult = {
      status: "completed" as const,
      finalMessage: "补回来的正式回复",
      messageId: "msg-final",
      timestamp: toUtcIsoTimestamp(scenario.timestamp),
      rawMessage: createCompletedMessage("msg-final", "补回来的正式回复", scenario.messageTimestamp, "assistant"),
    };

    const client = {
      submitMessage: async () => {
        throw new Error(scenario.errorMessage);
      },
      resolveExecutionResult: async () => {
        throw new Error("不应该走到 resolveExecutionResult");
      },
      recoverExecutionResultAfterTransportError: async (sessionId: string,
        startedAt: string,
        errorMessage: string,
      ) => {
        assert.equal(sessionId, "session-1");
        assert.match(startedAt, /^\d{4}-\d{2}-\d{2}T/);
        assert.equal(errorMessage, scenario.errorMessage);
        return createRecoveryResult({
          ...expectedResult,
          timestamp: scenario.timestamp,
          rawMessage: expectedResult.rawMessage,
        });
      },
    };

    const runner = new OpenCodeRunner(client as never);
    const result = await runner.run({
      sessionId: "session-1",
      content: "给出 poc",
      agent: "安全负责人",
      allowedDecisionTriggers: [],
    });

    assert.deepEqual(result, expectedResult);
  });
}

test("submitMessage 连续失败两次时，runner 会重试两次并返回第三次成功结果", async () => {
  let submitCount = 0;
  let recoverCount = 0;
  const { delays, clock } = createClockRecorder();
  const client = {
    submitMessage: async () => {
      submitCount += 1;
      if (submitCount <= 2) {
        throw new Error("temporary upstream failure");
      }
      return {
        ...createCompletedMessage("msg-submitted", "", "2026-05-07T10:00:00.000Z", "assistant"),
      };
    },
    resolveExecutionResult: async () => ({
      status: "completed" as const,
      finalMessage: "第二次提交成功",
      messageId: "msg-final",
      timestamp: toUtcIsoTimestamp("2026-05-07T10:00:02.000Z"),
      rawMessage: createCompletedMessage("msg-final", "第二次提交成功", "2026-05-07T10:00:02.000Z", "assistant"),
    }),
      recoverExecutionResultAfterTransportError: async (sessionId: string,
      startedAt: string,
      errorMessage: string,
    ) => {
      recoverCount += 1;
      assert.equal(sessionId, "session-1");
      assert.match(startedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(errorMessage, "temporary upstream failure");
      return createTimedOutRecoveryResult();
    },
  };

  const runner = new OpenCodeRunner(client as never, clock);
  const result = await runner.run({
    sessionId: "session-1",
    content: "继续执行",
    agent: "漏洞论证-4",
    allowedDecisionTriggers: [],
  });

  assert.equal(submitCount, 3);
  assert.equal(recoverCount, 2);
  assert.deepEqual(delays, [60_000, 60_000]);
  assert.equal(result.finalMessage, "第二次提交成功");
});

test("recovery 连续抛错两次时，runner 会继续重试直到第三次成功", async () => {
  let submitCount = 0;
  let recoverCount = 0;
  const { delays, clock } = createClockRecorder();
  const client = {
    submitMessage: async () => {
      submitCount += 1;
      if (submitCount <= 2) {
        throw new Error("temporary upstream failure");
      }
      return {
        ...createCompletedMessage("msg-submitted", "", "2026-05-07T10:00:00.000Z", "assistant"),
      };
    },
    resolveExecutionResult: async () => ({
      status: "completed" as const,
      finalMessage: "第三次尝试成功",
      messageId: "msg-final",
      timestamp: toUtcIsoTimestamp("2026-05-07T10:00:02.000Z"),
      rawMessage: createCompletedMessage("msg-final", "第三次尝试成功", "2026-05-07T10:00:02.000Z", "assistant"),
    }),
    recoverExecutionResultAfterTransportError: async () => {
      recoverCount += 1;
      throw new Error(`recovery failure ${recoverCount}`);
    },
  };

  const runner = new OpenCodeRunner(client as never, clock);
  const result = await runner.run({
    sessionId: "session-1",
    content: "继续执行",
    agent: "漏洞论证-4",
    allowedDecisionTriggers: [],
  });

  assert.equal(submitCount, 3);
  assert.equal(recoverCount, 2);
  assert.deepEqual(delays, [60_000, 60_000]);
  assert.equal(result.finalMessage, "第三次尝试成功");
});

test("resolveExecutionResult 连续返回两次 error 结果时，runner 会重试两次", async () => {
  let submitCount = 0;
  let resolveCount = 0;
  let recoverCount = 0;
  const { delays, clock } = createClockRecorder();
  const client = {
    submitMessage: async () => {
      submitCount += 1;
      return createCompletedMessage(`msg-submitted-${submitCount}`, "", "2026-05-07T10:00:00.000Z", "assistant");
    },
    resolveExecutionResult: async () => {
      resolveCount += 1;
      if (resolveCount <= 2) {
        return {
          status: "error" as const,
          finalMessage: "temporary upstream failure",
          messageId: "msg-error",
          timestamp: toUtcIsoTimestamp("2026-05-07T10:00:01.000Z"),
          rawMessage: createErrorMessage("msg-error", "", "2026-05-07T10:00:01.000Z", "assistant", "temporary upstream failure"),
        };
      }
      return {
        status: "completed" as const,
        finalMessage: "重试后恢复成功",
        messageId: "msg-final",
        timestamp: toUtcIsoTimestamp("2026-05-07T10:00:03.000Z"),
        rawMessage: createCompletedMessage("msg-final", "重试后恢复成功", "2026-05-07T10:00:03.000Z", "assistant"),
      };
    },
    recoverExecutionResultAfterTransportError: async (sessionId: string,
      startedAt: string,
      errorMessage: string,
    ) => {
      recoverCount += 1;
      assert.equal(sessionId, "session-1");
      assert.match(startedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(errorMessage, "temporary upstream failure");
      return createTimedOutRecoveryResult();
    },
  };

  const runner = new OpenCodeRunner(client as never, clock);
  const result = await runner.run({
    sessionId: "session-1",
    content: "继续执行",
    agent: "漏洞论证-4",
    allowedDecisionTriggers: [],
  });

  assert.equal(submitCount, 3);
  assert.equal(resolveCount, 3);
  assert.equal(recoverCount, 2);
  assert.deepEqual(delays, [60_000, 60_000]);
  assert.equal(result.finalMessage, "重试后恢复成功");
});

test("resolveExecutionResult 持续返回 error 结果时，runner 不应因固定次数上限停止，而应继续等待重试直到后续成功", async () => {
  let submitCount = 0;
  const { delays, clock } = createClockRecorder();
  const client = {
    submitMessage: async () => {
      submitCount += 1;
      return createCompletedMessage(`msg-submitted-${submitCount}`, "", "2026-05-07T10:00:00.000Z", "assistant");
    },
    resolveExecutionResult: async () => {
      if (submitCount <= 3) {
        return {
          status: "error" as const,
          finalMessage: "temporary upstream failure",
          messageId: `msg-error-${submitCount}`,
          timestamp: toUtcIsoTimestamp("2026-05-07T10:00:01.000Z"),
          rawMessage: createErrorMessage(`msg-error-${submitCount}`, "", "2026-05-07T10:00:01.000Z", "assistant", "temporary upstream failure"),
        };
      }
      return {
        status: "completed" as const,
        finalMessage: "第四次重试成功",
        messageId: "msg-final",
        timestamp: toUtcIsoTimestamp("2026-05-07T10:01:01.000Z"),
        rawMessage: createCompletedMessage("msg-final", "第四次重试成功", "2026-05-07T10:01:01.000Z", "assistant"),
      };
    },
    recoverExecutionResultAfterTransportError: async () => createTimedOutRecoveryResult(),
  };

  const runner = new OpenCodeRunner(client as never, clock);
  const result = await runner.run({
    sessionId: "session-1",
    content: "继续执行",
    agent: "漏洞论证-4",
    allowedDecisionTriggers: [],
  });

  assert.equal(submitCount, 4);
  assert.deepEqual(delays, [60_000, 60_000, 60_000]);
  assert.equal(result.status, "completed");
  assert.equal(result.finalMessage, "第四次重试成功");
});

test("recovery 连续返回两次 error 结果时，runner 会继续重试直到第三次 recovery 成功", async () => {
  let submitCount = 0;
  let recoverCount = 0;
  const { delays, clock } = createClockRecorder();
  const client = {
    submitMessage: async () => {
      submitCount += 1;
      throw new Error("fetch failed");
    },
    resolveExecutionResult: async () => {
      throw new Error("不应该走到 resolveExecutionResult");
    },
    recoverExecutionResultAfterTransportError: async () => {
      recoverCount += 1;
      if (recoverCount <= 2) {
        return createRecoveryResult({
          status: "error",
          finalMessage: `recovered error ${recoverCount}`,
          messageId: `msg-error-${recoverCount}`,
          timestamp: "2026-05-07T10:00:01.000Z",
          rawMessage: createErrorMessage(`msg-error-${recoverCount}`, "", "2026-05-07T10:00:01.000Z", "assistant", `recovered error ${recoverCount}`),
        });
      }
      return createRecoveryResult({
        status: "completed",
        finalMessage: "第三次 recovery 成功",
        messageId: "msg-final",
        timestamp: "2026-05-07T10:00:03.000Z",
        rawMessage: createCompletedMessage("msg-final", "第三次 recovery 成功", "2026-05-07T10:00:03.000Z", "assistant"),
      });
    },
  };

  const runner = new OpenCodeRunner(client as never, clock);
  const result = await runner.run({
    sessionId: "session-1",
    content: "继续执行",
    agent: "漏洞论证-4",
    allowedDecisionTriggers: [],
  });

  assert.equal(submitCount, 3);
  assert.equal(recoverCount, 3);
  assert.deepEqual(delays, [60_000, 60_000]);
  assert.equal(result.status, "completed");
  assert.equal(result.finalMessage, "第三次 recovery 成功");
});

test("正常完成的回复不应触发重试", async () => {
  let submitCount = 0;
  let recoverCount = 0;
  const { delays, clock } = createClockRecorder();
  const client = {
    submitMessage: async () => {
      submitCount += 1;
      return createCompletedMessage("msg-submitted", "", "2026-05-07T10:00:00.000Z", "assistant");
    },
    resolveExecutionResult: async () => ({
      status: "completed" as const,
      finalMessage: "分析结论：本次已正常完成",
      messageId: "msg-final",
      timestamp: toUtcIsoTimestamp("2026-05-07T10:00:02.000Z"),
      rawMessage: createCompletedMessage("msg-final", "分析结论：本次已正常完成", "2026-05-07T10:00:02.000Z", "assistant"),
    }),
    recoverExecutionResultAfterTransportError: async () => {
      recoverCount += 1;
      return createTimedOutRecoveryResult();
    },
  };

  const runner = new OpenCodeRunner(client as never, clock);
  const result = await runner.run({
    sessionId: "session-1",
    content: "继续执行",
    agent: "漏洞论证-4",
    allowedDecisionTriggers: [],
  });

  assert.equal(submitCount, 1);
  assert.equal(recoverCount, 0);
  assert.deepEqual(delays, []);
  assert.equal(result.status, "completed");
});
