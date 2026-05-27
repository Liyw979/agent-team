import assert from "node:assert/strict";
import { test } from "bun:test";

import { createTopologyFlowRecord } from "@shared/types";
import {
  buildInjectedConfigFromAgents,
  extractDslAgentsFromTopology,
} from "./project-agent-source";

test("extractDslAgentsFromTopology 在没有任何 DSL metadata 时返回空数组而不是可空值", () => {
  const resolved = extractDslAgentsFromTopology({
    nodes: ["Build"],
    edges: [],
    flow: createTopologyFlowRecord({
      nodes: ["Build"],
      edges: [],
    }),
    nodeRecords: [
      { id: "Build", kind: "agent", templateName: "Build", initialMessageRouting: { mode: "inherit" } },
    ],
  });

  assert.deepEqual(resolved, []);
});

test("extractDslAgentsFromTopology 不会把未显式配置 writable 的 Build 视为默认可写", () => {
  const resolved = extractDslAgentsFromTopology({
    nodes: ["Build", "BA"],
    edges: [{ source: "BA", target: "Build", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 }],
    flow: createTopologyFlowRecord({
      nodes: ["Build", "BA"],
      edges: [{ source: "BA", target: "Build", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 }],
    }),
    nodeRecords: [
      { id: "Build", kind: "agent", templateName: "Build", initialMessageRouting: { mode: "inherit" } },
      { id: "BA", kind: "agent", templateName: "BA", prompt: "你是 BA。", initialMessageRouting: { mode: "inherit" } },
    ],
  });

  assert.deepEqual(resolved, [
    { id: "Build", prompt: "", isWritable: false },
    { id: "BA", prompt: "你是 BA。", isWritable: false },
  ]);
});

test("可写 Agent 仍会注入自定义 prompt，只是不追加只读权限", () => {
  const injected = buildInjectedConfigFromAgents([
    { id: "Build", prompt: "", isWritable: true },
    { id: "BA", prompt: "你是 BA。", isWritable: true },
    { id: "QA", prompt: "你是 QA。", isWritable: false },
  ]);

  assert.deepEqual(Object.keys(injected), ["BA", "QA"]);
  assert.deepEqual(injected["BA"], {
    prompt: "你是 BA。",
    mode: "primary",
  });
  const qaConfig = injected["QA"];
  if (!qaConfig || !("permission" in qaConfig)) {
    assert.fail("QA 应带只读权限");
  }
  assert.deepEqual(qaConfig.permission, {
    write: "deny",
    edit: "deny",
    bash: "deny",
    task: "deny",
    patch: "deny",
    webfetch: "deny",
    websearch: "deny",
  });
});

test("不可写 Agent 会拒绝写入与联网相关 OpenCode 工具权限", () => {
  const injected = buildInjectedConfigFromAgents([
    { id: "QA", prompt: "你是 QA。", isWritable: false },
  ]);

  const qaConfig = injected["QA"];
  if (!qaConfig || !("permission" in qaConfig)) {
    assert.fail("QA 应带只读权限");
  }
  assert.deepEqual(qaConfig.permission, {
    write: "deny",
    edit: "deny",
    bash: "deny",
    task: "deny",
    patch: "deny",
    webfetch: "deny",
    websearch: "deny",
  });
});

test("单个可写 Agent 也必须注入 OpenCode agent prompt 配置", () => {
  const injected = buildInjectedConfigFromAgents([
    { id: "BA", prompt: "你是 BA。", isWritable: true },
  ]);

  assert.deepEqual(injected["BA"], {
    prompt: "你是 BA。",
    mode: "primary",
  });
});
