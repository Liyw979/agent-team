import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildTaskLogFilePath, initAppFileLogger } from "./app-log";
import type { OpenCodeNormalizedMessage, OpenCodeSessionRuntime } from "./opencode-client";
import { OpenCodeClient } from "./opencode-client";

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-opencode-client-"));
}

function createClient(projectPath = createTempDir()) {
  const client = new OpenCodeClient() as OpenCodeClient & {
    servers: Map<string, {
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

test("submitMessage 在空响应体时不会抛出 JSON 解析错误", async () => {
  const { client, projectPath } = createClient();
  client.request = async () => new Response("", { status: 200 });

  const message = await client.submitMessage(projectPath, "session-1", {
    agent: "BA",
    content: "请整理需求",
  });

  assert.equal(typeof message.id, "string");
  assert.equal(message.content, "");
  assert.equal(message.sender, "BA");
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
  const record = JSON.parse(lines.at(-1) ?? "{}");
  assert.equal(record.event, "opencode.create_session_invalid_response");
  assert.equal(record.taskId, taskId);
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
    const runtimeKey = typeof target === "string" ? target : target.runtimeKey;
    return {
    process: null,
    port: portByRuntime.get(runtimeKey) ?? 43129,
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

test("registerExternalServer 可以把现有 runtime 端口注册进当前进程内存", async () => {
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
  client.registerExternalServer(target, "http://127.0.0.1:43127");

  const baseUrl = await client.getAttachBaseUrl(target);

  assert.equal(baseUrl, "http://127.0.0.1:43127");
  assert.equal(startServerCalled, false);
});

test("external runtime 端口失效后，request 不会重拉当前进程自己的 serve", async () => {
  const projectPath = createTempDir();
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
  client.registerExternalServer(target, "http://127.0.0.1:43127");

  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url === "http://127.0.0.1:43127/session") {
      throw new TypeError("fetch failed");
    }
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    await assert.rejects(
      client.request("/session", {
        method: "GET",
        target,
      }),
      /fetch failed/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(startServerCalled, false);
  assert.deepEqual(requestedUrls, [
    "http://127.0.0.1:43127/session",
  ]);
});

test("getAttachBaseUrl 在未注册外部 runtime 时会启动当前 task 自己的 serve", async () => {
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
