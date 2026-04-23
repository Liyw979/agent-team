import assert from "node:assert/strict";
import test from "node:test";

import type { TopologyRecord } from "@shared/types";

import { instantiateSpawnBundle, instantiateSpawnBundles, validateSpawnRule } from "./runtime-topology";

function createVulnTopology(): TopologyRecord {
  return {
    nodes: ["线索发现", "漏洞论证模板", "漏洞挑战模板", "Summary模板"],
    nodeRecords: [
      { id: "线索发现", kind: "agent", templateName: "线索发现" },
      { id: "漏洞论证模板", kind: "agent", templateName: "漏洞论证模板" },
      { id: "漏洞挑战模板", kind: "agent", templateName: "漏洞挑战模板" },
      { id: "Summary模板", kind: "agent", templateName: "Summary模板" },
      { id: "疑点辩论工厂", kind: "spawn", templateName: "漏洞论证模板", spawnRuleId: "finding-debate" },
    ],
    edges: [
      { source: "线索发现", target: "疑点辩论工厂", triggerOn: "transfer", messageMode: "all" },
    ],
    spawnRules: [
      {
        id: "finding-debate",
        spawnNodeName: "疑点辩论工厂",
        sourceTemplateName: "线索发现",
        entryRole: "pro",
        spawnedAgents: [
          { role: "pro", templateName: "漏洞论证模板" },
          { role: "con", templateName: "漏洞挑战模板" },
          { role: "summary", templateName: "Summary模板" },
        ],
        edges: [
          { sourceRole: "pro", targetRole: "con", triggerOn: "continue", messageMode: "last" },
          { sourceRole: "con", targetRole: "pro", triggerOn: "continue", messageMode: "last" },
          { sourceRole: "pro", targetRole: "summary", triggerOn: "complete", messageMode: "last" },
          { sourceRole: "con", targetRole: "summary", triggerOn: "complete", messageMode: "last" },
        ],
        exitWhen: "one_side_agrees",
        reportToTemplateName: "线索发现",
        reportToTriggerOn: "transfer",
      },
    ],
  };
}

test("validateSpawnRule 可以验证漏洞辩论规则引用的模板和角色都存在", () => {
  const topology = createVulnTopology();
  const rule = topology.spawnRules?.[0];
  assert.notEqual(rule, undefined);
  validateSpawnRule(topology, rule!);
});

test("instantiateSpawnBundle 会为一个 finding 生成论证、挑战、summary 三个运行时实例和正确连线", () => {
  const topology = createVulnTopology();

  const bundle = instantiateSpawnBundle({
    topology,
    spawnRuleId: "finding-debate",
    activationId: "activation-1",
    item: {
      id: "finding-001",
      title: "上传文件名拼接路径",
    },
  });

  assert.equal(bundle.groupId, "finding-debate:finding-001");
  assert.deepEqual(
    bundle.nodes.map((node) => ({
      id: node.id,
      templateName: node.templateName,
      role: node.role,
      displayName: node.displayName,
    })),
    [
      { id: "漏洞论证模板-1", templateName: "漏洞论证模板", role: "pro", displayName: "漏洞论证模板-1" },
      { id: "漏洞挑战模板-1", templateName: "漏洞挑战模板", role: "con", displayName: "漏洞挑战模板-1" },
      { id: "Summary模板-1", templateName: "Summary模板", role: "summary", displayName: "Summary模板-1" },
    ],
  );
  assert.deepEqual(bundle.edges, [
    {
      messageMode: "all",
      source: "线索发现",
      target: "漏洞论证模板-1",
      triggerOn: "transfer",
    },
    {
      messageMode: "last",
      source: "漏洞论证模板-1",
      target: "漏洞挑战模板-1",
      triggerOn: "continue",
    },
    {
      messageMode: "last",
      source: "漏洞挑战模板-1",
      target: "漏洞论证模板-1",
      triggerOn: "continue",
    },
    {
      messageMode: "last",
      source: "漏洞论证模板-1",
      target: "Summary模板-1",
      triggerOn: "complete",
    },
    {
      messageMode: "last",
      source: "漏洞挑战模板-1",
      target: "Summary模板-1",
      triggerOn: "complete",
    },
    {
      messageMode: "last",
      source: "Summary模板-1",
      target: "线索发现",
      triggerOn: "transfer",
    },
  ]);
});

test("instantiateSpawnBundle 会继承 source -> spawn 的 messageMode 到 entry 运行时实例边", () => {
  const topology = createVulnTopology();

  const bundle = instantiateSpawnBundle({
    topology,
    spawnRuleId: "finding-debate",
    activationId: "activation-1",
    item: {
      id: "finding-001",
      title: "上传文件名拼接路径",
    },
  });

  assert.deepEqual(bundle.edges[0], {
    source: "线索发现",
    target: "漏洞论证模板-1",
    triggerOn: "transfer",
    messageMode: "all",
  });
});

test("instantiateSpawnBundle 识别 source 节点时不会误把 spawn 节点当成 sourceTemplateName", () => {
  const topology = createVulnTopology();

  const bundle = instantiateSpawnBundle({
    topology: {
      ...topology,
      nodeRecords: [
        { id: "疑点辩论工厂", kind: "spawn", templateName: "漏洞论证模板", spawnRuleId: "finding-debate" },
        ...(topology.nodeRecords ?? []).filter((node) => node.id !== "疑点辩论工厂"),
      ],
    },
    spawnRuleId: "finding-debate",
    activationId: "activation-1",
    item: {
      id: "finding-001",
      title: "上传文件名拼接路径",
    },
  });

  assert.deepEqual(bundle.edges[0], {
    source: "线索发现",
    target: "漏洞论证模板-1",
    triggerOn: "transfer",
    messageMode: "all",
  });
});

test("同一 spawn rule 的多个实例会按顺序生成简短显示名，而不是暴露复杂内部 id", () => {
  const topology = createVulnTopology();

  const bundles = instantiateSpawnBundles({
    topology,
    spawnRuleId: "finding-debate",
    activationId: "activation-1",
    items: [
      { id: "finding-001", title: "路径穿越" },
      { id: "finding-002", title: "鉴权缺失" },
    ],
  });

  assert.deepEqual(
    bundles.flatMap((bundle) => bundle.nodes.map((node) => node.displayName)),
    ["漏洞论证模板-1", "漏洞挑战模板-1", "Summary模板-1", "漏洞论证模板-2", "漏洞挑战模板-2", "Summary模板-2"],
  );
});

test("instantiateSpawnBundles 会为多个 finding 批量生成互不冲突的实例组", () => {
  const topology = createVulnTopology();

  const bundles = instantiateSpawnBundles({
    topology,
    spawnRuleId: "finding-debate",
    activationId: "activation-1",
    items: [
      { id: "finding-001", title: "路径穿越" },
      { id: "finding-002", title: "鉴权缺失" },
    ],
  });

  assert.equal(bundles.length, 2);
  assert.equal(bundles[0]?.nodes[0]?.id, "漏洞论证模板-1");
  assert.equal(bundles[1]?.nodes[0]?.id, "漏洞论证模板-2");
  assert.notEqual(bundles[0]?.groupId, bundles[1]?.groupId);
});
