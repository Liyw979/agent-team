import assert from "node:assert/strict";
import test from "node:test";

import {
  compileTeamDsl,
  matchesAppliedTeamDsl,
  matchesAppliedTeamDslAgents,
  matchesAppliedTeamDslTopology,
  type TeamDslDefinition,
} from "./team-dsl";

const BA_PROMPT = "你是 BA。";
const CODE_REVIEW_PROMPT = "你是 CodeReview。";
const UNIT_TEST_PROMPT = "你是 UnitTest。";
const TASK_REVIEW_PROMPT = "你是 TaskReview。";

function agentNode(id: string, prompt: string, writable: boolean) {
  return {
    type: "agent" as const,
    id,
    prompt,
    writable,
  };
}

function spawnNode(id: string, graph: TeamDslDefinition) {
  return {
    type: "spawn" as const,
    id,
    graph,
  };
}

function link(
  from: string,
  to: string,
  trigger_type: "transfer" | "complete" | "continue",
  message_type: "none" | "last" | "all",
) {
  return {
    from,
    to,
    trigger_type,
    message_type,
  };
}

function endLink(
  from: string,
  trigger_type: "transfer" | "complete" | "continue",
  message_type: "none" | "last" | "all",
) {
  return {
    from,
    to: "__end__" as const,
    trigger_type,
    message_type,
  };
}

function createDevelopmentGraphDsl() {
  return {
    entry: "BA",
    nodes: [
      agentNode("BA", BA_PROMPT, false),
      agentNode("Build", "", true),
      agentNode("CodeReview", CODE_REVIEW_PROMPT, false),
      agentNode("UnitTest", UNIT_TEST_PROMPT, false),
      agentNode("TaskReview", TASK_REVIEW_PROMPT, false),
    ],
    links: [
      link("BA", "Build", "transfer", "last"),
      link("Build", "CodeReview", "transfer", "last"),
      link("Build", "UnitTest", "transfer", "last"),
      link("Build", "TaskReview", "transfer", "last"),
      link("CodeReview", "Build", "continue", "last"),
      link("UnitTest", "Build", "continue", "last"),
      link("TaskReview", "Build", "continue", "last"),
    ],
  };
}

test("compileTeamDsl 支持把递归式图 DSL 编译成 agents + topology", () => {
  const compiled = compileTeamDsl({
    entry: "BA",
    nodes: [
      agentNode("Build", "", true),
      agentNode("BA", BA_PROMPT, false),
      agentNode("SecurityResearcher", "你负责漏洞挖掘。", false),
    ],
    links: [
      link("BA", "Build", "transfer", "last"),
      link("Build", "SecurityResearcher", "transfer", "last"),
      link("SecurityResearcher", "Build", "continue", "last"),
    ],
  });

  assert.deepEqual(
    compiled.agents.map((agent) => ({
      id: agent.id,
      prompt: agent.prompt,
      templateName: agent.templateName,
      isWritable: agent.isWritable,
    })),
    [
      { id: "Build", prompt: "", templateName: "Build", isWritable: true },
      { id: "BA", prompt: BA_PROMPT, templateName: null, isWritable: false },
      { id: "SecurityResearcher", prompt: "你负责漏洞挖掘。", templateName: null, isWritable: false },
    ],
  );
  assert.deepEqual(compiled.topology.edges, [
    { source: "BA", target: "Build", triggerOn: "transfer", messageMode: "last" },
    { source: "Build", target: "SecurityResearcher", triggerOn: "transfer", messageMode: "last" },
    { source: "SecurityResearcher", target: "Build", triggerOn: "continue", messageMode: "last" },
  ]);
  assert.deepEqual(compiled.topology.nodeRecords, [
    {
      id: "Build",
      kind: "agent",
      templateName: "Build",
      prompt: "",
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

test("compileTeamDsl 输出的 Agent 记录使用 id 字段而不是 name 字段", () => {
  const compiled = compileTeamDsl({
    entry: "Build",
    nodes: [
      agentNode("Build", "", true),
    ],
    links: [],
  });

  const agent = compiled.agents[0] as unknown as Record<string, unknown>;
  assert.equal(agent["id"], "Build");
  assert.equal(Object.prototype.hasOwnProperty.call(agent, "name"), false);
});

test("compileTeamDsl 不应把多个显式 writable 压缩成单个 Agent", () => {
  const compiled = compileTeamDsl({
    entry: "BA",
    nodes: [
      agentNode("Build", "", true),
      agentNode("BA", BA_PROMPT, true),
    ],
    links: [
      link("BA", "Build", "transfer", "last"),
    ],
  });

  assert.deepEqual(
    compiled.agents.map((agent) => ({
      id: agent.id,
      isWritable: agent.isWritable,
    })),
    [
      { id: "Build", isWritable: true },
      { id: "BA", isWritable: true },
    ],
  );
});

test("compileTeamDsl 不再支持旧的 agents + topology.downstream DSL", () => {
  assert.throws(
    () =>
      compileTeamDsl({
        agents: [{ id: "Build" }],
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
            id: "Build",
          },
        ],
        links: [],
      } as never),
    /nodes\[0\].*Invalid input/u,
  );
});

test("compileTeamDsl 会拒绝省略 agent.writable 的拓扑节点", () => {
  assert.throws(
    () =>
      compileTeamDsl({
        entry: "BA",
        nodes: [
          {
            type: "agent",
            id: "BA",
            prompt: BA_PROMPT,
          },
        ],
        links: [],
      }),
    /nodes\[0\].*Invalid input/u,
  );
});

test("compileTeamDsl 会拒绝 tuple 形式的 links，要求显式 from to trigger_type message_type", () => {
  assert.throws(
    () =>
      compileTeamDsl({
        entry: "Build",
        nodes: [
          {
            type: "agent",
            id: "Build",
            prompt: "",
            writable: true,
          },
          {
            type: "agent",
            id: "BA",
            prompt: BA_PROMPT,
            writable: false,
          },
        ],
        links: [
          ["Build", "BA", "transfer", "last"],
        ],
      }),
    /from.*to.*trigger_type.*message_type/u,
  );
});

test("compileTeamDsl 支持在拓扑文件里直接连接 __end__", () => {
  const definition: TeamDslDefinition = {
    entry: "线索发现",
    nodes: [
      agentNode("线索发现", "你负责线索发现。", false),
      spawnNode(
        "疑点辩论",
        {
          entry: "漏洞挑战",
          nodes: [
            agentNode("漏洞挑战", "你是漏洞挑战。", false),
            agentNode("讨论总结", "你是讨论总结。", false),
          ],
          links: [
            link("漏洞挑战", "讨论总结", "complete", "last"),
          ],
        },
      ),
    ],
    links: [
      link("线索发现", "疑点辩论", "continue", "all"),
      link("疑点辩论", "线索发现", "transfer", "none"),
      endLink("线索发现", "complete", "none"),
    ],
  };
  const compiled = compileTeamDsl(definition);

  assert.deepEqual(compiled.topology.langgraph?.end, {
    id: "__end__",
    sources: ["线索发现"],
    incoming: [
      { source: "线索发现", triggerOn: "complete" },
    ],
  });
  assert.equal(compiled.topology.edges.some((edge) => edge.target === "__end__"), false);
});

test("compileTeamDsl 会拒绝引用未声明节点的 graph.links", () => {
  assert.throws(
    () =>
      compileTeamDsl({
        entry: "Build",
        nodes: [agentNode("Build", "", true)],
        links: [
          link("Build", "TaskReview", "transfer", "last"),
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
            id: "CustomPlanner",
            prompt: "",
            writable: false,
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
      agentNode("BA", BA_PROMPT, false),
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

test("compileTeamDsl 支持定义漏洞挖掘团队的论证挑战多轮 spawn 辩论拓扑", () => {
  const definition: TeamDslDefinition = {
    entry: "线索发现",
    nodes: [
      agentNode("线索发现", "你负责持续阅读代码并找出新的可疑点。", false),
      spawnNode(
        "疑点辩论",
        {
          entry: "漏洞论证",
          nodes: [
            agentNode("漏洞论证", "你是漏洞论证。你的目标是证明当前可疑点是真漏洞，并在多轮对话中持续回应漏洞挑战质疑。", false),
            agentNode("漏洞挑战", "你是漏洞挑战。你的目标是反驳漏洞成立，并在多轮对话中持续回应漏洞论证论据。", false),
            agentNode("讨论总结", "你负责汇总论证与挑战双方多轮对弈后已经形成的结果，给出最终判断，并把结果反馈给线索发现。", false),
          ],
          links: [
            link("漏洞论证", "漏洞挑战", "continue", "last"),
            link("漏洞挑战", "漏洞论证", "continue", "last"),
            link("漏洞论证", "讨论总结", "complete", "last"),
            link("漏洞挑战", "讨论总结", "complete", "last"),
          ],
        },
      ),
    ],
    links: [
      link("线索发现", "疑点辩论", "continue", "last"),
      link("疑点辩论", "线索发现", "transfer", "last"),
      endLink("线索发现", "complete", "none"),
    ],
  };
  const compiled = compileTeamDsl(definition);

  assert.deepEqual(
    compiled.agents.map((agent) => agent.id),
    ["线索发现", "漏洞论证", "漏洞挑战", "讨论总结"],
  );
  assert.deepEqual(compiled.topology.edges, [
    { source: "线索发现", target: "疑点辩论", triggerOn: "continue", messageMode: "last" },
    { source: "疑点辩论", target: "线索发现", triggerOn: "transfer", messageMode: "last" },
  ]);
  assert.deepEqual(compiled.topology.spawnRules?.[0]?.spawnedAgents, [
    { role: "漏洞论证", templateName: "漏洞论证" },
    { role: "漏洞挑战", templateName: "漏洞挑战" },
    { role: "讨论总结", templateName: "讨论总结" },
  ]);
  assert.equal(compiled.topology.spawnRules?.[0]?.sourceTemplateName, "线索发现");
  assert.equal(compiled.topology.spawnRules?.[0]?.reportToTemplateName, "线索发现");
  assert.equal(compiled.topology.spawnRules?.[0]?.reportToTriggerOn, "transfer");
  assert.deepEqual(compiled.topology.langgraph?.end, {
    id: "__end__",
    sources: ["线索发现"],
    incoming: [
      { source: "线索发现", triggerOn: "complete" },
    ],
  });
  assert.deepEqual(compiled.topology.spawnRules?.[0]?.edges, [
    { sourceRole: "漏洞论证", targetRole: "漏洞挑战", triggerOn: "continue", messageMode: "last" },
    { sourceRole: "漏洞挑战", targetRole: "漏洞论证", triggerOn: "continue", messageMode: "last" },
    { sourceRole: "漏洞论证", targetRole: "讨论总结", triggerOn: "complete", messageMode: "last" },
    { sourceRole: "漏洞挑战", targetRole: "讨论总结", triggerOn: "complete", messageMode: "last" },
  ]);
});

test("compileTeamDsl 会拒绝在 spawn 子图里直接连接 __end__", () => {
  assert.throws(
    () =>
      compileTeamDsl({
        entry: "线索发现",
        nodes: [
          agentNode("线索发现", "你负责线索发现。", false),
          spawnNode(
            "疑点辩论",
            {
              entry: "漏洞挑战",
              nodes: [
                agentNode("漏洞挑战", "你是漏洞挑战。", false),
              ],
              links: [
                endLink("漏洞挑战", "complete", "none"),
              ],
            },
          ),
        ],
        links: [
          link("线索发现", "疑点辩论", "transfer", "all"),
        ],
      }),
    /只有根图可以直接连接 __end__/u,
  );
});

test("__end__ 边支持复用 complete / continue 作为条件分支", () => {
  const compiled = compileTeamDsl({
    entry: "线索发现",
    nodes: [
      agentNode("线索发现", "你负责线索发现。", false),
      agentNode("疑点辩论", "你负责辩论。", false),
    ],
    links: [
      link("线索发现", "疑点辩论", "continue", "all"),
      endLink("线索发现", "complete", "none"),
    ],
  });

  assert.deepEqual(compiled.topology.langgraph?.end, {
    id: "__end__",
    sources: ["线索发现"],
    incoming: [
      { source: "线索发现", triggerOn: "complete" },
    ],
  });
});

test("compileTeamDsl 会拒绝省略 __end__ 边的 trigger_type", () => {
  assert.throws(
    () =>
      compileTeamDsl({
        entry: "线索发现",
        nodes: [
          agentNode("线索发现", "你负责线索发现。", false),
        ],
        links: [
          {
            from: "线索发现",
            to: "__end__",
          },
        ],
      }),
    /trigger_type/u,
  );
});

test("compileTeamDsl 会拒绝省略 __end__ 边的 message_type", () => {
  assert.throws(
    () =>
      compileTeamDsl({
        entry: "线索发现",
        nodes: [
          agentNode("线索发现", "你负责线索发现。", false),
        ],
        links: [
          {
            from: "线索发现",
            to: "__end__",
            trigger_type: "complete",
          },
        ],
      }),
    /message_type/u,
  );
});

test("compileTeamDsl 支持在 links 上显式声明边级消息传递策略", () => {
  const compiled = compileTeamDsl({
    entry: "线索发现",
    nodes: [
      agentNode("线索发现", "你负责线索发现。", false),
      agentNode("疑点辩论", "你负责辩论。", false),
      agentNode("讨论总结", "你负责裁决。", false),
    ],
    links: [
      link("线索发现", "疑点辩论", "transfer", "all"),
      link("疑点辩论", "讨论总结", "transfer", "last"),
      link("讨论总结", "线索发现", "transfer", "none"),
    ],
  });

  assert.deepEqual(compiled.topology.edges, [
    { source: "线索发现", target: "疑点辩论", triggerOn: "transfer", messageMode: "all" },
    { source: "疑点辩论", target: "讨论总结", triggerOn: "transfer", messageMode: "last" },
    { source: "讨论总结", target: "线索发现", triggerOn: "transfer", messageMode: "none" },
  ]);
});

test("matchesAppliedTeamDsl 会把完全一致的当前团队配置识别为无需重复 apply", () => {
  const compiled = compileTeamDsl(createDevelopmentGraphDsl());

  assert.equal(
    matchesAppliedTeamDsl(
      [
        { id: "BA", prompt: BA_PROMPT, isWritable: false },
        { id: "Build", prompt: "", isWritable: true },
        { id: "CodeReview", prompt: CODE_REVIEW_PROMPT, isWritable: false },
        { id: "UnitTest", prompt: UNIT_TEST_PROMPT, isWritable: false },
        { id: "TaskReview", prompt: TASK_REVIEW_PROMPT, isWritable: false },
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
        { id: "BA", prompt: BA_PROMPT, isWritable: false },
        { id: "Build", prompt: "", isWritable: true },
        { id: "CodeReview", prompt: CODE_REVIEW_PROMPT, isWritable: false },
        { id: "UnitTest", prompt: UNIT_TEST_PROMPT, isWritable: false },
        { id: "TaskReview", prompt: TASK_REVIEW_PROMPT, isWritable: false },
      ],
      compiled,
    ),
    true,
  );
  assert.equal(
    matchesAppliedTeamDslTopology(
      {
        nodes: ["Build", "BA", "CodeReview", "UnitTest", "TaskReview"],
        edges: [{ source: "Build", target: "BA", triggerOn: "transfer", messageMode: "last" }],
      },
      compiled,
    ),
    false,
  );
});
