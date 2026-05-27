import assert from "node:assert/strict";
import { test } from "bun:test";

import { createTopologyFlowRecord, type TopologyRecord } from "@shared/types";

import { createEmptyGraphTaskState } from "./gating-state";
import { buildEffectiveTopology } from "./runtime-topology-graph";

test("buildEffectiveTopology 不会因为 nodeRecords 只保存局部节点而丢掉 topology.nodes 里的静态节点", () => {
  const topology: TopologyRecord = {
    nodes: ["BA", "Build", "QA"],
    edges: [
      { source: "BA", target: "Build", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "Build", target: "QA", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
    ],
    flow: createTopologyFlowRecord({
      nodes: ["BA", "Build", "QA"],
      edges: [
        { source: "BA", target: "Build", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "Build", target: "QA", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
      ],
    }),
    nodeRecords: [
      { id: "BA", kind: "agent", templateName: "BA", initialMessageRouting: { mode: "inherit" }, prompt: "", writable: false },
    ],
  };
  const state = createEmptyGraphTaskState({
    topology,
  });

  const effective = buildEffectiveTopology(state);

  assert.deepEqual(effective.nodes, ["BA", "Build", "QA"]);
});
