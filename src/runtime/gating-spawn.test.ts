import assert from "node:assert/strict";
import test from "node:test";

import type { TopologyRecord } from "@shared/types";

import { createGraphTaskState } from "./gating-router";
import { spawnRuntimeAgentsForItems } from "./gating-spawn";

function createSpawnTopology(): TopologyRecord {
  return {
    nodes: ["线索发现", "漏洞疑点辩论", "漏洞论证模板", "漏洞挑战模板", "Summary模板"],
    nodeRecords: [
      { id: "线索发现", kind: "agent", templateName: "线索发现" },
      { id: "漏洞疑点辩论", kind: "spawn", templateName: "漏洞疑点辩论", spawnRuleId: "finding-debate" },
      { id: "漏洞论证模板", kind: "agent", templateName: "漏洞论证模板" },
      { id: "漏洞挑战模板", kind: "agent", templateName: "漏洞挑战模板" },
      { id: "Summary模板", kind: "agent", templateName: "Summary模板" },
    ],
    edges: [
      { source: "线索发现", target: "漏洞疑点辩论", triggerOn: "transfer", messageMode: "last" },
    ],
    spawnRules: [
      {
        id: "finding-debate",
        spawnNodeName: "漏洞疑点辩论",
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
  assert.equal(state.agentStatusesByName["漏洞论证模板-1"], "idle");
  assert.equal(state.agentStatusesByName["Summary模板-2"], "idle");
});
