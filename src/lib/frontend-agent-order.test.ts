import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAvailableAgentIdsForFrontend,
  orderAgentsForFrontend,
  resolveDefaultSelectedAgentIdForFrontend,
} from "./frontend-agent-order";

test("orderAgentsForFrontend 会严格按 JSON topology.nodes 排序成员", () => {
  const ordered = orderAgentsForFrontend(
    [
      { id: "Build", prompt: "" },
      { id: "TaskReview", prompt: "" },
      { id: "BA", prompt: "" },
    ],
    {
      nodes: ["BA", "Build", "TaskReview"],
    },
  );

  assert.deepEqual(ordered.map((agent) => agent.id), ["BA", "Build", "TaskReview"]);
});

test("buildAvailableAgentIdsForFrontend 会按 JSON topology.nodes 输出可 @ 的成员顺序", () => {
  const available = buildAvailableAgentIdsForFrontend(
    [
      { id: "Build", prompt: "" },
      { id: "TaskReview", prompt: "" },
      { id: "BA", prompt: "" },
    ],
    {
      nodes: ["BA", "Build", "TaskReview"],
    },
  );

  assert.deepEqual(available, ["BA", "Build", "TaskReview"]);
});

test("resolveDefaultSelectedAgentIdForFrontend 会回到 JSON 中的第一个 agent，而不是 workspace.agents 的第一个", () => {
  const selected = resolveDefaultSelectedAgentIdForFrontend({
    selectedAgentId: null,
    workspaceAgents: [
      { id: "Build", prompt: "" },
      { id: "TaskReview", prompt: "" },
      { id: "BA", prompt: "" },
    ],
    taskAgents: [
      { taskId: "task-1", id: "Build", opencodeSessionId: null, opencodeAttachBaseUrl: null, status: "running", runCount: 1 },
      { taskId: "task-1", id: "TaskReview", opencodeSessionId: null, opencodeAttachBaseUrl: null, status: "idle", runCount: 0 },
      { taskId: "task-1", id: "BA", opencodeSessionId: null, opencodeAttachBaseUrl: null, status: "completed", runCount: 1 },
    ],
    topology: {
      nodes: ["BA", "Build", "TaskReview"],
    },
  });

  assert.equal(selected, "BA");
});
