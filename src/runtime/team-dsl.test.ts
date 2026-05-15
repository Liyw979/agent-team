import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  buildTopologyNodeRecords,
  createTopologyFlowRecord,
  type GroupRule,
  type GroupRuleWithReport,
} from "@shared/types";

import { readBuiltinTopology } from "../../test-support/runtime/builtin-topology-test-helpers";
import {
  compileTeamDsl,
  matchesAppliedTeamDsl,
  matchesAppliedTeamDslAgents,
  matchesAppliedTeamDslTopology,
  type TeamDslDefinition,
} from "./team-dsl";

const BA_PROMPT = "你是 BA。";
const CODE_DECISION_PROMPT = "你是 CodeReview。必须输出 <continue> 或 <complete>。";
const UNIT_TEST_PROMPT = "你是 UnitTest。必须输出 <continue> 或 <complete>。";
const TASK_DECISION_PROMPT = "你是 TaskReview。必须输出 <continue> 或 <complete>。";

function expectReportRule(rule: GroupRule | undefined): GroupRuleWithReport {
  if (!rule || rule.report === false) {
    throw new Error("缺少 group report 配置");
  }
  return rule;
}

function promptWithTriggers(prompt: string, ...triggers: Array<`<${string}>`>): string {
  const normalizedTriggers = [...new Set(triggers)];
  if (normalizedTriggers.length === 0) {
    return prompt;
  }
  return `${prompt}\n允许输出 trigger：${normalizedTriggers.join("、")}`;
}

function agentNode(id: string, prompt: string, writable: boolean) {
  return {
    type: "agent" as const,
    id,
    system_prompt: prompt,
    writable,
  };
}

function groupNode(id: string, nodes: TeamDslDefinition["nodes"]) {
  return {
    type: "group" as const,
    id,
    nodes,
  };
}

function link(
  from: string,
  to: string,
  trigger: `<${string}>`,
  message_type: "none" | "last",
  maxTriggerRounds = 4,
) {
  return {
    from,
    to,
    trigger,
    message_type,
    maxTriggerRounds,
  };
}

function endLink(
  from: string,
  trigger: `<${string}>`,
  message_type: "none" | "last",
  maxTriggerRounds = 4,
) {
  return {
    from,
    to: "__end__" as const,
    trigger,
    message_type,
    maxTriggerRounds,
  };
}

function createDevelopmentGraphDsl() {
  return {
    entry: "BA",
    nodes: [
      agentNode("BA", BA_PROMPT, false),
      agentNode("Build", "", true),
      agentNode("CodeReview", CODE_DECISION_PROMPT, false),
      agentNode("UnitTest", UNIT_TEST_PROMPT, false),
      agentNode("TaskReview", TASK_DECISION_PROMPT, false),
    ],
    links: [
      link("BA", "Build", "<default>", "last"),
      link("Build", "CodeReview", "<default>", "last"),
      link("Build", "UnitTest", "<default>", "last"),
      link("Build", "TaskReview", "<default>", "last"),
      link("CodeReview", "Build", "<continue>", "last"),
      link("UnitTest", "Build", "<continue>", "last"),
      link("TaskReview", "Build", "<continue>", "last"),
    ],
  };
}

function createNestedGroupGraphDsl() {
  return {
    entry: "Source",
    nodes: [
      agentNode("Source", "你负责 source。", false),
      groupNode("Outer", [
        agentNode("OuterEntry", promptWithTriggers("你负责外层入口。", "<outer-next>", "<outer-report>"), false),
        groupNode("Inner", [
          agentNode("InnerEntry", promptWithTriggers("你负责中层入口。", "<inner-next>", "<inner-report>"), false),
          groupNode("Leaf", [
            agentNode("LeafWorker", promptWithTriggers("你负责叶子执行。", "<leaf-complete>"), false),
            agentNode("LeafSummary", promptWithTriggers("你负责叶子总结。", "<leaf-report>"), false),
          ]),
        ]),
      ]),
      agentNode("Sink", "你负责汇总。", false),
    ],
    links: [
      link("Source", "OuterEntry", "<default>", "last"),
      link("OuterEntry", "InnerEntry", "<outer-next>", "last"),
      link("InnerEntry", "LeafWorker", "<inner-next>", "last"),
      link("LeafWorker", "LeafSummary", "<leaf-complete>", "last"),
      link("LeafSummary", "InnerEntry", "<leaf-report>", "none"),
      link("InnerEntry", "OuterEntry", "<inner-report>", "none"),
      link("OuterEntry", "Sink", "<outer-report>", "none"),
    ],
  };
}

test("compileTeamDsl 支持把 group + 全局 links DSL 编译成 agents + topology", () => {
  const compiled = compileTeamDsl({
    entry: "BA",
    nodes: [
      agentNode("Build", "", true),
      agentNode("BA", BA_PROMPT, false),
      agentNode("SecurityResearcher", promptWithTriggers("你负责漏洞挖掘。", "<continue>"), false),
    ],
    links: [
      link("BA", "Build", "<default>", "last"),
      link("Build", "SecurityResearcher", "<default>", "last"),
      link("SecurityResearcher", "Build", "<continue>", "last"),
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
      { id: "BA", prompt: BA_PROMPT, templateName: "BA", isWritable: false },
      { id: "SecurityResearcher", prompt: promptWithTriggers("你负责漏洞挖掘。", "<continue>"), templateName: "SecurityResearcher", isWritable: false },
    ],
  );
  assert.deepEqual(compiled.topology.edges, [
    { source: "BA", target: "Build", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
    { source: "Build", target: "SecurityResearcher", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
    { source: "SecurityResearcher", target: "Build", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
  ]);
});

test("compileTeamDsl 输出的 Agent 记录使用 id 字段而不是 name 字段", () => {
  const compiled = compileTeamDsl({
    entry: "Build",
    nodes: [agentNode("Build", "", true)],
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
      link("BA", "Build", "<default>", "last"),
    ],
  });

  assert.deepEqual(
    compiled.agents.map((agent) => ({ id: agent.id, isWritable: agent.isWritable })),
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
        topology: { downstream: {} },
      } as never),
    /只支持递归式 entry \+ nodes \+ links DSL/u,
  );
});

test("compileTeamDsl 会拒绝非法的 node.type", () => {
  assert.throws(
    () =>
      compileTeamDsl({
        entry: "Build",
        nodes: [{ type: "weird", id: "Build" }],
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
        nodes: [{ type: "agent", id: "BA", system_prompt: BA_PROMPT }],
        links: [],
      }),
    /nodes\[0\].*Invalid input/u,
  );
});

test("compileTeamDsl 会拒绝 tuple 形式的 links，要求显式 from to trigger message_type", () => {
  assert.throws(
    () =>
      compileTeamDsl({
        entry: "Build",
        nodes: [
          agentNode("Build", "", true),
          agentNode("BA", BA_PROMPT, false),
        ],
        links: [
          ["Build", "BA", "<default>", "last"],
        ],
      }),
    /from、to、trigger、message_type/u,
  );
});

test("compileTeamDsl 会拒绝 group 节点的旧 graph 结构", () => {
  assert.throws(
    () =>
      compileTeamDsl({
        entry: "Source",
        nodes: [
          agentNode("Source", "你负责 source。", false),
          {
            type: "group",
            id: "Debate",
            graph: {
              entry: "Judge",
              nodes: [agentNode("Judge", "你负责 judge。", false)],
              links: [],
            },
          },
        ],
        links: [],
      } as never),
    /nodes\[1\].*Invalid input/u,
  );
});

test("compileTeamDsl 支持在拓扑文件里直接连接 __end__", () => {
  const compiled = compileTeamDsl({
    entry: "Source",
    nodes: [
      agentNode("Source", promptWithTriggers("你负责 source。", "<continue>", "<complete>"), false),
      groupNode("Debate", [
        agentNode("DecisionAgent", promptWithTriggers("你是 decisionAgent。", "<complete>"), false),
        agentNode("Summary", "你是 summary。", false),
      ]),
    ],
    links: [
      link("Source", "DecisionAgent", "<continue>", "last"),
      link("DecisionAgent", "Summary", "<complete>", "last"),
      link("Summary", "Source", "<default>", "none"),
      endLink("Source", "<complete>", "none"),
    ],
  });

  assert.deepEqual(compiled.topology.flow.end, {
    id: "__end__",
    sources: ["Source"],
    incoming: [
      { source: "Source", trigger: "<complete>" },
    ],
  });
  assert.equal(compiled.topology.edges.some((edge) => edge.target === "__end__"), false);
});

test("compileTeamDsl 会把 entry 位于 group 内部的根入口折叠成 group 节点", () => {
  const compiled = compileTeamDsl({
    entry: "DecisionAgent",
    nodes: [
      groupNode("Debate", [
        agentNode("DecisionAgent", "你是 decisionAgent。", false),
      ]),
    ],
    links: [],
  });

  assert.deepEqual(compiled.topology.flow, {
    start: { id: "__start__", targets: ["Debate"] },
    end: {
      id: "__end__",
      sources: [],
      incoming: [],
    },
  });
});

test("compileTeamDsl 支持从内置漏洞拓扑编译出 group 辩论拓扑", () => {
  const compiled = compileTeamDsl(readBuiltinTopology("vulnerability.yaml"));

  assert.deepEqual(
    compiled.agents.map((agent) => agent.id),
    ["线索发现", "误报论证", "漏洞论证", "讨论总结", "线索完备性评估"],
  );
  assert.deepEqual(compiled.topology.edges, [
    {
      source: "线索发现",
      target: "疑点辩论",
      trigger: "<continue>",
      messageMode: "last",
      maxTriggerRounds: 999,
    },
    {
      source: "疑点辩论",
      target: "线索发现",
      trigger: "<default>",
      messageMode: "none", maxTriggerRounds: 4,
    },
    {
      source: "线索发现",
      target: "线索完备性评估",
      trigger: "<complete>",
      messageMode: "last", maxTriggerRounds: 4,
    },
    {
      source: "线索完备性评估",
      target: "线索发现",
      trigger: "<continue>",
      messageMode: "last",
      maxTriggerRounds: 999,
    },
  ]);
  assert.deepEqual(compiled.topology.flow.end.incoming, [
    {
      source: "线索完备性评估",
      trigger: "<complete>",
    },
  ]);
  assert.deepEqual(compiled.topology.groupRules?.[0]?.members, [
    { role: "误报论证", templateName: "误报论证" },
    { role: "漏洞论证", templateName: "漏洞论证" },
    { role: "讨论总结", templateName: "讨论总结" },
  ]);
  const firstRule = expectReportRule(compiled.topology.groupRules?.[0]);
  assert.equal(firstRule.sourceTemplateName, "线索发现");
  assert.equal(firstRule.entryRole, "误报论证");
  assert.equal(firstRule.report.templateName, "线索发现");
  assert.equal(firstRule.report.trigger, "<default>");
  assert.equal(firstRule.report.messageMode, "none");
  assert.deepEqual(firstRule.edges, [
    { sourceRole: "漏洞论证", targetRole: "误报论证", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
    { sourceRole: "误报论证", targetRole: "漏洞论证", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
    { sourceRole: "漏洞论证", targetRole: "讨论总结", trigger: "<agree>", messageMode: "last", maxTriggerRounds: 4 },
    { sourceRole: "误报论证", targetRole: "讨论总结", trigger: "<agree>", messageMode: "last", maxTriggerRounds: 4 },
  ]);
});

test("compileTeamDsl 会拒绝 group 内 agent 直接连接 __end__", () => {
  assert.throws(
    () =>
      compileTeamDsl({
        entry: "Source",
        nodes: [
          agentNode("Source", promptWithTriggers("你负责 source。", "<default>"), false),
          groupNode("Debate", [
            agentNode("DecisionAgent", promptWithTriggers("你是 decisionAgent。", "<complete>"), false),
          ]),
        ],
        links: [
          link("Source", "DecisionAgent", "<default>", "last"),
          endLink("DecisionAgent", "<complete>", "none"),
        ],
      }),
    /group 内 agent 不能直接连接 __end__/u,
  );
});

test("compileTeamDsl 会保留 group 回到外层的 report maxTriggerRounds 配置", () => {
  const compiled = compileTeamDsl({
    entry: "线索发现",
    nodes: [
      agentNode("线索发现", "你负责线索发现。", false),
      groupNode("疑点辩论", [
        agentNode("讨论总结", promptWithTriggers("你负责讨论总结。", "<continue>"), true),
      ]),
    ],
    links: [
      link("线索发现", "讨论总结", "<default>", "last"),
      link("讨论总结", "线索发现", "<continue>", "none", 7),
    ],
  });

  const firstRule = expectReportRule(compiled.topology.groupRules?.[0]);
  assert.equal(firstRule.report.trigger, "<continue>");
  assert.equal(firstRule.report.messageMode, "none");
  assert.equal(firstRule.report.maxTriggerRounds, 7);
});

test("compileTeamDsl 支持在 agent 上声明 initialMessage 列表，并按定义顺序重排", () => {
  const compiled = compileTeamDsl({
    entry: "入口",
    nodes: [
      agentNode("入口", promptWithTriggers("你负责入口。", "<complete>"), false),
      agentNode("甲", promptWithTriggers("你负责甲。", "<complete>"), false),
      agentNode("乙", promptWithTriggers("你负责乙。", "<complete>"), false),
      {
        ...agentNode("总结", "你负责总结。", false),
        initialMessage: ["乙", "甲"],
      },
    ],
    links: [
      link("入口", "甲", "<complete>", "last"),
      link("甲", "乙", "<complete>", "last"),
      link("乙", "总结", "<complete>", "last"),
    ],
  });

  assert.deepEqual(
    compiled.topology.nodeRecords.find((node) => node.id === "总结"),
    {
      id: "总结",
      kind: "agent",
      templateName: "总结",
      prompt: "你负责总结。",
      initialMessageRouting: {
        mode: "list",
        agentIds: ["甲", "乙"],
      },
    },
  );
});

test("compileTeamDsl 支持 group 内 agent 引用外层 initialMessage 来源", () => {
  const compiled = compileTeamDsl(readBuiltinTopology("rfc-scanner.yaml"));

  assert.deepEqual(
    compiled.topology.nodeRecords.find((node) => node.id === "漏洞论证")?.initialMessageRouting,
    {
      mode: "list",
      agentIds: ["线索发现"],
    },
  );
});

test("compileTeamDsl 不会把 sibling group 内部 agent 视为全局可见", () => {
  assert.throws(
    () =>
      compileTeamDsl({
        entry: "线索发现",
        nodes: [
          agentNode("线索发现", promptWithTriggers("你负责线索发现。", "<continue>"), false),
          groupNode("主辩论", [
            {
              ...agentNode("漏洞论证", promptWithTriggers("你负责漏洞论证。", "<continue>"), false),
              initialMessage: ["旁路证据"],
            },
          ]),
          groupNode("旁路讨论", [
            agentNode("旁路证据", promptWithTriggers("你负责旁路证据。", "<continue>"), false),
          ]),
        ],
        links: [
          link("线索发现", "漏洞论证", "<continue>", "last"),
          link("线索发现", "旁路证据", "<continue>", "last"),
        ],
      }),
    /initialMessage 引用了不存在的来源 Agent：旁路证据/u,
  );
});

test("compileTeamDsl 会把 group 里混合父图与子图来源的 initialMessage 重排为全局定义顺序", () => {
  const compiled = compileTeamDsl({
    entry: "入口",
    nodes: [
      agentNode("入口", promptWithTriggers("你负责入口。", "<continue>"), false),
      groupNode("辩论", [
        agentNode("正方", promptWithTriggers("你负责正方。", "<continue>"), false),
        agentNode("反方", promptWithTriggers("你负责反方。", "<complete>"), false),
        {
          ...agentNode("总结", "你负责总结。", false),
          initialMessage: ["正方", "入口"],
        },
      ]),
    ],
    links: [
      link("入口", "正方", "<continue>", "last"),
      link("正方", "反方", "<continue>", "last"),
      link("反方", "总结", "<complete>", "last"),
      link("总结", "入口", "<default>", "none"),
    ],
  });

  assert.deepEqual(
    compiled.topology.nodeRecords.find((node) => node.id === "总结")?.initialMessageRouting,
    {
      mode: "list",
      agentIds: ["入口", "正方"],
    },
  );
});

test("compileTeamDsl 会为子 group 与孙 group 推导稳定的 entryRole、sourceTemplateName、report 与 edges", () => {
  const compiled = compileTeamDsl(createNestedGroupGraphDsl());
  const innerRule = compiled.topology.groupRules?.find((rule) => rule.id === "group-rule:Inner");
  const leafRule = compiled.topology.groupRules?.find((rule) => rule.id === "group-rule:Leaf");
  const innerReportRule = expectReportRule(innerRule);
  const leafReportRule = expectReportRule(leafRule);

  assert.deepEqual(innerRule?.members, [
    { role: "InnerEntry", templateName: "InnerEntry" },
    { role: "Leaf", templateName: "Leaf" },
  ]);
  assert.equal(innerRule?.entryRole, "InnerEntry");
  assert.equal(innerRule?.sourceTemplateName, "OuterEntry");
  assert.deepEqual(innerRule?.edges, [
    {
      sourceRole: "InnerEntry",
      targetRole: "Leaf",
      trigger: "<inner-next>",
      messageMode: "last", maxTriggerRounds: 4,
    },
    {
      sourceRole: "Leaf",
      targetRole: "InnerEntry",
      trigger: "<leaf-report>",
      messageMode: "none", maxTriggerRounds: 4,
    },
  ]);
  assert.deepEqual(innerReportRule.report, {
    templateName: "OuterEntry",
    sourceRole: "InnerEntry",
    trigger: "<inner-report>",
    messageMode: "none",
    maxTriggerRounds: 4,
  });

  assert.deepEqual(leafRule?.members, [
    { role: "LeafWorker", templateName: "LeafWorker" },
    { role: "LeafSummary", templateName: "LeafSummary" },
  ]);
  assert.equal(leafRule?.entryRole, "LeafWorker");
  assert.equal(leafRule?.sourceTemplateName, "InnerEntry");
  assert.deepEqual(leafRule?.edges, [
    {
      sourceRole: "LeafWorker",
      targetRole: "LeafSummary",
      trigger: "<leaf-complete>",
      messageMode: "last", maxTriggerRounds: 4,
    },
  ]);
  assert.deepEqual(leafReportRule.report, {
    templateName: "InnerEntry",
    sourceRole: "LeafSummary",
    trigger: "<leaf-report>",
    messageMode: "none",
    maxTriggerRounds: 4,
  });
});

test("compileTeamDsl 会拒绝在 link 上声明 initialMessage", () => {
  assert.throws(
    () =>
      compileTeamDsl({
        entry: "A",
        nodes: [
          agentNode("A", promptWithTriggers("你负责 A。", "<complete>"), false),
          agentNode("B", "你负责 B。", false),
        ],
        links: [
          {
            from: "A",
            to: "B",
            trigger: "<complete>",
            message_type: "last",
            maxTriggerRounds: 4,
initialMessage: ["A"],
          },
        ],
      }),
    /只允许显式写出 from、to、trigger、message_type、maxTriggerRounds/u,
  );
});

test("compileTeamDsl 会拒绝非法 maxTriggerRounds，而不是偷偷取整或补底", () => {
  assert.throws(
    () =>
      compileTeamDsl({
        entry: "线索发现",
        nodes: [
          agentNode("线索发现", promptWithTriggers("你负责线索发现。", "<continue>"), false),
          agentNode("疑点辩论", "你负责辩论。", false),
        ],
        links: [
          link("线索发现", "疑点辩论", "<continue>", "last", 0),
        ],
      }),
    /maxTriggerRounds 必须是 -1 或大于等于 1 的整数/u,
  );
});

test("compileTeamDsl 会规范化带空白的 <default> trigger，并保留 maxTriggerRounds", () => {
  const compiled = compileTeamDsl({
    entry: "Judge",
    nodes: [
      agentNode("Judge", "你负责普通流转。", false),
      agentNode("Build", "", true),
    ],
    links: [
      {
        from: "Judge",
        to: "Build",
        trigger: " <default> ",
        message_type: "last",
        maxTriggerRounds: 3,
      },
    ],
  });

  assert.deepEqual(compiled.topology.edges, [
    {
      source: "Judge",
      target: "Build",
      trigger: "<default>",
      messageMode: "last",
      maxTriggerRounds: 3,
    },
  ]);
});

test("compileTeamDsl 允许同一 source 把同一个 trigger 派发到多个下游", () => {
  const compiled = compileTeamDsl({
    entry: "Judge",
    nodes: [
      agentNode("Judge", promptWithTriggers("你负责判定。", "<same>"), false),
      agentNode("Build", "", true),
      agentNode("Summary", "你负责总结。", false),
    ],
    links: [
      link("Judge", "Build", "<same>", "last", 2),
      link("Judge", "Summary", "<same>", "last", 2),
    ],
  });

  assert.deepEqual(compiled.topology.edges, [
    {
      source: "Judge",
      target: "Build",
      trigger: "<same>",
      messageMode: "last",
      maxTriggerRounds: 2,
    },
    {
      source: "Judge",
      target: "Summary",
      trigger: "<same>",
      messageMode: "last",
      maxTriggerRounds: 2,
    },
  ]);
});

test("compileTeamDsl 会拒绝 source system_prompt 未显式声明自定义 outgoing trigger", () => {
  assert.throws(
    () =>
      compileTeamDsl({
        entry: "Judge",
        nodes: [
          agentNode("Judge", "你负责判定。", false),
          agentNode("Build", "", true),
        ],
        links: [
          link("Judge", "Build", "<revise>", "last"),
        ],
      }),
    /Judge 的 system_prompt 必须显式包含以下 trigger：<revise>/u,
  );
});

test("compileTeamDsl 会拒绝 group 回到外层时缺少对应 trigger 声明", () => {
  assert.throws(
    () =>
      compileTeamDsl({
        entry: "线索发现",
        nodes: [
          agentNode("线索发现", "你负责线索发现。", false),
          groupNode("疑点辩论", [
            agentNode("讨论总结", "你负责讨论总结。", true),
          ]),
        ],
        links: [
          link("线索发现", "讨论总结", "<default>", "last"),
          link("讨论总结", "线索发现", "<continue>", "none"),
        ],
      }),
    /讨论总结 的 system_prompt 必须显式包含以下 trigger：<continue>/u,
  );
});

test("matchesAppliedTeamDsl 会把完全一致的当前团队配置识别为无需重复 apply", () => {
  const compiled = compileTeamDsl(createDevelopmentGraphDsl());

  assert.equal(
    matchesAppliedTeamDsl(
      [
        { id: "BA", prompt: BA_PROMPT, isWritable: false },
        { id: "Build", prompt: "", isWritable: true },
        { id: "CodeReview", prompt: CODE_DECISION_PROMPT, isWritable: false },
        { id: "UnitTest", prompt: UNIT_TEST_PROMPT, isWritable: false },
        { id: "TaskReview", prompt: TASK_DECISION_PROMPT, isWritable: false },
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
        { id: "CodeReview", prompt: CODE_DECISION_PROMPT, isWritable: false },
        { id: "UnitTest", prompt: UNIT_TEST_PROMPT, isWritable: false },
        { id: "TaskReview", prompt: TASK_DECISION_PROMPT, isWritable: false },
      ],
      compiled,
    ),
    true,
  );
  assert.equal(
    matchesAppliedTeamDslTopology(
      {
        nodes: ["Build", "BA", "CodeReview", "UnitTest", "TaskReview"],
        edges: [{ source: "Build", target: "BA", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 }],
        flow: createTopologyFlowRecord({
          nodes: ["Build", "BA", "CodeReview", "UnitTest", "TaskReview"],
          edges: [{ source: "Build", target: "BA", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 }],
        }),
        nodeRecords: buildTopologyNodeRecords({
          nodes: ["Build", "BA", "CodeReview", "UnitTest", "TaskReview"],
          groupNodeIds: new Set(),
          templateNameByNodeId: new Map(),
          initialMessageRoutingByNodeId: new Map(),
          groupRuleIdByNodeId: new Map(),
          groupEnabledNodeIds: new Set(),
          promptByNodeId: new Map(),
          writableNodeIds: new Set(),
        }),
      },
      compiled,
    ),
    false,
  );
});
