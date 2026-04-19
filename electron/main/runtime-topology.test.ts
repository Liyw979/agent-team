import assert from "node:assert/strict";
import test from "node:test";

import type { TopologyRecord } from "@shared/types";

import { instantiateSpawnBundle, instantiateSpawnBundles, validateSpawnRule } from "./runtime-topology";

function createVulnTopology(): TopologyRecord {
  return {
    projectId: "spawn-project",
    nodes: ["初筛", "正方模板", "反方模板", "Summary模板"],
    nodeRecords: [
      { id: "初筛", kind: "agent", templateName: "初筛" },
      { id: "正方模板", kind: "agent", templateName: "正方模板" },
      { id: "反方模板", kind: "agent", templateName: "反方模板" },
      { id: "Summary模板", kind: "agent", templateName: "Summary模板" },
      { id: "疑点辩论工厂", kind: "spawn", templateName: "正方模板", spawnRuleId: "finding-debate" },
    ],
    edges: [
      { source: "初筛", target: "疑点辩论工厂", triggerOn: "association" },
    ],
    spawnRules: [
      {
        id: "finding-debate",
        name: "漏洞疑点辩论",
        sourceTemplateName: "初筛",
        itemKey: "findings",
        entryRole: "pro",
        spawnedAgents: [
          { role: "pro", templateName: "正方模板" },
          { role: "con", templateName: "反方模板" },
          { role: "summary", templateName: "Summary模板" },
        ],
        edges: [
          { sourceRole: "pro", targetRole: "con", triggerOn: "review_fail" },
          { sourceRole: "con", targetRole: "pro", triggerOn: "review_fail" },
          { sourceRole: "pro", targetRole: "summary", triggerOn: "review_pass" },
          { sourceRole: "con", targetRole: "summary", triggerOn: "review_pass" },
        ],
        exitWhen: "one_side_agrees",
        reportToTemplateName: "初筛",
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

test("instantiateSpawnBundle 会为一个 finding 生成正反 summary 三个运行时实例和正确连线", () => {
  const topology = createVulnTopology();

  const bundle = instantiateSpawnBundle({
    topology,
    spawnRuleId: "finding-debate",
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
      { id: "pro#finding-debate:finding-001", templateName: "正方模板", role: "pro", displayName: "正方模板-1" },
      { id: "con#finding-debate:finding-001", templateName: "反方模板", role: "con", displayName: "反方模板-1" },
      { id: "summary#finding-debate:finding-001", templateName: "Summary模板", role: "summary", displayName: "Summary模板-1" },
    ],
  );
  assert.deepEqual(bundle.edges, [
    {
      source: "pro#finding-debate:finding-001",
      target: "con#finding-debate:finding-001",
      triggerOn: "review_fail",
    },
    {
      source: "con#finding-debate:finding-001",
      target: "pro#finding-debate:finding-001",
      triggerOn: "review_fail",
    },
    {
      source: "pro#finding-debate:finding-001",
      target: "summary#finding-debate:finding-001",
      triggerOn: "review_pass",
    },
    {
      source: "con#finding-debate:finding-001",
      target: "summary#finding-debate:finding-001",
      triggerOn: "review_pass",
    },
    {
      source: "summary#finding-debate:finding-001",
      target: "初筛",
      triggerOn: "review_pass",
    },
  ]);
});

test("同一 spawn rule 的多个实例会按顺序生成简短显示名，而不是暴露复杂内部 id", () => {
  const topology = createVulnTopology();

  const bundles = instantiateSpawnBundles({
    topology,
    spawnRuleId: "finding-debate",
    items: [
      { id: "finding-001", title: "路径穿越" },
      { id: "finding-002", title: "鉴权缺失" },
    ],
  });

  assert.deepEqual(
    bundles.flatMap((bundle) => bundle.nodes.map((node) => node.displayName)),
    ["正方模板-1", "反方模板-1", "Summary模板-1", "正方模板-2", "反方模板-2", "Summary模板-2"],
  );
});

test("instantiateSpawnBundles 会为多个 finding 批量生成互不冲突的实例组", () => {
  const topology = createVulnTopology();

  const bundles = instantiateSpawnBundles({
    topology,
    spawnRuleId: "finding-debate",
    items: [
      { id: "finding-001", title: "路径穿越" },
      { id: "finding-002", title: "鉴权缺失" },
    ],
  });

  assert.equal(bundles.length, 2);
  assert.equal(bundles[0]?.nodes[0]?.id, "pro#finding-debate:finding-001");
  assert.equal(bundles[1]?.nodes[0]?.id, "pro#finding-debate:finding-002");
  assert.notEqual(bundles[0]?.groupId, bundles[1]?.groupId);
});
