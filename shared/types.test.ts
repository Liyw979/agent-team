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

  assert.equal(topology.startAgentId, "Build");
  assert.deepEqual(topology.nodes, ["Build", "BA", "TaskReview"]);
  assert.equal(topology.edges.length, 1);
  assert.deepEqual(topology.edges[0], {
    source: "Build",
    target: "BA",
    triggerOn: "association",
  });
  assert.equal(
    topology.edges.some((edge) => edge.triggerOn === "review_pass" || edge.triggerOn === "review_fail"),
    false,
  );
});

test("默认拓扑在缺少 Build 时不会偷偷把首个 Agent 当起点", () => {
  const agents: TopologyAgentSeed[] = [
    { name: "BA" },
    { name: "TaskReview" },
  ];

  const topology = createDefaultTopology("project-2", agents);

  assert.equal(topology.startAgentId, null);
  assert.deepEqual(topology.nodes, ["BA", "TaskReview"]);
  assert.deepEqual(topology.edges, []);
});

test("存在 review 出边时 isReviewAgentInTopology 返回 true", () => {
  const topology: TopologyRecord = {
    projectId: "project-1",
    startAgentId: "Build",
    nodes: ["Build", "TaskReview"],
    edges: [
      {
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
    "你是单元测试审查角色，必须主动阅读本轮改动里的实现代码与测试代码，判断测试是否真的覆盖了这次实现，而不是只看测试文件是否存在。\n\n先检查当前改动是否提供了测试；如果没有测试，要明确指出缺失测试。若存在测试，再继续结合实现代码检查单元测试是否遵循四条标准：一个功能点一个测试、分支覆盖完全、每个测试有注释、执行极快、尽量使用纯函数而不是 Mock。\n\n同时检查测试断言是否真正覆盖了核心分支、边界条件和失败路径，是否出现“代码改了但测试没有跟上”或“测试存在但没有验证关键行为”的情况。\n\n并给出修改建议。",
  );
});

test("TaskReview 默认模板明确聚焦功能交付而不是代码实现细节", () => {
  const template = DEFAULT_BUILTIN_AGENT_TEMPLATES.find((item) => item.name === "TaskReview");

  assert.notEqual(template, undefined);
  assert.match(template.prompt, /功能.*实现|功能.*交付|业务.*目标/u);
  assert.match(template.prompt, /不要.*代码|不.*代码风格|不.*架构|不.*实现细节/u);
});

test("UnitTest 默认模板要求主动查看代码与测试的一致性", () => {
  const template = DEFAULT_BUILTIN_AGENT_TEMPLATES.find((item) => item.name === "UnitTest");

  assert.notEqual(template, undefined);
  assert.match(template.prompt, /主动.*看代码|主动.*阅读.*代码|结合.*代码/u);
});

test("CodeReview 默认模板要求主动阅读代码实现", () => {
  const template = DEFAULT_BUILTIN_AGENT_TEMPLATES.find((item) => item.name === "CodeReview");

  assert.notEqual(template, undefined);
  assert.match(template.prompt, /主动.*看代码|主动.*阅读.*代码|逐段.*代码|结合.*代码/u);
});
