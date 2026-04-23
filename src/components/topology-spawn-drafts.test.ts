import test from "node:test";
import assert from "node:assert/strict";

import type { TopologyRecord } from "@shared/types";

import { getTopologyDisplayNodeIds, upsertDebateSpawnDraft } from "./topology-spawn-drafts";

test("getTopologyDisplayNodeIds 会隐藏静态 spawn 节点，只展示真正的 agent 节点", () => {
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

  assert.deepEqual(getTopologyDisplayNodeIds(topology, []), ["初筛"]);
});

test("getTopologyDisplayNodeIds 不会误伤运行时实例化出来的 agent 节点", () => {
  const topology: TopologyRecord = {
    projectId: "project-runtime-spawn-visible",
    nodes: [
      "初筛",
      "疑点辩论",
      "正方-1",
      "反方-1",
    ],
    nodeRecords: [
      { id: "初筛", kind: "agent", templateName: "初筛" },
      { id: "疑点辩论", kind: "spawn", templateName: "疑点辩论", spawnRuleId: "spawn-rule:疑点辩论" },
      {
        id: "正方-1",
        kind: "agent",
        templateName: "正方",
      },
      {
        id: "反方-1",
        kind: "agent",
        templateName: "反方",
      },
    ],
    edges: [],
    spawnRules: [],
  };

  assert.deepEqual(getTopologyDisplayNodeIds(topology, []), [
    "初筛",
    "正方-1",
    "反方-1",
  ]);
});

test("getTopologyDisplayNodeIds 会用 runtime 实例替换已展开的静态模板节点", () => {
  const topology: TopologyRecord = {
    projectId: "project-runtime-spawn-replace-template",
    nodes: ["初筛", "正方", "反方", "裁决总结", "疑点辩论"],
    nodeRecords: [
      { id: "初筛", kind: "agent", templateName: "初筛" },
      { id: "正方", kind: "agent", templateName: "正方" },
      { id: "反方", kind: "agent", templateName: "反方" },
      { id: "裁决总结", kind: "agent", templateName: "裁决总结" },
      { id: "疑点辩论", kind: "spawn", templateName: "疑点辩论", spawnRuleId: "spawn-rule:疑点辩论" },
    ],
    edges: [],
    spawnRules: [
      {
        id: "spawn-rule:疑点辩论",
        name: "疑点辩论",
        spawnNodeName: "疑点辩论",
        sourceTemplateName: "初筛",
        entryRole: "正方",
        spawnedAgents: [
          { role: "正方", templateName: "正方" },
          { role: "反方", templateName: "反方" },
          { role: "裁决总结", templateName: "裁决总结" },
        ],
        edges: [
          { sourceRole: "正方", targetRole: "反方", triggerOn: "needs_revision", messageMode: "last" },
          { sourceRole: "反方", targetRole: "正方", triggerOn: "needs_revision", messageMode: "last" },
          { sourceRole: "正方", targetRole: "裁决总结", triggerOn: "approved", messageMode: "last" },
          { sourceRole: "反方", targetRole: "裁决总结", triggerOn: "approved", messageMode: "last" },
        ],
        exitWhen: "all_completed",
        reportToTemplateName: "初筛",
        reportToTriggerOn: "association",
      },
    ],
  };

  assert.deepEqual(
    getTopologyDisplayNodeIds(topology, ["初筛", "反方", "正方", "正方-1", "裁决总结", "裁决总结-1"]),
    ["初筛", "正方-1", "反方", "裁决总结-1"],
  );
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
    { source: "初筛", target: "疑点辩论工厂", triggerOn: "association", messageMode: "last" },
  ]);
});
