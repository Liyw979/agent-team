import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BUILTIN_AGENT_TEMPLATES,
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

test("UnitTest 默认模板使用单元测试审查文案", () => {
  const template = DEFAULT_BUILTIN_AGENT_TEMPLATES.find((item) => item.name === "UnitTest");

  assert.notEqual(template, undefined);
  assert.equal(
    template.prompt,
    "你是单元测试审查角色，负责先检查当前改动是否提供了测试；如果没有测试，要明确指出缺失测试。若存在测试，再继续检查单元测试是否遵循四条标准：一个功能点一个测试、分支覆盖完全、每个测试有注释、执行极快、尽量使用纯函数而不是 Mock。\n\n并给出修改建议。",
  );
});
