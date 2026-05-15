import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildTaskLogFilePath, initAppFileLogger, runWithTaskLogScope } from "./app-log";
import type { OpenCodeNormalizedMessage, OpenCodeSessionRuntime } from "./opencode-client";
import { OpenCodeClient, type ServeHandle } from "./opencode-client";
import { buildRuntimeActivityFreshness, isRuntimeActivityFreshnessNewer } from "./runtime-activity-freshness";
import { toUtcIsoTimestamp } from "@shared/types";

class TestOpenCodeClient extends OpenCodeClient {
  declare request: OpenCodeClient["request"];
}

type TestRequestPathname = Parameters<TestOpenCodeClient["request"]>[0];
type TestRequestOptions = Parameters<TestOpenCodeClient["request"]>[1];
type TestRequestResult = ReturnType<TestOpenCodeClient["request"]>;

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-opencode-client-"));
}

function createDetachedServeHandle(port: number) {
  return {
    process: {
      pid: 0,
      killed: true,
      kill() {
        return true;
      },
      on() {
        return this;
      },
      off() {
        return this;
      },
      stderr: {
        on() {
          return this;
        },
      },
      stdout: {
        on() {
          return this;
        },
      },
    },
    port,
  } as unknown as ServeHandle;
}

function createCompletedMessage(input: {
  id: string;
  content: string;
  timestamp: string;
  sender: string;
  raw: unknown;
}): OpenCodeNormalizedMessage {
  return {
    id: input.id,
    content: input.content,
    sender: input.sender,
    timestamp: toUtcIsoTimestamp(input.timestamp),
    raw: input.raw,
  };
}

function createErrorMessage(input: {
  id: string;
  content: string;
  timestamp: string;
  sender: string;
  error: string;
  raw: unknown;
}): OpenCodeNormalizedMessage {
  return {
    id: input.id,
    content: input.content,
    sender: input.sender,
    timestamp: toUtcIsoTimestamp(input.timestamp),
    error: input.error,
    raw: input.raw,
  };
}

function createClient(cwd = createTempDir()) {
  const normalizedCwd = path.resolve(cwd);
  const client = new OpenCodeClient({
    server: createDetachedServeHandle(43127),
  }) as OpenCodeClient & {
    request: (pathname: TestRequestPathname, options: TestRequestOptions) => TestRequestResult;
    getSessionMessage: (sessionId: string, messageId: string) => Promise<unknown>;
    listSessionMessages: (sessionId: string, limit: number) => Promise<unknown[]>;
  };
  return {
    client,
    cwd: normalizedCwd,
  };
}

async function withFastForwardedTimeouts<T>(
  callback: () => Promise<T>,
  stepMs = 400,
): Promise<T> {
  const originalDateNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  let nowMs = originalDateNow();

  Date.now = () => nowMs;
  globalThis.setTimeout = (((handler: (...args: unknown[]) => void, _timeout: number, ...args: unknown[]) => {
    return originalSetTimeout(() => {
      nowMs += stepMs;
      handler(...args);
    }, 0);
  }) as typeof setTimeout);

  try {
    return await callback();
  } finally {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
  }
}

function assertActivityAt<T>(
  items: T[],
  index: number,
): T {
  const item = items[index];
  assert.ok(item);
  return item as T;
}

async function captureStdout<T>(action: () => Promise<T>): Promise<{ stdout: string; result: T }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const stdoutMessages: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutMessages.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;

  try {
    const result = await action();
    return {
      stdout: stdoutMessages.join(""),
      result,
    };
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
}

function readTaskEventRecords(userDataPath: string, taskId: string, event: string): Record<string, unknown>[] {
  return fs.readFileSync(buildTaskLogFilePath(userDataPath, taskId), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record["event"] === event);
}

test("request 会跟随当前 serverHandle 的实际端口", async () => {
  await withFastForwardedTimeouts(async () => {
    const { client } = createClient();
    const typed = client as OpenCodeClient & {
      request: (pathname: TestRequestPathname, options: TestRequestOptions) => TestRequestResult;
    };

    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    try {
      await typed.request("/session", {
        method: "GET",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(requestedUrl, "http://127.0.0.1:43127/session");
  }, 1);
});

test("request 失败时会写入 task 级失败日志", async () => {
  const userDataPath = createTempDir();
  initAppFileLogger(userDataPath);
  const { client } = createClient();
  const typed = client as OpenCodeClient & {
    request: (pathname: TestRequestPathname, options: TestRequestOptions) => TestRequestResult;
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("boom task-request-failed");
  }) as unknown as typeof fetch;

  try {
    await runWithTaskLogScope("task-request-failed", () => assert.rejects(
      typed.request("/session", {
        method: "GET",
      }),
      /boom task-request-failed/,
    ));
  } finally {
    globalThis.fetch = originalFetch;
  }

  const logFilePath = buildTaskLogFilePath(userDataPath, "task-request-failed");
  const records = fs.readFileSync(logFilePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const latestRecord = records.at(-1) || {};
  assert.equal(latestRecord["event"], "opencode.request_failed");
  assert.equal(latestRecord["taskId"], "task-request-failed");
});

test("submitMessage 在空响应体或空对象响应时会在原地重试直到拿到有效消息实体", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-submit-empty-response";
  initAppFileLogger(userDataPath);
  const { client } = createClient();
  let requestCount = 0;
  client.request = async () => {
    requestCount += 1;
    return requestCount === 1
      ? new Response("", { status: 200 })
      : requestCount === 2
        ? new Response(JSON.stringify({ info: {}, }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
      : new Response(JSON.stringify({
          id: "msg-1",
          role: "assistant",
          parts: [{ type: "text", text: "已发送" }],
          createdAt: "2026-05-07T00:00:00.000Z",
          sessionID: "session-1",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
  };
  const { result: message, stdout } = await captureStdout(() =>
    runWithTaskLogScope(taskId, () => withFastForwardedTimeouts(() => client.submitMessage("session-1", {
      agent: "BA",
      content: "请整理需求",
    }))),
  );
  assert.equal(message.id, "msg-1");
  assert.equal(requestCount, 3);
  assert.match(stdout, /OpenCode 提交消息响应缺少有效的消息实体异常，已重新发送消息/u);
  const records = readTaskEventRecords(userDataPath, taskId, "opencode.submit_message_retried");
  assert.equal(records.length, 2);
  const [firstRetryRecord, secondRetryRecord] = records;
  assert.ok(firstRetryRecord);
  assert.ok(secondRetryRecord);
  assert.equal(firstRetryRecord["level"], "warn");
  assert.equal(firstRetryRecord["reason"], "OpenCode 提交消息响应缺少有效的消息实体");
  assert.equal(secondRetryRecord["reason"], "OpenCode 提交消息响应缺少有效的消息实体");
});

test("submitMessage 失败后会先立刻重试一次，再按 60 秒间隔继续重试", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-submit-request-failed";
  initAppFileLogger(userDataPath);
  const { client } = createClient();
  let requestCount = 0;
  const requestAt: number[] = [];
  client.request = async () => {
    requestCount += 1;
    requestAt.push(Date.now());
    if (requestCount === 1) {
      return new Response("server error", { status: 500 });
    }
    if (requestCount === 2) {
      throw new Error("fetch failed");
    }
    return new Response(JSON.stringify({
      id: "msg-2",
      role: "assistant",
      parts: [{ type: "text", text: "已恢复提交" }],
      createdAt: "2026-05-07T00:00:00.000Z",
      sessionID: "session-1",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
        });
  };
  const { result: message, stdout } = await captureStdout(() =>
    runWithTaskLogScope(taskId, () => withFastForwardedTimeouts(() => client.submitMessage("session-1", {
      agent: "BA",
      content: "请整理需求",
    }), 60_000)),
  );

  assert.equal(message.id, "msg-2");
  assert.equal(requestCount, 3);
  const requestRetryAt = requestAt as [number, number, number];
  assert.deepEqual([requestRetryAt[1] - requestRetryAt[0], requestRetryAt[2] - requestRetryAt[1]], [0, 60_000]);
  assert.match(stdout, /OpenCode 请求失败: 500异常，已重新发送消息/u);
  assert.match(stdout, /Error: fetch failed异常，已重新发送消息/u);
  const records = readTaskEventRecords(userDataPath, taskId, "opencode.submit_message_retried");
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record["reason"]), ["OpenCode 请求失败: 500", "Error: fetch failed"]);
});

test("submitMessage 最终请求体不注入 system 字段", async () => {
  const { client } = createClient();
  let capturedBody = "";
  client.request = async (_pathname, options) => {
    capturedBody = options.method === "POST" ? options.body : "";
    return new Response(JSON.stringify({
      id: "msg-1",
      role: "assistant",
      parts: [{ type: "text", text: "已发送" }],
      createdAt: "2026-05-07T00:00:00.000Z",
      sessionID: "session-1",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  await client.submitMessage("session-1", {
    agent: "TaskReview",
    content: "请继续判定",
  });

  assert.notEqual(capturedBody, "");
  assert.equal(capturedBody.includes("\"system\""), false);
  assert.deepEqual(JSON.parse(capturedBody), {
    agent: "TaskReview",
    parts: [{ type: "text", text: "请继续判定" }],
  });
});

test("resolveExecutionResult 在 completed 响应触发重试时会先立刻重试一次，再按 60 秒间隔继续重试", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-missing-trigger-retry";
  initAppFileLogger(userDataPath);
  const { client } = createClient();
  const typed = client as OpenCodeClient & {
    waitForMessageCompletion: (
      sessionId: string,
      messageId: string,
      timeoutMs: number,
    ) => Promise<OpenCodeNormalizedMessage>;
    waitForSessionSettled: (sessionId: string, after: number, timeoutMs: number) => Promise<void>;
    getSessionMessage: (sessionId: string, messageId: string) => Promise<OpenCodeNormalizedMessage>;
    getLatestAssistantMessage: (sessionId: string) => Promise<OpenCodeNormalizedMessage>;
    submitMessage: (
      sessionId: string,
      payload: {
        agent: string;
        content: string;
      },
    ) => Promise<OpenCodeNormalizedMessage>;
  };
  const submittedContents = ["初始请求"];
  const submittedAt: number[] = [];
  let submitCount = 1;
  let replyCount = 0;

  typed.waitForSessionSettled = async () => new Promise<void>(() => {});
  typed.getSessionMessage = async () => {
    throw new Error("message not found");
  };
  typed.getLatestAssistantMessage = async () => {
    throw new Error("latest assistant message not found");
  };
  typed.submitMessage = async (_sessionId, payload) => {
    submitCount += 1;
    submittedContents.push(payload.content);
    submittedAt.push(Date.now());
    return createCompletedMessage({
      id: `submitted-${submitCount}`,
      content: payload.content,
      sender: "assistant",
      timestamp: `2026-05-11T00:01:0${submitCount}.000Z`,
      raw: {},
    });
  };
  typed.waitForMessageCompletion = async (_sessionId, messageId) => {
    replyCount += 1;
    return createErrorMessage({
      id: `reply-${messageId}`,
      content: replyCount < 3
        ? "<456> 非法判定"
        : "<continue>第三次恢复</continue>",
      sender: "assistant",
      timestamp: "2026-05-11T00:01:10.000Z",
      error: replyCount < 3 ? "<456> 非法判定" : "<continue>第三次恢复</continue>",
      raw: {},
    });
  };
  const { result, stdout } = await captureStdout(() =>
    runWithTaskLogScope(taskId, () => withFastForwardedTimeouts(() => {
      submittedAt.push(Date.now());
      return client.resolveExecutionResult(
        "session-1",
        {
          ...createCompletedMessage({
            id: "submitted-1",
            content: "初始请求",
            sender: "assistant",
            timestamp: "2026-05-11T00:01:00.000Z",
            raw: {
            info: {
              config: {
                agent: {
                  TaskReview: {
                    mode: "primary",
                    prompt: "<continue> <complete> 回复要求（二选一）： 1. <456> (新的可疑点)... 2. <123> (没有新线索)...",
                  },
                },
              },
            },
            },
          }),
        },
        "TaskReview",
        ["<continue>", "<complete>"],
      );
    }, 60_000)),
  );

  assert.equal(result.finalMessage, "<continue>第三次恢复</continue>");
  assert.deepEqual(submittedContents, [
    "初始请求",
    "回复需要包含 <continue> / <complete> 中的一个",
    "回复需要包含 <continue> / <complete> 中的一个",
  ]);
  const submittedRetryAt = submittedAt as [number, number, number];
  assert.deepEqual([submittedRetryAt[1] - submittedRetryAt[0], submittedRetryAt[2] - submittedRetryAt[1]], [0, 60_000]);
  assert.match(stdout, /Agent TaskReview: OpenCode 未返回需要的 trigger: <continue> \/ <complete>异常，已重新发送消息/u);
  const records = readTaskEventRecords(userDataPath, taskId, "opencode.submit_message_retried");
  assert.equal(records.length, 2);
  const [firstRetryRecord] = records;
  assert.ok(firstRetryRecord);
  assert.equal(firstRetryRecord["reason"], "OpenCode 未返回需要的 trigger: <continue> / <complete>");
  assert.equal(firstRetryRecord["message"], "Agent TaskReview: OpenCode 未返回需要的 trigger: <continue> / <complete>异常，已重新发送消息");
});

test("createSession throws when the response is missing a session id", async () => {
  const { client } = createClient();
  client.request = async () => new Response("", { status: 200 });

  await assert.rejects(
    client.createSession("demo"),
    /session id/,
  );
});

test("createSession logs invalid responses into the task log file", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-123";
  initAppFileLogger(userDataPath);

  const client = new OpenCodeClient({
    server: createDetachedServeHandle(43127),
  }) as OpenCodeClient & {
    request: (pathname: TestRequestPathname, options: TestRequestOptions) => TestRequestResult;
  };
  client.request = async () => new Response("", { status: 200 });

  await runWithTaskLogScope(taskId, () => assert.rejects(
    client.createSession("demo"),
    /session id/,
  ));

  const lines = fs.readFileSync(buildTaskLogFilePath(userDataPath, taskId), "utf8").trim().split("\n");
  const record = JSON.parse(lines.at(-1) || "{}") as Record<string, unknown>;
  assert.equal(record["event"], "opencode.create_session_invalid_response");
  assert.equal(record["taskId"], taskId);
});

test("createSession 在响应体不是合法 JSON 时仍走 invalid response 分支并记录日志", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-malformed";
  initAppFileLogger(userDataPath);

  const client = new OpenCodeClient({
    server: createDetachedServeHandle(43127),
  }) as OpenCodeClient & {
    request: (pathname: TestRequestPathname, options: TestRequestOptions) => TestRequestResult;
  };
  client.request = async () => new Response("oops", { status: 200 });

  await runWithTaskLogScope(taskId, () => assert.rejects(
    client.createSession("demo"),
    /session id/,
  ));

  const lines = fs.readFileSync(buildTaskLogFilePath(userDataPath, taskId), "utf8").trim().split("\n");
  const record = JSON.parse(lines.at(-1) || "{}") as Record<string, unknown>;
  assert.equal(record["event"], "opencode.create_session_invalid_response");
  assert.equal(record["taskId"], taskId);
});

test("session message 请求不注入 AbortSignal，确保长任务不会被请求层超时中断", async () => {
  const { client } = createClient();
  const typed = client as OpenCodeClient & {
    request: (pathname: TestRequestPathname, options: TestRequestOptions) => TestRequestResult;
  };

  const originalFetch = globalThis.fetch;
  let capturedSignal: AbortSignal | string = "unobserved";
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const requestInit = args[1];
    capturedSignal = typeof requestInit === "object"
      && requestInit
      && "signal" in requestInit
      && requestInit.signal instanceof AbortSignal
      ? requestInit.signal
      : "unobserved";
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;

  try {
    await typed.request("/session/session-1/message", {
      method: "POST",
      body: JSON.stringify({ parts: [] }),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(capturedSignal, "unobserved");
});

test("createSession 超时后不应重启 runtime，也不应自动重试", async () => {
  const { client } = createClient();
  const typed = client as OpenCodeClient & {
    request: (pathname: TestRequestPathname, options: TestRequestOptions) => TestRequestResult;
  };

  let requestCount = 0;
  typed.request = async () => {
    requestCount += 1;
    throw new Error("OpenCode 请求超时: POST http://127.0.0.1:43127/session 超过 12000ms");
  };

  await assert.rejects(
    client.createSession("demo"),
    /请求超时/,
  );
  assert.equal(requestCount, 1);
});

test("消息查询接口空响应体时对单条消息和列表都直接抛错", async () => {
  const { client } = createClient();
  client.request = async () => new Response("", { status: 200 });

  await assert.rejects(
    client.getSessionMessage("session-1", "msg-1"),
    /响应体为空/,
  );
  await assert.rejects(
    client.listSessionMessages("session-1", 0),
    /响应体为空/,
  );
});

test("resolveExecutionResult 在消息已完成时不会额外等待 session idle 超时", async () => {
  const { client } = createClient();
  const typed = client as unknown as OpenCodeClient & {
    waitForSessionSettled: (sessionId: string, after: number, timeoutMs: number) => Promise<void>;
    waitForMessageCompletion: (
      sessionId: string,
      messageId: string,
      timeoutMs: number,
    ) => Promise<OpenCodeNormalizedMessage>;
    getLatestAssistantMessage: (sessionId: string) => Promise<unknown>;
  };
  const completedAt = new Date().toISOString();
  typed.waitForSessionSettled = async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  };
  typed.waitForMessageCompletion = async () => createCompletedMessage({
    id: "msg-1",
    content: "已完成",
    sender: "assistant",
    timestamp: completedAt,
    raw: { completedAt },
  });
  typed.getLatestAssistantMessage = async () => {
    throw new Error("不应该走到 getLatestAssistantMessage");
  };

  const startedAt = Date.now();
  const result = await typed.resolveExecutionResult("session-1", createCompletedMessage({
    id: "msg-1",
    content: "",
    sender: "assistant",
    timestamp: completedAt,
    raw: {},
  }), "TaskReview", []);
  const elapsed = Date.now() - startedAt;

  assert.equal(result.finalMessage, "已完成");
  assert.ok(elapsed < 120, `resolveExecutionResult 耗时 ${elapsed}ms，说明仍然被 session idle 等待拖住了`);
});

test("resolveExecutionResult 在没有任何 assistant 消息时会在原地重试直到拿到正式回复", async () => {
  const { client } = createClient();
  const typed = client as unknown as OpenCodeClient & {
    waitForSessionSettled: (sessionId: string, after: number, timeoutMs: number) => Promise<void>;
    waitForMessageCompletion: (
      sessionId: string,
      messageId: string,
      timeoutMs: number,
    ) => Promise<OpenCodeNormalizedMessage>;
    getLatestAssistantMessage: (sessionId: string) => Promise<OpenCodeNormalizedMessage>;
  };

  typed.waitForSessionSettled = async () => {};
  let resolveCount = 0;
  let latestAttemptCount = 0;
  typed.waitForMessageCompletion = async () => {
    throw new Error("OpenCode session session-1 未返回任何有效的 assistant 消息");
  };
  typed.getLatestAssistantMessage = async () => {
    latestAttemptCount += 1;
    if (latestAttemptCount === 1) {
      return createCompletedMessage({
        id: "msg-empty",
        content: "",
        sender: "assistant",
        timestamp: "2026-04-25T00:00:30.000Z",
        raw: {},
      });
    }
    resolveCount += 1;
    return createCompletedMessage({
      id: "msg-final",
      content: "已恢复正式回复",
      sender: "assistant",
      timestamp: "2026-04-25T00:01:00.000Z",
      raw: {},
    });
  };

  const result = await withFastForwardedTimeouts(() => typed.resolveExecutionResult("session-1", createCompletedMessage({
      id: "msg-user",
      content: "请整理需求",
      sender: "user",
      timestamp: "2026-04-25T00:00:00.000Z",
      raw: {},
    }), "BA", []));
  assert.equal(result.finalMessage, "已恢复正式回复");
  assert.equal(resolveCount, 1);
  assert.equal(latestAttemptCount, 2);
});

function readTaskLogRecords(userDataPath: string, taskId: string) {
  return fs.readFileSync(buildTaskLogFilePath(userDataPath, taskId), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createTransportRecoveryClient(messages: unknown[]) {
  const { client } = createClient();
  const typed = client as OpenCodeClient & {
    listSessionMessages: (sessionId: string, limit: number) => Promise<unknown[]>;
  };
  typed.listSessionMessages = async () => messages;
  return { client };
}

for (const scenario of [
  {
    name: "recoverExecutionResultAfterTransportError 会恢复多级 assistant 回复",
    taskId: "task-transport-recovery-recovered",
    startedAt: "2026-04-27T07:33:41.201Z",
    messages: [
      {
        info: {
          id: "msg-user",
          role: "user",
          time: {
            created: Date.parse("2026-04-27T07:33:41.201Z"),
          },
        },
        parts: [
          { type: "text", text: "请继续挑战" },
        ],
      },
      {
        info: {
          id: "msg-placeholder",
          parentID: "msg-user",
          role: "assistant",
          time: {
            created: Date.parse("2026-04-27T07:33:41.214Z"),
          },
        },
        parts: [
          { type: "text", text: "我先继续核对现有论证。" },
        ],
      },
      {
        info: {
          id: "msg-tool-calls",
          parentID: "msg-placeholder",
          role: "assistant",
          finish: "tool-calls",
          time: {
            created: Date.parse("2026-04-27T07:38:10.000Z"),
            completed: Date.parse("2026-04-27T07:38:22.000Z"),
          },
        },
        parts: [
          { type: "text", text: "我继续读取代码和 RFC。" },
        ],
      },
      {
        info: {
          id: "msg-final",
          parentID: "msg-tool-calls",
          role: "assistant",
          finish: "stop",
          time: {
            created: Date.parse("2026-04-27T07:38:24.000Z"),
            completed: Date.parse("2026-04-27T07:38:40.000Z"),
          },
        },
        parts: [
          { type: "text", text: "最终挑战结论已补齐。" },
        ],
      },
    ],
    expected: {
      recovered: true,
      messageId: "msg-final",
      finalMessage: "最终挑战结论已补齐。",
    },
  },
  {
    name: "recoverExecutionResultAfterTransportError 不会跨到后续 user 子树恢复结果",
    taskId: "task-transport-recovery-cross-user-subtree",
    startedAt: "2026-04-27T07:33:41.201Z",
    timeoutMs: 1,
    messages: [
      {
        info: {
          id: "msg-user",
          role: "user",
          time: {
            created: Date.parse("2026-04-27T07:33:41.201Z"),
          },
        },
        parts: [
          { type: "text", text: "请继续挑战" },
        ],
      },
      {
        info: {
          id: "msg-placeholder",
          parentID: "msg-user",
          role: "assistant",
          time: {
            created: Date.parse("2026-04-27T07:33:41.214Z"),
          },
        },
        parts: [
          { type: "text", text: "我先继续核对现有论证。" },
        ],
      },
      {
        info: {
          id: "msg-followup-user",
          parentID: "msg-placeholder",
          role: "user",
          time: {
            created: Date.parse("2026-04-27T07:35:10.000Z"),
          },
        },
        parts: [
          { type: "text", text: "补充一个新问题" },
        ],
      },
      {
        info: {
          id: "msg-followup-final",
          parentID: "msg-followup-user",
          role: "assistant",
          finish: "stop",
          time: {
            created: Date.parse("2026-04-27T07:35:15.000Z"),
            completed: Date.parse("2026-04-27T07:35:20.000Z"),
          },
        },
        parts: [
          { type: "text", text: "这是后续 user 回合的结果。" },
        ],
      },
    ],
    expected: {
      recovered: false,
      logEvent: "opencode.transport_recovery_timed_out",
      recoveryState: "waiting-with-related-reply",
      relatedReplyCount: 1,
    },
  },
  {
    name: "recoverExecutionResultAfterTransportError 没有正式回复时不能把 tool-calls 文本当成恢复结果",
    taskId: "task-transport-recovery-no-final",
    startedAt: "2026-04-27T04:34:10.422Z",
    timeoutMs: 1,
    messages: [
      {
        info: {
          id: "msg-user",
          role: "user",
          time: {
            created: Date.parse("2026-04-27T04:34:10.422Z"),
          },
        },
        parts: [
          { type: "text", text: "请给出讨论总结" },
        ],
      },
      {
        info: {
          id: "msg-tool-calls",
          parentID: "msg-user",
          role: "assistant",
          finish: "tool-calls",
          time: {
            created: Date.parse("2026-04-27T04:39:40.178Z"),
            completed: Date.parse("2026-04-27T04:39:48.072Z"),
          },
        },
        parts: [
          { type: "text", text: "我先继续读取证据。" },
        ],
      },
    ],
    expected: {
      recovered: false,
      logEvent: "opencode.transport_recovery_timed_out",
      recoveryState: "waiting-with-related-reply",
      relatedReplyCount: 1,
    },
  },
]) {
  test(scenario.name, async () => {
    const userDataPath = createTempDir();
    initAppFileLogger(userDataPath);
    const { client } = createTransportRecoveryClient(scenario.messages);

    const recovered = await runWithTaskLogScope(scenario.taskId, () => withFastForwardedTimeouts(() => (
      typeof scenario.timeoutMs !== "number"
        ? client.recoverExecutionResultAfterTransportError(
            "session-1",
            scenario.startedAt,
            "fetch failed",
          )
        : client.recoverExecutionResultAfterTransportError(
            "session-1",
            scenario.startedAt,
            "fetch failed",
            scenario.timeoutMs,
          )
    )));

    if (scenario.expected.recovered) {
      assert.equal(recovered.kind, "recovered");
      if (recovered.kind === "recovered") {
        assert.equal(recovered.result.status, "completed");
        assert.equal(recovered.result.messageId, scenario.expected.messageId);
        assert.equal(recovered.result.finalMessage, scenario.expected.finalMessage);
      }
      return;
    }

    assert.equal(recovered.kind, "timed_out");
    const records = readTaskLogRecords(userDataPath, scenario.taskId);
    assert.deepEqual(records.map((record) => record["event"]), [
      "opencode.transport_recovery_started",
      scenario.expected.logEvent,
    ]);
    const timeoutRecord = records[1] || {};
    assert.equal(timeoutRecord["recoveryState"], scenario.expected.recoveryState);
    assert.equal(timeoutRecord["relatedReplyCount"], scenario.expected.relatedReplyCount);
  });
}

test("同一 cwd 下多个订阅者会共享一个 event pump 并同时收到事件", async () => {
  const { client } = createClient();
  let startEventPumpCount = 0;
  let emitEvent: (event: Record<string, unknown>) => void = () => {};
  let releasePump: () => void = () => {};
  let notifyFirstPumpReady: () => void = () => {};
  const firstPumpReady = new Promise<void>((resolve) => {
    notifyFirstPumpReady = resolve;
  });

  Reflect.set(client, "startEventPump", async (onEvent: (event: Record<string, unknown>) => void) => {
    startEventPumpCount += 1;
    return new Promise<void>((resolve) => {
      emitEvent = onEvent;
      releasePump = resolve;
      notifyFirstPumpReady();
    });
  });

  const firstEvents: Array<Record<string, unknown>> = [];
  const secondEvents: Array<Record<string, unknown>> = [];
  const firstConnect = client.connectEvents((event) => {
    firstEvents.push(event);
  });
  await firstPumpReady;
  const secondConnect = client.connectEvents((event) => {
    secondEvents.push(event);
  });

  emitEvent({ type: "session.idle", properties: { sessionID: "session-1" } });
  releasePump();
  await Promise.all([firstConnect, secondConnect]);

  assert.equal(startEventPumpCount, 1);
  assert.deepEqual(firstEvents, [{ type: "session.idle", properties: { sessionID: "session-1" } }]);
  assert.deepEqual(secondEvents, [{ type: "session.idle", properties: { sessionID: "session-1" } }]);
});

test("getAttachBaseUrl 只读取已经启动的 serve 地址", async () => {
  const client = new OpenCodeClient({
    server: createDetachedServeHandle(43128),
  });
  const baseUrl = await client.getAttachBaseUrl();

  assert.equal(baseUrl, "http://127.0.0.1:43128");
});

test("buildRuntimeSnapshot 会保留同一条消息内 thinking 和 tool 的原始顺序", () => {
  const { client } = createClient();
  const typed = client as OpenCodeClient & {
    buildRuntimeSnapshot: (sessionId: string, messages: unknown[]) => {
      activities: Array<{ kind: string; detail: string; label: string }>;
    };
  };

  const snapshot = typed.buildRuntimeSnapshot("session-1", [
    {
      id: "msg-1",
      role: "assistant",
      createdAt: "2026-04-21T12:52:26.000Z",
      completedAt: "2026-04-21T12:52:26.000Z",
      parts: [
        {
          type: "reasoning",
          text: "Determining project structure",
        },
        {
          type: "tool-call",
          tool: { id: "glob" },
          input: {
            pattern: "**/*",
            path: "/Users/liyw/code/empty",
          },
        },
      ],
    },
  ]);

  assert.deepEqual(
    snapshot.activities.map((activity) => ({
      kind: activity.kind,
      label: activity.label,
      detail: activity.detail,
    })),
    [
      {
        kind: "thinking",
        label: "Determining project structure",
        detail: "Determining project structure",
      },
      {
        kind: "tool",
        label: "glob",
        detail: "参数: pattern=**/*, path=/Users/liyw/code/empty",
      },
    ],
  );
});

test("buildRuntimeSnapshot 会在同一条 OpenCode 工具消息超过 4 个 part 时保留 thinking", () => {
  const { client } = createClient();
  const typed = client as OpenCodeClient & {
    buildRuntimeSnapshot: (sessionId: string, messages: unknown[]) => {
      activities: Array<{ kind: string; detail: string; label: string }>;
    };
  };

  const snapshot = typed.buildRuntimeSnapshot("session-1", [
    {
      info: {
        id: "msg-tool-round",
        role: "assistant",
        time: {
          created: 1776960271926,
          completed: 1776960280541,
        },
      },
      parts: [
        { type: "step-start" },
        {
          type: "reasoning",
          text: "**Prioritizing instructions**\n\nI need to inspect the repository before returning a finding.",
        },
        {
          type: "tool",
          tool: "glob",
          state: {
            input: { pattern: "**/*Http2*.java", path: "code/tomcat-vul" },
          },
        },
        {
          type: "tool",
          tool: "glob",
          state: {
            input: { pattern: "**/*Authority*.java", path: "code/tomcat-vul" },
          },
        },
        {
          type: "tool",
          tool: "glob",
          state: {
            input: { pattern: "**/*Host*.java", path: "code/tomcat-vul" },
          },
        },
        { type: "step-finish", reason: "tool-calls" },
      ],
    },
  ]);

  assert.deepEqual(
    snapshot.activities.map((activity) => ({
      kind: activity.kind,
      label: activity.label,
      detail: activity.detail,
    })),
    [
      {
        kind: "thinking",
        label: "**Prioritizing instructions** I need to inspect…",
        detail: "**Prioritizing instructions**\n\nI need to inspect the repository before returning a finding.",
      },
      {
        kind: "tool",
        label: "glob",
        detail: "参数: pattern=**/*Http2*.java, path=code/tomcat-vul",
      },
      {
        kind: "tool",
        label: "glob",
        detail: "参数: pattern=**/*Authority*.java, path=code/tomcat-vul",
      },
      {
        kind: "tool",
        label: "glob",
        detail: "参数: pattern=**/*Host*.java, path=code/tomcat-vul",
      },
    ],
  );
});

test("buildRuntimeSnapshot 不会因为后续活动超过全局显示窗口而丢掉早期 OpenCode thinking", () => {
  const { client } = createClient();
  const typed = client as OpenCodeClient & {
    buildRuntimeSnapshot: (sessionId: string, messages: unknown[]) => {
      activities: Array<{ kind: string; detail: string; label: string }>;
    };
  };
  const laterToolMessages = Array.from({ length: 25 }, (_, index) => ({
    info: {
      id: `msg-later-${index}`,
      role: "assistant",
      time: {
        created: 1776960281000 + index,
        completed: 1776960281000 + index,
      },
    },
    parts: [
      {
        type: "tool",
        tool: "grep",
        state: {
          input: { pattern: `later-${index}` },
        },
      },
    ],
  }));

  const snapshot = typed.buildRuntimeSnapshot("session-1", [
    {
      info: {
        id: "msg-first-thinking",
        role: "assistant",
        time: {
          created: 1776960271926,
          completed: 1776960280541,
        },
      },
      parts: [
        {
          type: "reasoning",
          text: "**Prioritizing instructions**\n\nI need to inspect the repository before returning a finding.",
        },
      ],
    },
    ...laterToolMessages,
  ]);

  assert.equal(
    snapshot.activities.some((activity) => activity.detail.includes("Prioritizing instructions")),
    true,
  );
});

test("buildRuntimeSnapshot 在工具参数形似 JSON 但非法时回退为原始字符串摘要", () => {
  const { client } = createClient();
  const typed = client as OpenCodeClient & {
    buildRuntimeSnapshot: (sessionId: string, messages: unknown[]) => {
      activities: Array<{ kind: string; detail: string; label: string }>;
    };
  };

  const snapshot = typed.buildRuntimeSnapshot("session-1", [
    {
      id: "msg-1",
      role: "assistant",
      createdAt: "2026-04-21T12:52:26.000Z",
      completedAt: "2026-04-21T12:52:26.000Z",
      parts: [
        {
          type: "tool-call",
          tool: { id: "glob" },
          input: "{bad}",
        },
      ],
    },
  ]);

  assert.equal(snapshot.activities.length, 1);
  const firstActivity = assertActivityAt(snapshot.activities, 0);
  assert.equal(firstActivity.kind, "tool");
  assert.equal(firstActivity.label, "glob");
  assert.equal(firstActivity.detail, "参数: {bad}");
  assert.equal(firstActivity.timestamp, "2026-04-21T12:52:26.000Z");
});

test("buildRuntimeSnapshot 在暂时只有 user 消息时返回空活动而不是抛错", () => {
  const { client } = createClient();
  const typed = client as OpenCodeClient & {
    buildRuntimeSnapshot: (sessionId: string, messages: unknown[]) => OpenCodeSessionRuntime;
  };

  const snapshot = typed.buildRuntimeSnapshot("session-1", [
    {
      info: {
        id: "msg-user-only",
        role: "user",
        time: {
          created: 1776960271926,
        },
      },
      parts: [
        {
          type: "text",
          text: "[User] 开始分析",
        },
      ],
    },
  ]);

  assert.equal(snapshot.sessionId, "session-1");
  assert.equal(snapshot.messageCount, 1);
  assert.equal(snapshot.updatedAt, "");
  assert.equal(snapshot.headline, "");
  assert.deepEqual(snapshot.activeToolNames, []);
  assert.deepEqual(snapshot.activities, []);
});

test("buildRuntimeSnapshot 在工具调用暂时没有参数时返回 missing 活动而不是抛错", () => {
  const { client } = createClient();
  const typed = client as OpenCodeClient & {
    buildRuntimeSnapshot: (sessionId: string, messages: unknown[]) => OpenCodeSessionRuntime;
  };

  const snapshot = typed.buildRuntimeSnapshot("session-1", [
    {
      info: {
        id: "msg-tool-missing-input",
        role: "assistant",
        time: {
          created: 1776960271926,
          completed: 1776960271926,
        },
      },
      parts: [
        {
          type: "tool",
          tool: "grep",
          state: {
            status: "running",
          },
        },
      ],
    },
  ]);

  assert.equal(snapshot.activities.length, 1);
  const activity = assertActivityAt(snapshot.activities, 0);
  assert.equal(activity.kind, "tool");
  assert.equal(activity.label, "grep");
  assert.equal(activity.detail, "参数暂未提供");
  assert.equal(activity.detailState, "missing");
  assert.equal(activity.detailParseMode, "missing");
  assert.equal(activity.detailPayloadKeyCount, 0);
  assert.equal(activity.detailHasPlaceholderValue, false);
});

test("buildRuntimeSnapshot 会优先使用 tool state.input 作为更完整的参数来源", () => {
  const { client } = createClient();
  const typed = client as OpenCodeClient & {
    buildRuntimeSnapshot: (sessionId: string, messages: unknown[]) => OpenCodeSessionRuntime;
  };

  const snapshot = typed.buildRuntimeSnapshot("session-1", [
    {
      id: "msg-1",
      role: "assistant",
      createdAt: "2026-04-21T12:52:26.000Z",
      completedAt: "2026-04-21T12:52:27.000Z",
      parts: [
        {
          type: "tool",
          tool: "read",
          input: "placeholder",
          state: {
            input: {
              filePath: "/tmp/demo.txt",
            },
          },
        },
      ],
    },
  ]);

  assert.equal(snapshot.activities.length, 1);
  const firstActivity = assertActivityAt(snapshot.activities, 0);
  assert.equal(firstActivity.kind, "tool");
  assert.equal(firstActivity.detail, "参数: filePath=/tmp/demo.txt");
  assert.equal(firstActivity.detailState, "complete");
  assert.equal(firstActivity.detailParseMode, "structured");
  assert.equal(firstActivity.detailPayloadKeyCount, 1);
  assert.equal(firstActivity.detailHasPlaceholderValue, false);

  const stateWinsSnapshot = typed.buildRuntimeSnapshot("session-1", [
    {
      id: "msg-state-wins-tool",
      role: "assistant",
      createdAt: "2026-04-21T12:52:27.500Z",
      completedAt: "2026-04-21T12:52:27.500Z",
      parts: [
        {
          type: "tool",
          tool: "read",
          input: {
            filePath: "/tmp/short.txt",
          },
          state: {
            input: {
              filePath: "/tmp/demo.txt",
              offset: 8,
            },
          },
        },
      ],
    },
  ]);
  const stateWinsActivity = assertActivityAt(stateWinsSnapshot.activities, 0);
  assert.equal(stateWinsActivity.detail, "参数: filePath=/tmp/demo.txt, offset=8");
  assert.equal(stateWinsActivity.detailState, "complete");
  assert.equal(stateWinsActivity.detailParseMode, "structured");
  assert.equal(stateWinsActivity.detailPayloadKeyCount, 3);
  assert.equal(stateWinsActivity.detailHasPlaceholderValue, false);

  const metadataSnapshot = typed.buildRuntimeSnapshot("session-1", [
    {
      id: "msg-metadata-tool",
      role: "assistant",
      createdAt: "2026-04-21T12:52:28.000Z",
      completedAt: "2026-04-21T12:52:28.000Z",
      parts: [
        {
          type: "tool",
          tool: "grep",
          metadata: {
            params: {
              pattern: "TODO",
            },
          },
        },
      ],
    },
  ]);
  const metadataActivity = assertActivityAt(metadataSnapshot.activities, 0);
  assert.equal(metadataActivity.kind, "tool");
  assert.equal(metadataActivity.detail, "参数: pattern=TODO");
  assert.equal(metadataActivity.detailState, "complete");
  assert.equal(metadataActivity.detailParseMode, "structured");
  assert.equal(metadataActivity.detailPayloadKeyCount, 1);
  assert.equal(metadataActivity.detailHasPlaceholderValue, false);
});

test("buildRuntimeSnapshot 会用 freshness 元数据区分 placeholder 与 structured 参数", () => {
  const { client } = createClient();
  const typed = client as OpenCodeClient & {
    buildRuntimeSnapshot: (sessionId: string, messages: unknown[]) => OpenCodeSessionRuntime;
  };
  const timestamp = "2026-04-21T12:52:27.000Z";

  const placeholderSnapshot = typed.buildRuntimeSnapshot("session-1", [
    {
      id: "msg-placeholder-tool",
      role: "assistant",
      createdAt: timestamp,
      completedAt: timestamp,
      parts: [
        {
          type: "tool",
          tool: "read",
          input: "placeholder",
        },
      ],
    },
  ]);
  const structuredSnapshot = typed.buildRuntimeSnapshot("session-1", [
    {
      id: "msg-structured-tool",
      role: "assistant",
      createdAt: timestamp,
      completedAt: timestamp,
      parts: [
        {
          type: "tool",
          tool: "read",
          state: {
            input: {
              filePath: "/tmp/demo.txt",
            },
          },
          input: "placeholder",
        },
      ],
    },
  ]);

  const placeholderActivity = assertActivityAt(placeholderSnapshot.activities, 0);
  const structuredActivity = assertActivityAt(structuredSnapshot.activities, 0);

  assert.equal(placeholderActivity.detail, "参数: placeholder");
  assert.equal(placeholderActivity.detailState, "complete");
  assert.equal(placeholderActivity.detailParseMode, "plain_text");
  assert.equal(placeholderActivity.detailPayloadKeyCount, 0);
  assert.equal(placeholderActivity.detailHasPlaceholderValue, true);

  assert.equal(structuredActivity.detail, "参数: filePath=/tmp/demo.txt");
  assert.equal(structuredActivity.detailState, "complete");
  assert.equal(structuredActivity.detailParseMode, "structured");
  assert.equal(structuredActivity.detailPayloadKeyCount, 1);
  assert.equal(structuredActivity.detailHasPlaceholderValue, false);

  assert.equal(
    isRuntimeActivityFreshnessNewer(
      buildRuntimeActivityFreshness(placeholderActivity),
      buildRuntimeActivityFreshness(structuredActivity),
    ),
    true,
  );
});

test("startEventPump 在单条 SSE 数据非法时保留原始载荷并继续消费后续事件", async () => {
  const { client } = createClient();
  const typed = client as unknown as {
    startEventPump: (
      onEvent: (event: Record<string, unknown>) => void,
    ) => Promise<void>;
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        "data: not-json\n\ndata: {\"type\":\"session.idle\",\"properties\":{\"sessionID\":\"session-1\"}}\n\n",
      ));
      controller.close();
    },
  }), { status: 200 })) as unknown as typeof fetch;

  const events: Array<Record<string, unknown>> = [];
  try {
    await typed.startEventPump((event: Record<string, unknown>) => {
      events.push(event);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(events, [
    { payload: { raw: "not-json" } },
    { type: "session.idle", properties: { sessionID: "session-1" } },
  ]);
});
