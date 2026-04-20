import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { OpenCodeClient } from "./opencode-client";

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-opencode-client-"));
}

function createClient(projectPath = createTempDir()) {
  const client = new OpenCodeClient(createTempDir()) as OpenCodeClient & {
    servers: Map<string, {
      projectPath: string;
      runtimeDir: string;
      serverHandle: Promise<{ process: null; port: number }> | null;
      shutdownPromise: Promise<void> | null;
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
    runtimeDir: createTempDir(),
    serverHandle: Promise.resolve({
      process: null,
      port: 4096,
    }),
    shutdownPromise: null,
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
      runtimeDir: string;
      serverHandle: Promise<{ process: null; port: number }> | null;
      shutdownPromise: Promise<void> | null;
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
  state.serverHandle = Promise.resolve({
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
  const typed = client as OpenCodeClient & {
    waitForSessionSettled: (sessionId: string, after: number, timeoutMs: number) => Promise<void>;
    waitForMessageCompletion: (
      projectPath: string,
      sessionId: string,
      messageId: string,
      fallbackTimestamp: string,
      timeoutMs: number,
    ) => Promise<{
      id: string;
      content: string;
      sender: string;
      timestamp: string;
      completedAt: string | null;
      error: string | null;
      raw: unknown;
    } | null>;
    getLatestAssistantMessage: (projectPath: string, sessionId: string) => Promise<unknown>;
    getSessionRuntime: (projectPath: string, sessionId: string) => Promise<{
      sessionId: string;
      messageCount: number;
      updatedAt: string | null;
      headline: string | null;
      activeToolNames: string[];
      activities: [];
    }>;
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

test("配置变更触发 shutdown 时，ensureServer 会等待 shutdown 完成后再启动新服务", async () => {
  const projectPath = createTempDir();
  const client = new OpenCodeClient(createTempDir()) as OpenCodeClient & {
    servers: Map<string, {
      projectPath: string;
      runtimeDir: string;
      serverHandle: Promise<{ process: null; port: number }> | null;
      shutdownPromise: Promise<void> | null;
      eventPump: Promise<void> | null;
      injectedConfigContent: string | null;
    }>;
    startServer: (projectPath: string) => Promise<{ process: null; port: number }>;
    shutdown: (projectPath?: string) => Promise<void>;
  };
  const normalizedProjectPath = path.resolve(projectPath);
  client.servers.set(normalizedProjectPath, {
    projectPath: normalizedProjectPath,
    runtimeDir: createTempDir(),
    serverHandle: Promise.resolve({
      process: null,
      port: 4096,
    }),
    shutdownPromise: null,
    eventPump: null,
    injectedConfigContent: null,
  });

  let shutdownStartedResolve: (() => void) | null = null;
  const shutdownStarted = new Promise<void>((resolve) => {
    shutdownStartedResolve = resolve;
  });
  let shutdownReleaseResolve: (() => void) | null = null;
  const shutdownRelease = new Promise<void>((resolve) => {
    shutdownReleaseResolve = resolve;
  });

  let shutdownFinished = false;
  client.shutdown = async (targetProjectPath?: string) => {
    assert.equal(targetProjectPath, normalizedProjectPath);
    shutdownStartedResolve?.();
    await shutdownRelease;
    const state = client.servers.get(normalizedProjectPath);
    assert.notEqual(state, undefined);
    state.serverHandle = null;
    shutdownFinished = true;
  };

  let startedAfterShutdown = false;
  client.startServer = async (targetProjectPath: string) => {
    assert.equal(targetProjectPath, normalizedProjectPath);
    startedAfterShutdown = shutdownFinished;
    return {
      process: null,
      port: 4096,
    };
  };

  client.setInjectedConfigContent(normalizedProjectPath, '{"agent":{}}');
  await shutdownStarted;

  let ensureResolved = false;
  const ensurePromise = client.ensureServer(normalizedProjectPath).then(() => {
    ensureResolved = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ensureResolved, false);

  shutdownReleaseResolve?.();
  await ensurePromise;

  assert.equal(startedAfterShutdown, true);
  assert.equal(client.servers.get(normalizedProjectPath)?.shutdownPromise, null);
});

test("不同 Project 会使用各自独立的 serve 端口", async () => {
  const client = new OpenCodeClient(createTempDir()) as OpenCodeClient & {
    startServer: (projectPath: string) => Promise<{ process: null; port: number }>;
    request: (
      pathname: string,
      options: {
        method: "GET" | "POST";
        projectPath?: string;
        body?: string;
      },
    ) => Promise<Response>;
  };
  const projectA = createTempDir();
  const projectB = createTempDir();
  const portByProject = new Map<string, number>([
    [path.resolve(projectA), 43127],
    [path.resolve(projectB), 43128],
  ]);

  client.startServer = async (projectPath) => ({
    process: null,
    port: portByProject.get(path.resolve(projectPath)) ?? 4096,
  });

  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrls.push(String(input));
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    await client.request("/session", {
      method: "GET",
      projectPath: projectA,
    });
    await client.request("/session", {
      method: "GET",
      projectPath: projectB,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requestedUrls, [
    "http://127.0.0.1:43127/session",
    "http://127.0.0.1:43128/session",
  ]);
});
