import { test } from "bun:test";
import assert from "node:assert/strict";

import {
  buildAvailableAgentIdsForFrontend,
  orderAgentsForFrontend,
  resolveDefaultSelectedAgentIdForFrontend,
} from "./frontend-agent-order";

test("orderAgentsForFrontend 会严格按拓扑定义中的 topology.nodes 排序成员", () => {
  const ordered = orderAgentsForFrontend(
    [
      { id: "Build", prompt: "", isWritable: false },
      { id: "TaskReview", prompt: "", isWritable: false },
      { id: "BA", prompt: "", isWritable: false },
    ],
    ["BA", "Build", "TaskReview"],
  );

  assert.deepEqual(ordered.map((agent) => agent.id), ["BA", "Build", "TaskReview"]);
});

test("buildAvailableAgentIdsForFrontend 会按拓扑定义中的 topology.nodes 输出可 @ 的成员顺序", () => {
  const available = buildAvailableAgentIdsForFrontend(
    [
      { id: "Build", prompt: "", isWritable: false },
      { id: "TaskReview", prompt: "", isWritable: false },
      { id: "BA", prompt: "", isWritable: false },
    ],
    ["BA", "Build", "TaskReview"],
  );

  assert.deepEqual(available, ["BA", "Build", "TaskReview"]);
});

test("resolveDefaultSelectedAgentIdForFrontend 会回到拓扑定义中的第一个 agent，而不是 workspace.agents 的第一个", () => {
  const selected = resolveDefaultSelectedAgentIdForFrontend({
    selectedAgentId: "",
    workspaceAgents: [
      { id: "Build", prompt: "", isWritable: false },
      { id: "TaskReview", prompt: "", isWritable: false },
      { id: "BA", prompt: "", isWritable: false },
    ],
    taskAgents: [
      { id: "Build", opencodeSessionId: "", opencodeAttachBaseUrl: "", status: "running", runCount: 1 },
      { id: "TaskReview", opencodeSessionId: "", opencodeAttachBaseUrl: "", status: "idle", runCount: 0 },
      { id: "BA", opencodeSessionId: "", opencodeAttachBaseUrl: "", status: "completed", runCount: 1 },
    ],
    orderedAgentIds: ["BA", "Build", "TaskReview"],
  });

  assert.equal(selected, "BA");
});

test("resolveDefaultSelectedAgentIdForFrontend 在没有可选 agent 时返回空串", () => {
  const selected = resolveDefaultSelectedAgentIdForFrontend({
    selectedAgentId: "",
    workspaceAgents: [],
    taskAgents: [],
    orderedAgentIds: [],
  });

  assert.equal(selected, "");
});
