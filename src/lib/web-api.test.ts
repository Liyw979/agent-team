import { test } from "bun:test";
import assert from "node:assert/strict";

import { fetchUiSnapshot, submitTask } from "./web-api";

test("fetchUiSnapshot 会按 JSON 解析响应体", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      kind: "workspace",
      workspace: {
        cwd: "/tmp/demo",
        name: "demo",
        agents: [],
        topology: {
          nodes: [],
          edges: [],
          flow: {
            start: { id: "__start__", targets: [] },
            end: { id: "__end__", sources: [], incoming: [] },
          },
          nodeRecords: [],
        },
        messages: [],
        tasks: [],
      },
      launchCwd: "/tmp/demo",
      taskUrl: "http://localhost:4310/",
    }), { status: 200 });
  }) as typeof fetch;

  try {
    const payload = await fetchUiSnapshot();
    assert.equal(requestedUrl, "/api/ui-snapshot");
    assert.equal(payload.launchCwd, "/tmp/demo");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("submitTask 会以 JSON 字符串提交任务内容", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input, init) => {
    requestedUrl = String(input);
    assert.ok(init);
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("content-type"), "application/json");
    assert.equal(init.body, JSON.stringify("请开始执行"));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    await submitTask("请开始执行");
    assert.equal(requestedUrl, "/api/tasks/submit");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
