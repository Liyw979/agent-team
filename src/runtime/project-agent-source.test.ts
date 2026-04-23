import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInjectedConfigFromAgents,
  extractDslAgentsFromTopology,
  resolveProjectAgents,
  validateProjectAgents,
} from "./project-agent-source";

test("resolveProjectAgents 在存在 DSL agents 时直接返回 DSL prompt", () => {
  const resolved = resolveProjectAgents({
    dslAgents: [
      { name: "BA", prompt: "DSL BA prompt", isWritable: false },
      { name: "Build", prompt: "", isWritable: true },
    ],
  });

  assert.deepEqual(resolved, [
    { name: "BA", prompt: "DSL BA prompt", isWritable: false },
    { name: "Build", prompt: "", isWritable: true },
  ]);
});

test("resolveProjectAgents 在不存在 DSL agents 时不再回退到用户自定义 prompt", () => {
  const resolved = resolveProjectAgents({
    dslAgents: null,
  });

  assert.deepEqual(resolved, []);
});

test("validateProjectAgents 允许多个可写 Agent", () => {
  assert.doesNotThrow(() => validateProjectAgents([
    { name: "Build", prompt: "", isWritable: true },
    { name: "BA", prompt: "dsl", isWritable: true },
  ]));
});

test("extractDslAgentsFromTopology 不会把未显式配置 writable 的 Build 视为默认可写", () => {
  const resolved = extractDslAgentsFromTopology({
    nodes: ["Build", "BA"],
    edges: [{ source: "BA", target: "Build", triggerOn: "transfer", messageMode: "last" }],
    nodeRecords: [
      { id: "Build", kind: "agent", templateName: "Build" },
      { id: "BA", kind: "agent", templateName: "BA", prompt: "你是 BA。" },
    ],
  });

  assert.deepEqual(resolved, [
    { name: "Build", prompt: "", isWritable: false },
    { name: "BA", prompt: "你是 BA。", isWritable: false },
  ]);
});

test("单指定一个自定义 Agent 可写时，注入的 readonly 配置里不会包含这个 Agent", () => {
  const injected = buildInjectedConfigFromAgents([
    { name: "Build", prompt: "", isWritable: true },
    { name: "BA", prompt: "你是 BA。", isWritable: true },
    { name: "QA", prompt: "你是 QA。", isWritable: false },
  ]);

  assert.notEqual(injected, null);

  const parsed = JSON.parse(injected ?? "{}") as {
    agent?: Record<string, { permission?: Record<string, string> }>;
  };

  assert.deepEqual(Object.keys(parsed.agent ?? {}), ["QA"]);
  assert.deepEqual(parsed.agent?.["QA"]?.permission, {
    write: "deny",
    edit: "deny",
    bash: "deny",
    task: "deny",
    patch: "deny",
  });
});

test("不可写 Agent 只拒绝写入相关 OpenCode 工具权限", () => {
  const injected = buildInjectedConfigFromAgents([
    { name: "QA", prompt: "你是 QA。", isWritable: false },
  ]);

  assert.notEqual(injected, null);

  const parsed = JSON.parse(injected ?? "{}") as {
    agent?: Record<string, { permission?: Record<string, unknown> }>;
  };

  assert.deepEqual(parsed.agent?.["QA"]?.permission, {
    write: "deny",
    edit: "deny",
    bash: "deny",
    task: "deny",
    patch: "deny",
  });
});

test("可写 Agent 不注入 OpenCode agent 配置", () => {
  const injected = buildInjectedConfigFromAgents([
    { name: "BA", prompt: "你是 BA。", isWritable: true },
  ]);

  assert.equal(injected, null);
});
