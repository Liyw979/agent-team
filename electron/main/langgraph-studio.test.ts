import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLangGraphStudioCliInvocation,
  buildLangGraphStudioConfig,
  buildLangGraphStudioUrl,
} from "./langgraph-studio";

test("LangGraph Studio URL 会把 baseUrl 编进官方 Studio 页面地址", () => {
  const url = buildLangGraphStudioUrl("http://127.0.0.1:2024");

  assert.equal(
    url,
    "https://smith.langchain.com/studio/?baseUrl=http%3A%2F%2F127.0.0.1%3A2024",
  );
});

test("LangGraph Studio 配置会指向当前仓库依赖和导出的 graph entry", () => {
  const config = buildLangGraphStudioConfig({
    appRoot: "/workspace/agentflow",
    entryModulePath: "/workspace/agentflow/electron/main/langgraph-studio-entry.ts",
  });

  assert.deepEqual(config, {
    dependencies: ["/workspace/agentflow"],
    graphs: {
      agentflow: "/workspace/agentflow/electron/main/langgraph-studio-entry.ts:agentflowStudio",
    },
  });
});

test("LangGraph Studio CLI 调用在不同平台下会生成稳定参数", () => {
  const posix = buildLangGraphStudioCliInvocation({
    platform: "darwin",
    configPath: "/tmp/langgraph.json",
    port: 2024,
    host: "127.0.0.1",
  });
  const windows = buildLangGraphStudioCliInvocation({
    platform: "win32",
    configPath: "C:\\temp\\langgraph.json",
    port: 2025,
    host: "127.0.0.1",
  });

  assert.deepEqual(posix, {
    command: "npx",
    args: [
      "@langchain/langgraph-cli",
      "dev",
      "--config",
      "/tmp/langgraph.json",
      "--port",
      "2024",
      "--host",
      "127.0.0.1",
    ],
  });
  assert.deepEqual(windows, {
    command: "npx.cmd",
    args: [
      "@langchain/langgraph-cli",
      "dev",
      "--config",
      "C:\\temp\\langgraph.json",
      "--port",
      "2025",
      "--host",
      "127.0.0.1",
    ],
  });
});
