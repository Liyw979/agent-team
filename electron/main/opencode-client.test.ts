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
