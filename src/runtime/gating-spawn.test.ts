import assert from "node:assert/strict";
import test from "node:test";

import type { TopologyRecord } from "@shared/types";

import { createGraphTaskState } from "./gating-router";
import { spawnRuntimeAgentsForItems } from "./gating-spawn";

function createSpawnTopology(): TopologyRecord {
  return {
    nodes: ["初筛", "漏洞疑点辩论", "正方模板", "反方模板", "Summary模板"],
    nodeRecords: [
      { id: "初筛", kind: "agent", templateName: "初筛" },
      { id: "漏洞疑点辩论", kind: "spawn", templateName: "漏洞疑点辩论", spawnRuleId: "finding-debate" },
      { id: "正方模板", kind: "agent", templateName: "正方模板" },
      { id: "反方模板", kind: "agent", templateName: "反方模板" },
      { id: "Summary模板", kind: "agent", templateName: "Summary模板" },
    ],
    edges: [
      { source: "初筛", target: "漏洞疑点辩论", triggerOn: "transfer", messageMode: "last" },
    ],
    spawnRules: [
      {
        id: "finding-debate",
        spawnNodeName: "漏洞疑点辩论",
        sourceTemplateName: "初筛",
        entryRole: "pro",
        spawnedAgents: [
          { role: "pro", templateName: "正方模板" },
          { role: "con", templateName: "反方模板" },
          { role: "summary", templateName: "Summary模板" },
        ],
        edges: [
          { sourceRole: "pro", targetRole: "con", triggerOn: "continue", messageMode: "last" },
          { sourceRole: "con", targetRole: "pro", triggerOn: "continue", messageMode: "last" },
          { sourceRole: "pro", targetRole: "summary", triggerOn: "complete", messageMode: "last" },
          { sourceRole: "con", targetRole: "summary", triggerOn: "complete", messageMode: "last" },
        ],
        exitWhen: "one_side_agrees",
        reportToTemplateName: "初筛",
      },
    ],
  };
}

test("spawnRuntimeAgentsForItems 会把 finding 批量实例化进 GraphTaskState", () => {
  const topology = createSpawnTopology();
  const state = createGraphTaskState({
    taskId: "task-spawn-1",
    topology,
  });

  spawnRuntimeAgentsForItems({
    state,
    spawnRuleId: "finding-debate",
    items: [
      { id: "finding-001", title: "路径穿越" },
      { id: "finding-002", title: "鉴权缺失" },
    ],
  });

  assert.equal(state.spawnBundles.length, 2);
  assert.equal(state.runtimeNodes.length, 6);
  assert.equal(state.runtimeEdges.length, 12);
  assert.equal(state.agentStatusesByName["正方模板-1"], "idle");
  assert.equal(state.agentStatusesByName["Summary模板-2"], "idle");
});
