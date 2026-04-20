import assert from "node:assert/strict";
import test from "node:test";

import {
  compileTeamDsl,
  createTopology,
  matchesAppliedTeamDsl,
  matchesAppliedTeamDslAgents,
  matchesAppliedTeamDslTopology,
} from "./team-dsl";

const BA_PROMPT = "你是 BA。";
const CODE_REVIEW_PROMPT = "你是 CodeReview。";
const UNIT_TEST_PROMPT = "你是 UnitTest。";
const TASK_REVIEW_PROMPT = "你是 TaskReview。";

function createDevelopmentDslAgents() {
  return [
    { name: "BA", prompt: BA_PROMPT },
    "Build",
    { name: "CodeReview", prompt: CODE_REVIEW_PROMPT },
    { name: "UnitTest", prompt: UNIT_TEST_PROMPT },
    { name: "TaskReview", prompt: TASK_REVIEW_PROMPT },
  ];
}

test("compileTeamDsl 支持把一个 DSL 文件编译成 agents + topology", () => {
  const dsl = {
    agents: [
      "Build",
      {
        name: "BA",
        prompt: BA_PROMPT,
      },
      {
        name: "SecurityResearcher",
        prompt: "你负责漏洞挖掘。",
      },
    ],
    topology: {
      downstream: {
        BA: { Build: "association" },
        Build: { SecurityResearcher: "association" },
        SecurityResearcher: { Build: "needs_revision" },
      },
    },
  };

  const compiled = compileTeamDsl(dsl);

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
  assert.deepEqual(compiled.topology.edges, createTopology({
    downstream: {
      BA: { Build: "association" },
      Build: { SecurityResearcher: "association" },
      SecurityResearcher: { Build: "needs_revision" },
    },
  }).edges);
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

test("compileTeamDsl 会拒绝引用未声明 agent 的 topology 节点", () => {
  assert.throws(
    () =>
      compileTeamDsl({
        agents: ["Build"],
        topology: {
          downstream: {
            Build: { TaskReview: "association" },
          },
        },
      }),
    /TaskReview/,
  );
});

test("compileTeamDsl 会拒绝缺少 prompt 且不是内置模板的自定义 agent", () => {
  assert.throws(
    () =>
      compileTeamDsl({
        agents: [
          {
            name: "CustomPlanner",
          },
        ],
        topology: {
          downstream: {},
        },
      }),
    /CustomPlanner/,
  );
});

test("compileTeamDsl 在单 Agent 且没有 downstream 时，仍然会把该 Agent 写入 topology 节点", () => {
  const compiled = compileTeamDsl({
    agents: [
      {
        name: "BA",
        prompt: BA_PROMPT,
      },
    ],
    topology: {
      downstream: {},
    },
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

test("compileTeamDsl 会把 LangGraph 的 START 与可空 END 边界编译进 topology", () => {
  const compiled = compileTeamDsl({
    agents: createDevelopmentDslAgents(),
    topology: {
      downstream: {
        BA: { Build: "association" },
        Build: {
          CodeReview: "association",
          UnitTest: "association",
          TaskReview: "association",
        },
        CodeReview: { Build: "needs_revision" },
        UnitTest: { Build: "needs_revision" },
        TaskReview: { Build: "needs_revision" },
      },
      langgraph: {
        start: "BA",
        end: null,
      },
    },
  });

  assert.deepEqual(compiled.topology.langgraph, {
    start: {
      id: "__start__",
      targets: ["BA"],
    },
    end: null,
  });
});

test("compileTeamDsl 支持定义漏洞挖掘团队的双人多轮 spawn 辩论拓扑", () => {
  const compiled = compileTeamDsl({
    agents: [
      {
        name: "初筛",
        prompt: "你负责持续阅读代码并找出新的可疑点。",
      },
      {
        name: "疑点辩论工厂",
        prompt: "你是漏洞疑点辩论工厂。你不会直接输出最终结论，而是负责承接初筛给出的可疑点，并把每个可疑点实例化为正反双方多轮对弈与总结裁决 agent。",
      },
      {
        name: "正方",
        prompt: "你是正方。你的目标是证明当前可疑点是真漏洞，并在多轮对话中持续回应反方质疑。",
      },
      {
        name: "反方",
        prompt: "你是反方。你的目标是反驳漏洞成立，并在多轮对话中持续回应正方论据。",
      },
      {
        name: "裁决总结",
        prompt: "你负责汇总正反双方多轮对弈后已经收敛的结果，给出最终裁决，并把结果反馈给初筛。",
      },
    ],
    topology: {
      downstream: {
        初筛: {
          疑点辩论工厂: "spawn",
        },
      },
      spawn: {
        疑点辩论工厂: {
          name: "漏洞疑点辩论",
          itemKey: "findings",
          entryRole: "pro",
          agents: [
            { role: "pro", templateName: "正方" },
            { role: "con", templateName: "反方" },
            { role: "summary", templateName: "裁决总结" },
          ],
          links: [
            ["pro", "con", "needs_revision"],
            ["con", "pro", "needs_revision"],
            ["pro", "summary", "approved"],
            ["con", "summary", "approved"],
          ],
          reportTo: "初筛",
        },
      },
    },
  });

  assert.deepEqual(
    compiled.agents.map((agent) => agent.name),
    ["初筛", "疑点辩论工厂", "正方", "反方", "裁决总结"],
  );
  assert.deepEqual(compiled.topology.edges, [
    { source: "初筛", target: "疑点辩论工厂", triggerOn: "association" },
  ]);
  assert.equal(compiled.topology.spawnRules?.[0]?.itemKey, "findings");
  assert.deepEqual(compiled.topology.spawnRules?.[0]?.spawnedAgents, [
    { role: "pro", templateName: "正方" },
    { role: "con", templateName: "反方" },
    { role: "summary", templateName: "裁决总结" },
  ]);
  assert.deepEqual(compiled.topology.spawnRules?.[0]?.edges, [
    { sourceRole: "pro", targetRole: "con", triggerOn: "needs_revision" },
    { sourceRole: "con", targetRole: "pro", triggerOn: "needs_revision" },
    { sourceRole: "pro", targetRole: "summary", triggerOn: "approved" },
    { sourceRole: "con", targetRole: "summary", triggerOn: "approved" },
  ]);
  assert.equal(compiled.topology.spawnRules?.[0]?.reportToTemplateName, "初筛");
});

test("matchesAppliedTeamDsl 会把完全一致的当前团队配置识别为无需重复 apply", () => {
  const compiled = compileTeamDsl({
    agents: createDevelopmentDslAgents(),
    topology: {
      downstream: {
        BA: { Build: "association" },
        Build: {
          CodeReview: "association",
          UnitTest: "association",
          TaskReview: "association",
        },
        CodeReview: { Build: "needs_revision" },
        UnitTest: { Build: "needs_revision" },
        TaskReview: { Build: "needs_revision" },
      },
    },
  });

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
  const compiled = compileTeamDsl({
    agents: createDevelopmentDslAgents(),
    topology: {
      downstream: {
        BA: { Build: "association" },
        Build: {
          CodeReview: "association",
          UnitTest: "association",
          TaskReview: "association",
        },
        CodeReview: { Build: "needs_revision" },
        UnitTest: { Build: "needs_revision" },
        TaskReview: { Build: "needs_revision" },
      },
    },
  });

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
