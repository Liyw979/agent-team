import assert from "node:assert/strict";
import test from "node:test";

import type { TopologyRecord } from "@shared/types";

import { createGraphTaskState } from "./gating-router";
import { spawnRuntimeAgentsForItems } from "./gating-spawn";

function createSpawnTopology(): TopologyRecord {
  return {
    projectId: "spawn-state-project",
    nodes: ["初筛", "正方模板", "反方模板", "Summary模板"],
    nodeRecords: [
      { id: "初筛", kind: "agent", templateName: "初筛" },
      { id: "正方模板", kind: "agent", templateName: "正方模板" },
      { id: "反方模板", kind: "agent", templateName: "反方模板" },
      { id: "Summary模板", kind: "agent", templateName: "Summary模板" },
    ],
    edges: [],
    spawnRules: [
      {
        id: "finding-debate",
        name: "漏洞疑点辩论",
        sourceTemplateName: "初筛",
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

test("spawnRuntimeAgentsForItems 会把 finding 批量实例化进 GraphTaskState", () => {
  const topology = createSpawnTopology();
  const state = createGraphTaskState({
    taskId: "task-spawn-1",
    projectId: topology.projectId,
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
  assert.equal(state.runtimeEdges.length, 10);
  assert.equal(state.agentStatusesByName["正方模板-1"], "idle");
  assert.equal(state.agentStatusesByName["Summary模板-2"], "idle");
});
