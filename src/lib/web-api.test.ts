import { test } from "bun:test";
import assert from "node:assert/strict";

import { fetchUiSnapshot } from "./web-api";

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
