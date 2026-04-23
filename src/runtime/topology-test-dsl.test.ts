import assert from "node:assert/strict";
import test from "node:test";

import { createTopology } from "./topology-test-dsl";

test("createTopology 支持以前端下游模板 DSL 生成普通拓扑", () => {
  const topology = createTopology({
    projectId: "dsl-basic",
    downstream: {
      BA: { Build: "transfer" },
      Build: {
        CodeReview: "transfer",
        UnitTest: "transfer",
        TaskReview: "transfer",
      },
      CodeReview: {
        Build: "continue",
        TaskReview: "complete",
      },
    },
  });

  assert.deepEqual(topology.nodes, ["BA", "Build", "CodeReview", "UnitTest", "TaskReview"]);
  assert.deepEqual(topology.edges, [
    { source: "BA", target: "Build", triggerOn: "transfer", messageMode: "last" },
    { source: "Build", target: "CodeReview", triggerOn: "transfer", messageMode: "last" },
    { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
    { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
    { source: "CodeReview", target: "Build", triggerOn: "continue", messageMode: "last" },
    { source: "CodeReview", target: "TaskReview", triggerOn: "complete", messageMode: "last" },
  ]);
});

test("createTopology 支持把 spawn 作为下游模式写进 DSL", () => {
  const topology = createTopology({
    projectId: "dsl-spawn",
    downstream: {
      Build: { TaskReview: "spawn" },
      TaskReview: { Build: "continue" },
    },
    spawn: {
      TaskReview: {},
    },
  });

  assert.deepEqual(topology.edges, [
    { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
    { source: "TaskReview", target: "Build", triggerOn: "continue", messageMode: "last" },
  ]);
  assert.deepEqual(topology.nodeRecords, [
    { id: "Build", kind: "agent", templateName: "Build" },
    {
      id: "TaskReview",
      kind: "spawn",
      templateName: "TaskReview",
      spawnEnabled: true,
      spawnRuleId: "spawn-rule:TaskReview",
    },
  ]);
  assert.deepEqual(topology.spawnRules, [
    {
      id: "spawn-rule:TaskReview",
      name: "TaskReview",
      spawnNodeName: "TaskReview",
      sourceTemplateName: "Build",
      entryRole: "entry",
      spawnedAgents: [{ role: "entry", templateName: "TaskReview" }],
      edges: [],
      exitWhen: "one_side_agrees",
      reportToTemplateName: "Build",
    },
  ]);
});
