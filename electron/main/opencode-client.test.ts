import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { OpenCodeClient } from "./opencode-client";

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-opencode-client-"));
}

function createClient() {
  const client = new OpenCodeClient(createTempDir()) as OpenCodeClient & {
    serverHandle: Promise<{ process: null; port: number; mock: boolean }>;
    request: (pathname: string) => Promise<Response>;
    getSessionMessage: (projectPath: string, sessionId: string, messageId: string) => Promise<unknown>;
    listSessionMessages: (projectPath: string, sessionId: string, limit?: number) => Promise<unknown[]>;
  };
  client.serverHandle = Promise.resolve({
    process: null,
    port: 4096,
    mock: false,
  });
  return client;
}

test("submitMessage 在空响应体时不会抛出 JSON 解析错误", async () => {
  const client = createClient();
  client.request = async () => new Response("", { status: 200 });

  const message = await client.submitMessage("/tmp/demo", "session-1", {
    agent: "BA",
    content: "请整理需求",
  });

  assert.equal(typeof message.id, "string");
  assert.equal(message.content, "");
  assert.equal(message.sender, "BA");
});

test("createSession 在空响应体时回退到本地 session id", async () => {
  const client = createClient();
  client.request = async () => new Response("", { status: 200 });

  const sessionId = await client.createSession("/tmp/demo", "demo");

  assert.match(sessionId, /^session-/);
});

test("消息查询接口空响应体时返回空结果而不是抛错", async () => {
  const client = createClient();
  client.request = async () => new Response("", { status: 200 });

  const message = await client.getSessionMessage("/tmp/demo", "session-1", "msg-1");
  const list = await client.listSessionMessages("/tmp/demo", "session-1");

  assert.equal(message, null);
  assert.deepEqual(list, []);
});

test("resolveExecutionResult 在消息已完成时不会额外等待 session idle 超时", async () => {
  const client = createClient() as OpenCodeClient & {
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
  client.waitForSessionSettled = async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  };
  client.waitForMessageCompletion = async () => ({
    id: "msg-1",
    content: "已完成",
    sender: "assistant",
    timestamp: completedAt,
    completedAt,
    error: null,
    raw: null,
  });
  client.getLatestAssistantMessage = async () => null;
  client.getSessionRuntime = async () => ({
    sessionId: "session-1",
    messageCount: 1,
    updatedAt: completedAt,
    headline: null,
    activeToolNames: [],
    activities: [],
  });

  const startedAt = Date.now();
  const result = await client.resolveExecutionResult("/tmp/demo", "session-1", {
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
  const client = new OpenCodeClient(createTempDir()) as OpenCodeClient & {
    serverHandle: Promise<{ process: null; port: number; mock: boolean }> | null;
    shutdownPromise: Promise<void> | null;
    startServer: () => Promise<{ process: null; port: number; mock: boolean }>;
    shutdown: () => Promise<void>;
  };

  client.serverHandle = Promise.resolve({
    process: null,
    port: 4096,
    mock: false,
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
  client.shutdown = async () => {
    shutdownStartedResolve?.();
    await shutdownRelease;
    client.serverHandle = null;
    shutdownFinished = true;
  };

  let startedAfterShutdown = false;
  client.startServer = async () => {
    startedAfterShutdown = shutdownFinished;
    return {
      process: null,
      port: 4096,
      mock: false,
    };
  };

  client.setInjectedConfigContent('{"agent":{}}');
  await shutdownStarted;

  let ensureResolved = false;
  const ensurePromise = client.ensureServer().then(() => {
    ensureResolved = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ensureResolved, false);

  shutdownReleaseResolve?.();
  await ensurePromise;

  assert.equal(startedAfterShutdown, true);
  assert.equal(client.shutdownPromise, null);
});
