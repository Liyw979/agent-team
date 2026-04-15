import test from "node:test";
import assert from "node:assert/strict";

import {
  createDefaultTopology,
  isReviewAgentInTopology,
  type TopologyAgentSeed,
  type TopologyRecord,
} from "./types";

test("默认拓扑只生成首节点到次节点的 association 边", () => {
  const agents: TopologyAgentSeed[] = [
    { name: "BA" },
    { name: "Build" },
    { name: "TaskReview" },
  ];

  const topology = createDefaultTopology("project-1", agents);

  assert.equal(topology.startAgentId, "BA");
  assert.deepEqual(topology.agentOrderIds, ["BA", "Build", "TaskReview"]);
  assert.equal(topology.edges.length, 1);
  assert.deepEqual(topology.edges[0], {
    id: "BA__Build__association",
    source: "BA",
    target: "Build",
    triggerOn: "association",
  });
  assert.equal(
    topology.edges.some((edge) => edge.triggerOn === "review_pass" || edge.triggerOn === "review_fail"),
    false,
  );
});

test("存在 review 出边时 isReviewAgentInTopology 返回 true", () => {
  const topology: TopologyRecord = {
    projectId: "project-1",
    startAgentId: "Build",
    agentOrderIds: ["Build", "TaskReview"],
    nodes: [
      { id: "Build", label: "Build", kind: "agent" },
      { id: "TaskReview", label: "TaskReview", kind: "agent" },
    ],
    edges: [
      {
        id: "TaskReview__Build__review_fail",
        source: "TaskReview",
        target: "Build",
        triggerOn: "review_fail",
      },
    ],
  };

  assert.equal(isReviewAgentInTopology(topology, "TaskReview"), true);
  assert.equal(isReviewAgentInTopology(topology, "Build"), false);
});
