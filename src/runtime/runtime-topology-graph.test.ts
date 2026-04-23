import assert from "node:assert/strict";
import test from "node:test";

import type { TopologyRecord } from "@shared/types";

import { createGraphTaskState } from "./gating-router";
import { buildEffectiveTopology } from "./runtime-topology-graph";

test("buildEffectiveTopology 不会因为 nodeRecords 只保存局部节点而丢掉 topology.nodes 里的静态节点", () => {
  const topology: TopologyRecord = {
    projectId: "runtime-topology-node-records",
    nodes: ["BA", "Build", "QA"],
    edges: [
      { source: "BA", target: "Build", triggerOn: "association", messageMode: "last" },
      { source: "Build", target: "QA", triggerOn: "association", messageMode: "last" },
    ],
    nodeRecords: [
      { id: "BA", kind: "agent", templateName: "BA", spawnEnabled: false },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-runtime-topology",
    topology,
  });

  const effective = buildEffectiveTopology(state);

  assert.deepEqual(effective.nodes, ["BA", "Build", "QA"]);
});
