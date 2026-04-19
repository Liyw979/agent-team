import test from "node:test";
import assert from "node:assert/strict";

import type { TopologyRecord } from "@shared/types";

import { getTopologyDisplayNodeIds, upsertDebateSpawnDraft } from "./topology-spawn-drafts";

test("getTopologyDisplayNodeIds 优先返回 nodeRecords 中的节点，允许 GUI 展示 spawn 节点", () => {
  const topology: TopologyRecord = {
    projectId: "project-1",
    nodes: ["初筛", "正方模板", "反方模板", "Summary模板"],
    nodeRecords: [
      { id: "初筛", kind: "agent", templateName: "初筛" },
      { id: "疑点辩论工厂", kind: "spawn", templateName: "正方模板", spawnRuleId: "spawn-rule:漏洞团队" },
    ],
    edges: [],
    spawnRules: [],
  };

  assert.deepEqual(getTopologyDisplayNodeIds(topology, []), ["初筛", "疑点辩论工厂"]);
});

test("upsertDebateSpawnDraft 会生成 GUI 需要保存的 spawn 节点、spawnRule 和 source->spawn 边", () => {
  const topology: TopologyRecord = {
    projectId: "project-2",
    nodes: ["初筛", "正方模板", "反方模板", "Summary模板"],
    edges: [],
    nodeRecords: [
      { id: "初筛", kind: "agent", templateName: "初筛" },
      { id: "正方模板", kind: "agent", templateName: "正方模板" },
      { id: "反方模板", kind: "agent", templateName: "反方模板" },
      { id: "Summary模板", kind: "agent", templateName: "Summary模板" },
    ],
    spawnRules: [],
  };

  const next = upsertDebateSpawnDraft(topology, {
    teamName: "疑点辩论工厂",
    sourceTemplateName: "初筛",
    proTemplateName: "正方模板",
    conTemplateName: "反方模板",
    summaryTemplateName: "Summary模板",
    reportToTemplateName: "初筛",
  });

  assert.equal(next.nodeRecords?.some((node) => node.id === "疑点辩论工厂" && node.kind === "spawn"), true);
  assert.equal(next.spawnRules?.[0]?.id, "spawn-rule:疑点辩论工厂");
  assert.deepEqual(next.edges, [
    { source: "初筛", target: "疑点辩论工厂", triggerOn: "association" },
  ]);
});
