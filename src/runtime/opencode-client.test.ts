import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJson5 } from "@shared/json5";

import { buildTaskLogFilePath, initAppFileLogger } from "./app-log";
import type { OpenCodeNormalizedMessage, OpenCodeSessionRuntime } from "./opencode-client";
import { OpenCodeClient } from "./opencode-client";

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-opencode-client-"));
}

function createClient(projectPath = createTempDir()) {
  const client = new OpenCodeClient() as OpenCodeClient & {
    servers: Map<string, {
      runtimeKey: string;
      projectPath: string;
      serverHandle: Promise<{ process: null; port: number }> | null;
      eventPump: Promise<void> | null;
      injectedConfigContent: string | null;
    }>;
    request: (pathname: string) => Promise<Response>;
    getSessionMessage: (projectPath: string, sessionId: string, messageId: string) => Promise<unknown>;
    listSessionMessages: (projectPath: string, sessionId: string, limit?: number) => Promise<unknown[]>;
  };
  const normalizedProjectPath = path.resolve(projectPath);
  client.servers.set(normalizedProjectPath, {
    runtimeKey: normalizedProjectPath,
    projectPath: normalizedProjectPath,
    serverHandle: Promise.resolve({
      process: null,
      port: 43127,
    }),
    eventPump: null,
    injectedConfigContent: null,
  });
  return {
    client,
    projectPath: normalizedProjectPath,
  };
}

test("request 会跟随当前 serverHandle 的实际端口", async () => {
  const { client, projectPath } = createClient();
  const typed = client as OpenCodeClient & {
    servers: Map<string, {
      runtimeKey: string;
      projectPath: string;
      serverHandle: Promise<{ process: null; port: number }> | null;
      eventPump: Promise<void> | null;
      injectedConfigContent: string | null;
    }>;
    request: (
      pathname: string,
      options: {
        method: "GET" | "POST";
        projectPath?: string;
        body?: string;
      },
    ) => Promise<Response>;
  };
  const state = typed.servers.get(projectPath);
  assert.notEqual(state, undefined);
  state!.serverHandle = Promise.resolve({
    process: null,
    port: 43127,
  });

  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrl = String(input);
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    await typed.request("/session", {
      method: "GET",
      projectPath,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestedUrl, "http://127.0.0.1:43127/session");
});

test("submitMessage 在空响应体时必须报错，不能伪造 pending message", async () => {
  const { client, projectPath } = createClient();
  client.request = async () => new Response("", { status: 200 });

  await assert.rejects(
    client.submitMessage(projectPath, "session-1", {
      agent: "BA",
      content: "请整理需求",
    }),
    /响应缺少有效的消息实体/,
  );
});

test("createSession throws when the response is missing a session id", async () => {
  const { client, projectPath } = createClient();
  client.request = async () => new Response("", { status: 200 });

  await assert.rejects(
    client.createSession(projectPath, "demo"),
    /session id/,
  );
});

test("createSession logs invalid responses into the task log file when runtimeKey is provided", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const taskId = "task-123";
  initAppFileLogger(userDataPath);

  const client = new OpenCodeClient() as OpenCodeClient & {
    request: () => Promise<Response>;
  };
  client.request = async () => new Response("", { status: 200 });

  await assert.rejects(
    client.createSession({
      runtimeKey: taskId,
      projectPath,
    }, "demo"),
    /session id/,
  );

  const lines = fs.readFileSync(buildTaskLogFilePath(userDataPath, taskId), "utf8").trim().split("\n");
  const record = parseJson5<Record<string, unknown>>(lines.at(-1) ?? "{}");
  assert.equal(record["event"], "opencode.create_session_invalid_response");
  assert.equal(record["taskId"], taskId);
});

test("createSession 在响应体不是合法 JSON5 时仍走 invalid response 分支并记录日志", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const taskId = "task-malformed";
  initAppFileLogger(userDataPath);

  const client = new OpenCodeClient() as OpenCodeClient & {
    request: () => Promise<Response>;
  };
  client.request = async () => new Response("oops", { status: 200 });

  await assert.rejects(
    client.createSession({
      runtimeKey: taskId,
      projectPath,
    }, "demo"),
    /session id/,
  );

  const lines = fs.readFileSync(buildTaskLogFilePath(userDataPath, taskId), "utf8").trim().split("\n");
  const record = parseJson5<Record<string, unknown>>(lines.at(-1) ?? "{}");
  assert.equal(record["event"], "opencode.create_session_invalid_response");
  assert.equal(record["taskId"], taskId);
});

test("session message 请求不注入 AbortSignal，确保长任务不会被请求层超时中断", async () => {
  const { client, projectPath } = createClient();
  const typed = client as OpenCodeClient & {
    request: (
      pathname: string,
      options: {
        method: "GET" | "POST";
        projectPath?: string;
        body?: string;
      },
    ) => Promise<Response>;
  };

  const originalFetch = globalThis.fetch;
  let capturedSignal: AbortSignal | null | undefined;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    capturedSignal = args[1]?.signal;
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    await typed.request("/session/session-1/message", {
      method: "POST",
      projectPath,
      body: JSON.stringify({ parts: [] }),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(capturedSignal, undefined);
});

test("createSession 超时后不应重启 runtime，也不应自动重试", async () => {
  const { client, projectPath } = createClient();
  const typed = client as OpenCodeClient & {
    request: (
      pathname: string,
      options: {
        method: "GET" | "POST";
        target?: string;
        projectPath?: string;
        body?: string;
      },
    ) => Promise<Response>;
  };

  let requestCount = 0;
  typed.request = async () => {
    requestCount += 1;
    throw new Error("OpenCode 请求超时: POST http://127.0.0.1:43127/session 超过 12000ms");
  };

  await assert.rejects(
    client.createSession(projectPath, "demo"),
    /请求超时/,
  );
  assert.equal(requestCount, 1);
});

test("消息查询接口空响应体时返回空结果而不是抛错", async () => {
  const { client, projectPath } = createClient();
  client.request = async () => new Response("", { status: 200 });

  const message = await client.getSessionMessage(projectPath, "session-1", "msg-1");
  const list = await client.listSessionMessages(projectPath, "session-1");

  assert.equal(message, null);
  assert.deepEqual(list, []);
});

test("resolveExecutionResult 在消息已完成时不会额外等待 session idle 超时", async () => {
  const { client, projectPath } = createClient();
  const typed = client as unknown as OpenCodeClient & {
    waitForSessionSettled: (sessionId: string, after: number, timeoutMs: number) => Promise<void>;
    waitForMessageCompletion: (
      projectPath: string,
      sessionId: string,
      messageId: string,
      fallbackTimestamp: string,
      timeoutMs: number,
    ) => Promise<OpenCodeNormalizedMessage | null>;
    getLatestAssistantMessage: (projectPath: string, sessionId: string) => Promise<unknown>;
    getSessionRuntime: (projectPath: string, sessionId: string) => Promise<OpenCodeSessionRuntime>;
  };
  const completedAt = new Date().toISOString();
  typed.waitForSessionSettled = async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  };
  typed.waitForMessageCompletion = async () => ({
    id: "msg-1",
    content: "已完成",
    sender: "assistant",
    timestamp: completedAt,
    completedAt,
    error: null,
    raw: null,
  });
  typed.getLatestAssistantMessage = async () => null;
  typed.getSessionRuntime = async () => ({
    sessionId: "session-1",
    messageCount: 1,
    updatedAt: completedAt,
    headline: null,
    activeToolNames: [],
    activities: [],
  });

  const startedAt = Date.now();
  const result = await typed.resolveExecutionResult(projectPath, "session-1", {
    id: "msg-1",
    content: "",
    sender: "assistant",
    timestamp: completedAt,
    completedAt: null,
    error: null,
    raw: null,
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(result.finalMessage, "已完成");
  assert.ok(elapsed < 120, `resolveExecutionResult 耗时 ${elapsed}ms，说明仍然被 session idle 等待拖住了`);
});

test("resolveExecutionResult 在没有任何 assistant 消息时必须报错，不能拿提交态或空消息兜底", async () => {
  const { client, projectPath } = createClient();
  const typed = client as unknown as OpenCodeClient & {
    waitForSessionSettled: (sessionId: string, after: number, timeoutMs: number) => Promise<void>;
    waitForMessageCompletion: (
      projectPath: string,
      sessionId: string,
      messageId: string,
      fallbackTimestamp: string,
      timeoutMs: number,
    ) => Promise<OpenCodeNormalizedMessage | null>;
    getLatestAssistantMessage: (projectPath: string, sessionId: string) => Promise<unknown>;
    getSessionRuntime: (projectPath: string, sessionId: string) => Promise<OpenCodeSessionRuntime>;
  };

  typed.waitForSessionSettled = async () => undefined;
  typed.waitForMessageCompletion = async () => null;
  typed.getLatestAssistantMessage = async () => null;
  typed.getSessionRuntime = async () => ({
    sessionId: "session-1",
    messageCount: 0,
    updatedAt: null,
    headline: null,
    activeToolNames: [],
    activities: [],
  });

  await assert.rejects(
    typed.resolveExecutionResult(projectPath, "session-1", {
      id: "msg-user",
      content: "请整理需求",
      sender: "user",
      timestamp: "2026-04-25T00:00:00.000Z",
      completedAt: null,
      error: null,
      raw: null,
    }),
    /未返回任何有效的 assistant 消息/,
  );
});

test("recoverExecutionResultAfterTransportError 在 fetch failed 后会从 session 历史恢复正式回复", async () => {
  const { client, projectPath } = createClient();
  const typed = client as OpenCodeClient & {
    listSessionMessages: (target: string, sessionId: string, limit?: number) => Promise<unknown[]>;
  };

  let listCount = 0;
  typed.listSessionMessages = async () => {
    listCount += 1;
    if (listCount === 1) {
      return [];
    }
    return [
      {
        info: {
          id: "msg-user",
          role: "user",
          time: {
            created: Date.parse("2026-04-27T03:48:29.645Z"),
          },
        },
        parts: [
          { type: "text", text: "请继续论证" },
        ],
      },
      {
        info: {
          id: "msg-tool-calls",
          parentID: "msg-user",
          role: "assistant",
          finish: "tool-calls",
          time: {
            created: Date.parse("2026-04-27T03:48:29.649Z"),
            completed: Date.parse("2026-04-27T03:48:35.815Z"),
          },
        },
        parts: [
          { type: "text", text: "先读取代码证据。" },
        ],
      },
      {
        info: {
          id: "msg-final",
          parentID: "msg-user",
          role: "assistant",
          finish: "stop",
          time: {
            created: Date.parse("2026-04-27T03:48:53.519Z"),
            completed: Date.parse("2026-04-27T03:49:02.458Z"),
          },
        },
        parts: [
          { type: "text", text: "<continue>\n已补齐论证。" },
        ],
      },
    ];
  };

  const recovered = await client.recoverExecutionResultAfterTransportError(
    projectPath,
    "session-1",
    "2026-04-27T03:48:30.000Z",
    "fetch failed",
    1000,
  );

  assert.notEqual(recovered, null);
  assert.equal(recovered?.status, "completed");
  assert.equal(recovered?.messageId, "msg-final");
  assert.equal(recovered?.finalMessage, "<continue>\n已补齐论证。");
  assert.ok(listCount >= 2);
});

test("recoverExecutionResultAfterTransportError 会沿 parent 链恢复多级 assistant 回复", async () => {
  const { client, projectPath } = createClient();
  const typed = client as OpenCodeClient & {
    listSessionMessages: (target: string, sessionId: string, limit?: number) => Promise<unknown[]>;
  };

  typed.listSessionMessages = async () => [
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
  ];

  const recovered = await client.recoverExecutionResultAfterTransportError(
    projectPath,
    "session-1",
    "2026-04-27T07:33:41.201Z",
    "fetch failed",
    100,
  );

  assert.notEqual(recovered, null);
  assert.equal(recovered?.status, "completed");
  assert.equal(recovered?.messageId, "msg-final");
  assert.equal(recovered?.finalMessage, "最终挑战结论已补齐。");
});

test("recoverExecutionResultAfterTransportError 不会跨到后续 user 子树恢复结果", async () => {
  const userDataPath = createTempDir();
  initAppFileLogger(userDataPath);
  const { client, projectPath } = createClient();
  const typed = client as OpenCodeClient & {
    listSessionMessages: (target: string, sessionId: string, limit?: number) => Promise<unknown[]>;
  };
  const runtimeTarget = {
    runtimeKey: "task-transport-recovery-nested-user",
    projectPath,
  };

  typed.listSessionMessages = async () => [
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
  ];

  const recovered = await client.recoverExecutionResultAfterTransportError(
    runtimeTarget,
    "session-1",
    "2026-04-27T07:33:41.201Z",
    "fetch failed",
    1,
  );

  assert.equal(recovered, null);
  const logFilePath = buildTaskLogFilePath(userDataPath, runtimeTarget.runtimeKey);
  const records = fs.readFileSync(logFilePath, "utf8").trim().split("\n").map((line) => parseJson5<Record<string, unknown>>(line));
  assert.deepEqual(records.map((record) => record["event"]), [
    "opencode.transport_recovery_started",
    "opencode.transport_recovery_timed_out",
  ]);
  assert.equal(records[1]?.["recoveryState"], "waiting-with-related-reply");
  assert.equal(records[1]?.["relatedReplyCount"], 1);
  assert.equal(records[1]?.["latestRelatedMessageId"], "msg-placeholder");
  assert.equal(records[1]?.["latestRelatedParentMessageId"], "msg-user");
});

test("recoverExecutionResultAfterTransportError 默认会等待超过 45 秒的晚到正式回复", async () => {
  const userDataPath = createTempDir();
  initAppFileLogger(userDataPath);
  const { client, projectPath } = createClient();
  const typed = client as OpenCodeClient & {
    listSessionMessages: (target: string, sessionId: string, limit?: number) => Promise<unknown[]>;
  };
  const runtimeTarget = {
    runtimeKey: "task-transport-recovery",
    projectPath,
  };

  const originalDateNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  let nowMs = Date.parse("2026-04-27T04:39:11.321Z");
  const submittedAt = "2026-04-27T04:34:10.422Z";
  const finalAtMs = Date.parse("2026-04-27T04:41:09.388Z");

  Date.now = () => nowMs;
  globalThis.setTimeout = (((handler: (...args: unknown[]) => void, _timeout?: number, ...args: unknown[]) => {
    nowMs += 15_000;
    handler(...args);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);

  typed.listSessionMessages = async () => {
    const messages: unknown[] = [
      {
        info: {
          id: "msg-user",
          role: "user",
          time: {
            created: Date.parse(submittedAt),
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
          { type: "tool", tool: "read" },
        ],
      },
    ];

    if (nowMs >= finalAtMs) {
      messages.push({
        info: {
          id: "msg-final",
          parentID: "msg-user",
          role: "assistant",
          finish: "stop",
          time: {
            created: Date.parse("2026-04-27T04:41:08.077Z"),
            completed: finalAtMs,
          },
        },
        parts: [
          { type: "text", text: "最终总结已生成" },
        ],
      });
    }

    return messages;
  };

  try {
    const recovered = await client.recoverExecutionResultAfterTransportError(
      runtimeTarget,
      "session-1",
      submittedAt,
      "fetch failed",
    );

    assert.notEqual(recovered, null);
    assert.equal(recovered?.status, "completed");
    assert.equal(recovered?.messageId, "msg-final");
    assert.equal(recovered?.finalMessage, "最终总结已生成");

    const logFilePath = buildTaskLogFilePath(userDataPath, runtimeTarget.runtimeKey);
    const records = fs.readFileSync(logFilePath, "utf8").trim().split("\n").map((line) => parseJson5<Record<string, unknown>>(line));
    assert.deepEqual(records.map((record) => record["event"]), [
      "opencode.transport_recovery_started",
      "opencode.transport_recovery_succeeded",
    ]);
    assert.equal(records[0]?.["timeoutMs"], 180000);
    assert.equal(records[1]?.["recoveredMessageId"], "msg-final");
  } finally {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("recoverExecutionResultAfterTransportError 没有正式回复时不能把 tool-calls 文本当成恢复结果", async () => {
  const userDataPath = createTempDir();
  initAppFileLogger(userDataPath);
  const { client, projectPath } = createClient();
  const typed = client as OpenCodeClient & {
    listSessionMessages: (target: string, sessionId: string, limit?: number) => Promise<unknown[]>;
  };
  const runtimeTarget = {
    runtimeKey: "task-transport-recovery-timeout",
    projectPath,
  };

  typed.listSessionMessages = async () => [
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
  ];

  const recovered = await client.recoverExecutionResultAfterTransportError(
    runtimeTarget,
    "session-1",
    "2026-04-27T04:34:10.422Z",
    "fetch failed",
    1,
  );

  assert.equal(recovered, null);
  const logFilePath = buildTaskLogFilePath(userDataPath, runtimeTarget.runtimeKey);
  const records = fs.readFileSync(logFilePath, "utf8").trim().split("\n").map((line) => parseJson5<Record<string, unknown>>(line));
  assert.deepEqual(records.map((record) => record["event"]), [
    "opencode.transport_recovery_started",
    "opencode.transport_recovery_timed_out",
  ]);
  assert.equal(records[1]?.["recoveryState"], "waiting-with-related-reply");
  assert.equal(records[1]?.["relatedReplyCount"], 1);
  assert.equal(records[1]?.["latestRelatedMessageId"], "msg-tool-calls");
  assert.equal(records[1]?.["latestRelatedParentMessageId"], "msg-user");
  assert.equal(records[1]?.["latestRelatedFinish"], "tool-calls");
});

test("配置变更时不应触发 shutdown", async () => {
  const { client, projectPath } = createClient();
  const typed = client as OpenCodeClient & {
    shutdown: (runtimeKey?: string) => Promise<{ killedPids: number[] }>;
  };

  let shutdownCount = 0;
  typed.shutdown = async () => {
    shutdownCount += 1;
    return { killedPids: [] };
  };

  client.setInjectedConfigContent(projectPath, '{"agent":{}}');
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(shutdownCount, 0);
});

test("不同 runtimeKey 会使用各自独立的 serve 端口，即使 cwd 相同", async () => {
  const client = new OpenCodeClient() as OpenCodeClient & {
    startServer: (target: { runtimeKey: string; projectPath: string }) => Promise<{ process: null; port: number }>;
    request: (
      pathname: string,
      options: {
        method: "GET" | "POST";
        target?: { runtimeKey: string; projectPath: string };
        body?: string;
      },
    ) => Promise<Response>;
  };
  const projectPath = createTempDir();
  const targetA = { runtimeKey: "task-a", projectPath };
  const targetB = { runtimeKey: "task-b", projectPath };
  const portByRuntime = new Map<string, number>([
    ["task-a", 43127],
    ["task-b", 43128],
  ]);

  client.startServer = async (target) => {
    return {
      process: null,
      port: portByRuntime.get(target.runtimeKey) ?? 43129,
    };
  };

  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrls.push(String(input));
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    await client.request("/session", {
      method: "GET",
      target: targetA,
    });
    await client.request("/session", {
      method: "GET",
      target: targetB,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requestedUrls, [
    "http://127.0.0.1:43127/session",
    "http://127.0.0.1:43128/session",
  ]);
});
test("getAttachBaseUrl 会启动当前 task 自己的 serve", async () => {
  const projectPath = createTempDir();
  const client = new OpenCodeClient() as OpenCodeClient & {
    startServer: (target: { runtimeKey: string; projectPath: string }) => Promise<{ process: null; port: number }>;
  };
  const target = {
    runtimeKey: "task-1",
    projectPath,
  };

  let startServerCalled = false;
  client.startServer = async () => {
    startServerCalled = true;
    return {
      process: null,
      port: 43128,
    };
  };

  const baseUrl = await client.getAttachBaseUrl(target);

  assert.equal(baseUrl, "http://127.0.0.1:43128");
  assert.equal(startServerCalled, true);
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

test("buildRuntimeSnapshot 在工具参数形似 JSON5 但非法时回退为原始字符串摘要", () => {
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
  assert.equal(snapshot.activities[0]?.kind, "tool");
  assert.equal(snapshot.activities[0]?.label, "glob");
  assert.equal(snapshot.activities[0]?.detail, "参数: {bad}");
  assert.equal(snapshot.activities[0]?.timestamp, "2026-04-21T12:52:26.000Z");
});

test("startEventPump 在单条 SSE 数据非法时保留原始载荷并继续消费后续事件", async () => {
  const { client, projectPath } = createClient();
  const typed = client as unknown as {
    startEventPump: (
      onEvent: (event: Record<string, unknown>) => void,
      server: { process: null; port: number },
      runtimeKey: string,
    ) => Promise<void>;
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        "data: not-json\n\ndata: {type:'session.idle',properties:{sessionID:'session-1'}}\n\n",
      ));
      controller.close();
    },
  }), { status: 200 })) as typeof fetch;

  const events: Array<Record<string, unknown>> = [];
  try {
    await typed.startEventPump((event: Record<string, unknown>) => {
      events.push(event);
    }, { process: null, port: 43127 }, projectPath);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(events, [
    { payload: { raw: "not-json" } },
    { type: "session.idle", properties: { sessionID: "session-1" } },
  ]);
});
