import assert from "node:assert/strict";
import test from "node:test";

import {
  compileTeamDsl,
  matchesAppliedTeamDsl,
  matchesAppliedTeamDslAgents,
  matchesAppliedTeamDslTopology,
} from "./team-dsl";

const BA_PROMPT = "你是 BA。";
const CODE_REVIEW_PROMPT = "你是 CodeReview。";
const UNIT_TEST_PROMPT = "你是 UnitTest。";
const TASK_REVIEW_PROMPT = "你是 TaskReview。";

function createDevelopmentGraphDsl() {
  return {
    entry: "BA",
    nodes: [
      { type: "agent" as const, name: "BA", prompt: BA_PROMPT },
      { type: "agent" as const, name: "Build", writable: true },
      { type: "agent" as const, name: "CodeReview", prompt: CODE_REVIEW_PROMPT },
      { type: "agent" as const, name: "UnitTest", prompt: UNIT_TEST_PROMPT },
      { type: "agent" as const, name: "TaskReview", prompt: TASK_REVIEW_PROMPT },
    ],
    links: [
      ["BA", "Build", "association"] as const,
      ["Build", "CodeReview", "association"] as const,
      ["Build", "UnitTest", "association"] as const,
      ["Build", "TaskReview", "association"] as const,
      ["CodeReview", "Build", "needs_revision"] as const,
      ["UnitTest", "Build", "needs_revision"] as const,
      ["TaskReview", "Build", "needs_revision"] as const,
    ],
  };
}

test("compileTeamDsl 支持把递归式图 DSL 编译成 agents + topology", () => {
  const compiled = compileTeamDsl({
    entry: "BA",
    nodes: [
      {
        type: "agent",
        name: "Build",
        writable: true,
      },
      {
        type: "agent",
        name: "BA",
        prompt: BA_PROMPT,
      },
      {
        type: "agent",
        name: "SecurityResearcher",
        prompt: "你负责漏洞挖掘。",
      },
    ],
    links: [
      ["BA", "Build", "association"],
      ["Build", "SecurityResearcher", "association"],
      ["SecurityResearcher", "Build", "needs_revision"],
    ],
  });

  assert.deepEqual(
    compiled.agents.map((agent) => ({
      name: agent.name,
      prompt: agent.prompt,
      templateName: agent.templateName,
      isWritable: agent.isWritable,
    })),
    [
      { name: "Build", prompt: null, templateName: "Build", isWritable: true },
      { name: "BA", prompt: BA_PROMPT, templateName: null, isWritable: false },
      { name: "SecurityResearcher", prompt: "你负责漏洞挖掘。", templateName: null, isWritable: false },
    ],
  );
  assert.deepEqual(compiled.topology.edges, [
    { source: "BA", target: "Build", triggerOn: "association" },
    { source: "Build", target: "SecurityResearcher", triggerOn: "association" },
    { source: "SecurityResearcher", target: "Build", triggerOn: "needs_revision" },
  ]);
  assert.deepEqual(compiled.topology.nodeRecords, [
    {
      id: "Build",
      kind: "agent",
      templateName: "Build",
      writable: true,
    },
    {
      id: "BA",
      kind: "agent",
      templateName: "BA",
      prompt: BA_PROMPT,
    },
    {
      id: "SecurityResearcher",
      kind: "agent",
      templateName: "SecurityResearcher",
      prompt: "你负责漏洞挖掘。",
    },
  ]);
});

test("compileTeamDsl 不应把多个显式 writable 压缩成单个 Agent", () => {
  const compiled = compileTeamDsl({
    entry: "BA",
    nodes: [
      {
        type: "agent",
        name: "Build",
        writable: true,
      },
      {
        type: "agent",
        name: "BA",
        prompt: BA_PROMPT,
        writable: true,
      },
    ],
    links: [
      ["BA", "Build", "association"],
    ],
  });

  assert.deepEqual(
    compiled.agents.map((agent) => ({
      name: agent.name,
      isWritable: agent.isWritable,
    })),
    [
      { name: "Build", isWritable: true },
      { name: "BA", isWritable: true },
    ],
  );
});

test("compileTeamDsl 不再支持旧的 agents + topology.downstream DSL", () => {
  assert.throws(
    () =>
      compileTeamDsl({
        agents: [{ name: "Build" }],
        topology: {
          downstream: {},
        },
      } as never),
    /只支持递归式 entry \+ nodes \+ links DSL/u,
  );
});

test("compileTeamDsl 会拒绝非法的 node.type", () => {
  assert.throws(
    () =>
      compileTeamDsl({
        entry: "Build",
        nodes: [
          {
            type: "weird",
            name: "Build",
          },
        ],
        links: [],
      } as never),
    /type 是节点判别字段，只允许 agent 或 spawn/u,
  );
});

test("compileTeamDsl 会拒绝引用未声明节点的 graph.links", () => {
  assert.throws(
    () =>
      compileTeamDsl({
        entry: "Build",
        nodes: [{ type: "agent", name: "Build", writable: true }],
        links: [
          ["Build", "TaskReview", "association"],
        ],
      }),
    /TaskReview/,
  );
});

test("compileTeamDsl 会拒绝缺少 prompt 且不是内置模板的自定义 agent", () => {
  assert.throws(
    () =>
      compileTeamDsl({
        entry: "CustomPlanner",
        nodes: [
          {
            type: "agent",
            name: "CustomPlanner",
          },
        ],
        links: [],
      }),
    /CustomPlanner/,
  );
});

test("compileTeamDsl 在单 Agent 且没有 links 时，仍然会把该 Agent 写入 topology 节点", () => {
  const compiled = compileTeamDsl({
    entry: "BA",
    nodes: [
      {
        type: "agent",
        name: "BA",
        prompt: BA_PROMPT,
      },
    ],
    links: [],
  });

  assert.deepEqual(compiled.topology.nodes, ["BA"]);
  assert.deepEqual(compiled.topology.nodeRecords, [
    {
      id: "BA",
      kind: "agent",
      templateName: "BA",
      prompt: BA_PROMPT,
    },
  ]);
});

test("compileTeamDsl 会把 graph.entry 编译进 LangGraph START，并保持 END 为 null", () => {
  const compiled = compileTeamDsl(createDevelopmentGraphDsl());

  assert.deepEqual(compiled.topology.langgraph, {
    start: {
      id: "__start__",
      targets: ["BA"],
    },
    end: null,
  });
});

test("compileTeamDsl 支持定义漏洞挖掘团队的正反多轮 spawn 辩论拓扑", () => {
  const compiled = compileTeamDsl({
    entry: "初筛",
    nodes: [
      {
        type: "agent",
        name: "初筛",
        prompt: "你负责持续阅读代码并找出新的可疑点。",
      },
      {
        type: "spawn",
        name: "疑点辩论",
        graph: {
          entry: "正方",
          nodes: [
            {
              type: "agent",
              name: "正方",
              prompt: "你是正方。你的目标是证明当前可疑点是真漏洞，并在多轮对话中持续回应反方质疑。",
            },
            {
              type: "agent",
              name: "反方",
              prompt: "你是反方。你的目标是反驳漏洞成立，并在多轮对话中持续回应正方论据。",
            },
            {
              type: "agent",
              name: "裁决总结",
              prompt: "你负责汇总正反双方多轮对弈后已经收敛的结果，给出最终裁决，并把结果反馈给初筛。",
            },
          ],
          links: [
            ["正方", "反方", "needs_revision"],
            ["反方", "正方", "needs_revision"],
            ["正方", "裁决总结", "approved"],
            ["反方", "裁决总结", "approved"],
          ],
        },
      },
    ],
    links: [
      ["初筛", "疑点辩论", "association"],
      ["疑点辩论", "初筛", "association"],
    ],
  });

  assert.deepEqual(
    compiled.agents.map((agent) => agent.name),
    ["初筛", "正方", "反方", "裁决总结"],
  );
  assert.deepEqual(compiled.topology.edges, [
    { source: "初筛", target: "疑点辩论", triggerOn: "association" },
    { source: "疑点辩论", target: "初筛", triggerOn: "association" },
  ]);
  assert.equal(compiled.topology.spawnRules?.[0]?.itemsFrom, "items");
  assert.deepEqual(compiled.topology.spawnRules?.[0]?.spawnedAgents, [
    { role: "正方", templateName: "正方" },
    { role: "反方", templateName: "反方" },
    { role: "裁决总结", templateName: "裁决总结" },
  ]);
  assert.equal(compiled.topology.spawnRules?.[0]?.reportToTemplateName, "初筛");
  assert.equal(compiled.topology.spawnRules?.[0]?.reportToTriggerOn, "association");
  assert.deepEqual(compiled.topology.spawnRules?.[0]?.edges, [
    { sourceRole: "正方", targetRole: "反方", triggerOn: "needs_revision" },
    { sourceRole: "反方", targetRole: "正方", triggerOn: "needs_revision" },
    { sourceRole: "正方", targetRole: "裁决总结", triggerOn: "approved" },
    { sourceRole: "反方", targetRole: "裁决总结", triggerOn: "approved" },
  ]);
});

test("matchesAppliedTeamDsl 会把完全一致的当前团队配置识别为无需重复 apply", () => {
  const compiled = compileTeamDsl(createDevelopmentGraphDsl());

  assert.equal(
    matchesAppliedTeamDsl(
      [
        { name: "BA", prompt: BA_PROMPT, isWritable: false },
        { name: "Build", prompt: "", isWritable: true },
        { name: "CodeReview", prompt: CODE_REVIEW_PROMPT, isWritable: false },
        { name: "UnitTest", prompt: UNIT_TEST_PROMPT, isWritable: false },
        { name: "TaskReview", prompt: TASK_REVIEW_PROMPT, isWritable: false },
      ],
      compiled.topology,
      compiled,
    ),
    true,
  );
});

test("matchesAppliedTeamDslAgents 会把 agent 一致但拓扑不同识别为只需同步 topology", () => {
  const compiled = compileTeamDsl(createDevelopmentGraphDsl());

  assert.equal(
    matchesAppliedTeamDslAgents(
      [
        { name: "BA", prompt: BA_PROMPT, isWritable: false },
        { name: "Build", prompt: "", isWritable: true },
        { name: "CodeReview", prompt: CODE_REVIEW_PROMPT, isWritable: false },
        { name: "UnitTest", prompt: UNIT_TEST_PROMPT, isWritable: false },
        { name: "TaskReview", prompt: TASK_REVIEW_PROMPT, isWritable: false },
      ],
      compiled,
    ),
    true,
  );
  assert.equal(
    matchesAppliedTeamDslTopology(
      {
        nodes: ["Build", "BA", "CodeReview", "UnitTest", "TaskReview"],
        edges: [{ source: "Build", target: "BA", triggerOn: "association" }],
      },
      compiled,
    ),
    false,
  );
});
