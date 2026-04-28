import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  fetchUiSnapshot,
  readLaunchTaskIdFromSearch,
  subscribeAgentTeamEvents,
} from "./web-api";

const WEB_API_SOURCE = fs.readFileSync(new URL("./web-api.ts", import.meta.url), "utf8");
const LEGACY_EVENT_NAME = ["Agent", "Flow", "Event"].join("");
const LEGACY_SUBSCRIBE_NAME = ["subscribe", "Agent", "Flow", "Events"].join("");

test("web-api 改用 AgentTeamEvent 与 subscribeAgentTeamEvents", () => {
  assert.match(WEB_API_SOURCE, /AgentTeamEvent/);
  assert.match(WEB_API_SOURCE, /export function subscribeAgentTeamEvents/);
  assert.match(WEB_API_SOURCE, /export function fetchUiSnapshot/);
  assert.match(WEB_API_SOURCE, /\/api\/ui-snapshot/);
  assert.doesNotMatch(WEB_API_SOURCE, new RegExp(LEGACY_EVENT_NAME));
  assert.doesNotMatch(WEB_API_SOURCE, new RegExp(LEGACY_SUBSCRIBE_NAME));
});

test("readLaunchTaskIdFromSearch 会把缺失或空白 taskId 统一归一成 null", () => {
  assert.equal(readLaunchTaskIdFromSearch(""), null);
  assert.equal(readLaunchTaskIdFromSearch("?taskId="), null);
  assert.equal(readLaunchTaskIdFromSearch("?taskId=%20%20%20"), null);
  assert.equal(readLaunchTaskIdFromSearch("?taskId=task-123"), "task-123");
});

test("fetchUiSnapshot 会按 JSON5 解析响应体", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(`{
    workspace: null,
    task: null,
    launchTaskId: "task-123",
    launchCwd: "/tmp/demo",
    taskLogFilePath: "/tmp/demo.log",
    taskUrl: "http://localhost:4310/?taskId=task-123",
  }`, { status: 200 })) as typeof fetch;

  try {
    const payload = await fetchUiSnapshot({ taskId: "task-123" });
    assert.equal(payload.launchTaskId, "task-123");
    assert.equal(payload.launchCwd, "/tmp/demo");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("subscribeAgentTeamEvents 会按 JSON5 解析 SSE 消息", () => {
  class FakeEventSource {
    static lastInstance: FakeEventSource | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    url: string;

    constructor(url: string) {
      this.url = url;
      FakeEventSource.lastInstance = this;
    }

    close() {}
  }

  const originalEventSource = globalThis.EventSource;
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;

  const received: string[] = [];
  try {
    const unsubscribe = subscribeAgentTeamEvents({ taskId: "task-123" }, (event) => {
      received.push(`${event.type}:${event.cwd}`);
    });
    FakeEventSource.lastInstance?.onmessage?.({
      data: "{type:'task-updated',cwd:'/tmp/demo',payload:{taskId:'task-123'}}",
    });
    unsubscribe();
  } finally {
    globalThis.EventSource = originalEventSource;
  }

  assert.deepEqual(received, ["task-updated:/tmp/demo"]);
});
