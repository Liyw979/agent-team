import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  createTopologyFlowRecord,
  getGroupRules,
  type GroupRule,
  type GroupRuleWithReport,
  type TopologyRecord,
} from "@shared/types";

import { compileTeamDsl, type TeamDslDefinition } from "./team-dsl";
import { instantiateGroupBundle, instantiateGroupBundles, validateGroupRule } from "./runtime-topology";

function expectReportRule(rule: GroupRule | undefined): GroupRuleWithReport {
  if (!rule || rule.report === false) {
    throw new Error("缺少 group report 配置");
  }
  return rule;
}

function createVulnTopology(): TopologyRecord {
  return {
    nodes: ["线索发现", "漏洞论证模板", "误报论证模板", "Summary模板"],
    nodeRecords: [
      { id: "线索发现", kind: "agent", templateName: "线索发现", initialMessageRouting: { mode: "inherit" } },
      { id: "漏洞论证模板", kind: "agent", templateName: "漏洞论证模板", initialMessageRouting: { mode: "inherit" } },
      { id: "误报论证模板", kind: "agent", templateName: "误报论证模板", initialMessageRouting: { mode: "inherit" } },
      { id: "Summary模板", kind: "agent", templateName: "Summary模板", initialMessageRouting: { mode: "inherit" } },
      { id: "疑点辩论工厂", kind: "group", templateName: "漏洞论证模板", groupRuleId: "finding-debate", initialMessageRouting: { mode: "inherit" } },
    ],
    edges: [
      { source: "线索发现", target: "疑点辩论工厂", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "疑点辩论工厂", target: "线索发现", trigger: "<default>", messageMode: "none", maxTriggerRounds: 4 },
    ],
    flow: createTopologyFlowRecord({
      nodes: ["线索发现", "漏洞论证模板", "误报论证模板", "Summary模板"],
      edges: [
        { source: "线索发现", target: "疑点辩论工厂", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "疑点辩论工厂", target: "线索发现", trigger: "<default>", messageMode: "none", maxTriggerRounds: 4 },
      ],
      endSources: ["疑点辩论工厂"],
      endIncoming: [{ source: "疑点辩论工厂", trigger: "<default>" }],
    }),
    groupRules: [
      {
        id: "finding-debate",
        groupNodeName: "疑点辩论工厂",
        sourceTemplateName: "线索发现",
        entryRole: "pro",
        members: [
          { role: "pro", templateName: "漏洞论证模板" },
          { role: "con", templateName: "误报论证模板" },
          { role: "summary", templateName: "Summary模板" },
        ],
        edges: [
          { sourceRole: "pro", targetRole: "con", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
          { sourceRole: "con", targetRole: "pro", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
          { sourceRole: "pro", targetRole: "summary", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
          { sourceRole: "con", targetRole: "summary", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
        ],
        report: {
          sourceRole: "summary",
          templateName: "线索发现",
          trigger: "<default>",
          messageMode: "last",
          maxTriggerRounds: -1,
        },
      },
    ],
  };
}

function agentNode(id: string, prompt: string) {
  return {
    type: "agent" as const,
    id,
    system_prompt: prompt,
    writable: false,
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
  return { from, to, trigger, message_type, maxTriggerRounds };
}

function createNestedGroupTopology(): TopologyRecord {
  return compileTeamDsl({
    entry: "Source",
    nodes: [
      agentNode("Source", "你负责 source。"),
      groupNode("Outer", [
        agentNode("OuterEntry", "你负责外层入口。允许输出 trigger：<outer-next>、<outer-report>"),
        groupNode("Inner", [
          agentNode("InnerEntry", "你负责中层入口。允许输出 trigger：<inner-next>、<inner-report>"),
          groupNode("Leaf", [
            agentNode("LeafWorker", "你负责叶子执行。允许输出 trigger：<leaf-complete>"),
            agentNode("LeafSummary", "你负责叶子总结。允许输出 trigger：<leaf-report>"),
          ]),
        ]),
      ]),
      agentNode("Sink", "你负责汇总。"),
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
  }).topology;
}

test("validateGroupRule 可以验证漏洞辩论规则引用的模板和角色都存在", () => {
  const topology = createVulnTopology();
  const rule = getGroupRules(topology)[0];
  assert.notEqual(rule, undefined);
  validateGroupRule(topology, rule!);
});

test("validateGroupRule 会拒绝不存在的 report source role", () => {
  const topology = createVulnTopology();
  const rule = getGroupRules(topology)[0];
  assert.notEqual(rule, undefined);
  if (!rule || rule.report === false) {
    assert.fail("缺少可校验的 report rule");
  }

  assert.throws(
    () =>
      validateGroupRule(topology, {
        ...rule,
        report: {
          ...rule.report,
          sourceRole: "missing-role",
        },
      }),
    /group rule report source role 不存在：missing-role/u,
  );
});

test("instantiateGroupBundle 会为一个 finding 生成论证、挑战、summary 三个运行时实例和正确连线", () => {
  const topology = createVulnTopology();

  const bundle = instantiateGroupBundle({
    topology,
    groupRuleId: "finding-debate",
    activationId: "activation-1",
    item: {
      id: "finding-001",
      title: "上传文件名拼接路径",
    },
  });

  assert.equal(bundle.groupId, "finding-debate:finding-001");
  assert.equal("sourceTemplateName" in bundle, false);
  assert.equal("reportToTemplateName" in bundle, false);
  assert.equal(bundle.nodes.some((node) => "groupRuleId" in node), false);
  assert.deepEqual(
    bundle.nodes.map((node) => ({
      id: node.id,
      templateName: node.templateName,
      role: node.role,
      displayName: node.displayName,
      groupId: node.groupId,
    })),
    [
      {
        id: "漏洞论证模板-1",
        templateName: "漏洞论证模板",
        role: "pro",
        displayName: "漏洞论证模板-1",
        groupId: "finding-debate:finding-001",
      },
      {
        id: "误报论证模板-1",
        templateName: "误报论证模板",
        role: "con",
        displayName: "误报论证模板-1",
        groupId: "finding-debate:finding-001",
      },
      {
        id: "Summary模板-1",
        templateName: "Summary模板",
        role: "summary",
        displayName: "Summary模板-1",
        groupId: "finding-debate:finding-001",
      },
    ],
  );
  assert.deepEqual(bundle.edges, [
    {
      messageMode: "last", maxTriggerRounds: 4,
      source: "线索发现",
      target: "漏洞论证模板-1",
      trigger: "<default>",
    },
    {
      messageMode: "last", maxTriggerRounds: 4,
      source: "漏洞论证模板-1",
      target: "误报论证模板-1",
      trigger: "<continue>",
    },
    {
      messageMode: "last", maxTriggerRounds: 4,
      source: "误报论证模板-1",
      target: "漏洞论证模板-1",
      trigger: "<continue>",
    },
    {
      messageMode: "last", maxTriggerRounds: 4,
      source: "漏洞论证模板-1",
      target: "Summary模板-1",
      trigger: "<complete>",
    },
    {
      messageMode: "last", maxTriggerRounds: 4,
      source: "误报论证模板-1",
      target: "Summary模板-1",
      trigger: "<complete>",
    },
    {
      messageMode: "none", maxTriggerRounds: 4,
      source: "Summary模板-1",
      target: "线索发现",
      trigger: "<default>",
    },
  ]);
});

test("instantiateGroupBundle 会继承 source -> group 的 messageMode 到 entry 运行时实例边", () => {
  const topology = createVulnTopology();

  const bundle = instantiateGroupBundle({
    topology,
    groupRuleId: "finding-debate",
    activationId: "activation-1",
    item: {
      id: "finding-001",
      title: "上传文件名拼接路径",
    },
  });

  assert.deepEqual(bundle.edges[0], {
    source: "线索发现",
    target: "漏洞论证模板-1",
    trigger: "<default>",
    messageMode: "last", maxTriggerRounds: 4,
  });
});

test("instantiateGroupBundle 在未声明 group -> report 静态边时，会回退使用 groupRule.reportToMessageMode", () => {
  const topology = createVulnTopology();
  topology.edges = topology.edges.filter((edge) => !(edge.source === "疑点辩论工厂" && edge.target === "线索发现"));
  const firstRule = expectReportRule(topology.groupRules?.[0]);
  topology.groupRules![0] = {
    ...firstRule,
    report: {
      ...firstRule.report,
      messageMode: "none", maxTriggerRounds: 4,
    },
  };

  const bundle = instantiateGroupBundle({
    topology,
    groupRuleId: "finding-debate",
    activationId: "activation-1",
    item: {
      id: "finding-001",
      title: "上传文件名拼接路径",
    },
  });

  assert.deepEqual(bundle.edges.at(-1), {
    messageMode: "none", maxTriggerRounds: 4,
    source: "Summary模板-1",
    target: "线索发现",
    trigger: "<default>",
  });
});

test("instantiateGroupBundle 在未声明 group -> report 静态边时，会回退使用 groupRule.reportToMaxTriggerRounds", () => {
  const topology = createVulnTopology();
  topology.edges = topology.edges.filter((edge) => !(edge.source === "疑点辩论工厂" && edge.target === "线索发现"));
  const firstRule = expectReportRule(topology.groupRules?.[0]);
  topology.groupRules![0] = {
    ...firstRule,
    report: {
      ...firstRule.report,
      trigger: "<continue>",
      messageMode: "none",
      maxTriggerRounds: 7,
    },
  };

  const bundle = instantiateGroupBundle({
    topology,
    groupRuleId: "finding-debate",
    activationId: "activation-1",
    item: {
      id: "finding-001",
      title: "上传文件名拼接路径",
    },
  });

  assert.deepEqual(bundle.edges.at(-1), {
    messageMode: "none",
    source: "Summary模板-1",
    target: "线索发现",
    trigger: "<continue>",
    maxTriggerRounds: 7,
  });
});

test("instantiateGroupBundle 会继承 group -> report target 的 messageMode 到回流运行时实例边", () => {
  const topology = createVulnTopology();

  const bundle = instantiateGroupBundle({
    topology,
    groupRuleId: "finding-debate",
    activationId: "activation-1",
    item: {
      id: "finding-001",
      title: "上传文件名拼接路径",
    },
  });

  assert.deepEqual(bundle.edges.at(-1), {
    source: "Summary模板-1",
    target: "线索发现",
    trigger: "<default>",
    messageMode: "none", maxTriggerRounds: 4,
  });
});

test("instantiateGroupBundle 识别 source 节点时不会误把 group 节点当成 sourceTemplateName", () => {
  const topology = createVulnTopology();

  const bundle = instantiateGroupBundle({
    topology: {
      ...topology,
      nodeRecords: [
        { id: "疑点辩论工厂", kind: "group", templateName: "漏洞论证模板", groupRuleId: "finding-debate", initialMessageRouting: { mode: "inherit" } },
        ...topology.nodeRecords.filter((node) => node.id !== "疑点辩论工厂"),
      ],
    },
    groupRuleId: "finding-debate",
    activationId: "activation-1",
    item: {
      id: "finding-001",
      title: "上传文件名拼接路径",
    },
  });

  assert.deepEqual(bundle.edges[0], {
    source: "线索发现",
    target: "漏洞论证模板-1",
    trigger: "<default>",
    messageMode: "last", maxTriggerRounds: 4,
  });
});

test("同一 group rule 的多个实例会按顺序生成简短显示名，而不是暴露复杂内部 id", () => {
  const topology = createVulnTopology();

  const bundles = instantiateGroupBundles({
    topology,
    groupRuleId: "finding-debate",
    activationId: "activation-1",
    items: [
      { id: "finding-001", title: "路径穿越" },
      { id: "finding-002", title: "鉴权缺失" },
    ],
  });

  assert.deepEqual(
    bundles.flatMap((bundle) => bundle.nodes.map((node) => node.displayName)),
    ["漏洞论证模板-1", "误报论证模板-1", "Summary模板-1", "漏洞论证模板-2", "误报论证模板-2", "Summary模板-2"],
  );
});

test("instantiateGroupBundles 会为多个 finding 批量生成互不冲突的实例组", () => {
  const topology = createVulnTopology();

  const bundles = instantiateGroupBundles({
    topology,
    groupRuleId: "finding-debate",
    activationId: "activation-1",
    items: [
      { id: "finding-001", title: "路径穿越" },
      { id: "finding-002", title: "鉴权缺失" },
    ],
  });

  assert.equal(bundles.length, 2);
  assert.equal(bundles[0]?.nodes[0]?.id, "漏洞论证模板-1");
  assert.equal(bundles[1]?.nodes[0]?.id, "漏洞论证模板-2");
  assert.notEqual(bundles[0]?.groupId, bundles[1]?.groupId);
});

test("同一 group rule 的多次单条 activation 会生成递增的 runtime agent id", () => {
  const topology = createVulnTopology();

  const first = instantiateGroupBundles({
    topology,
    groupRuleId: "finding-debate",
    activationId: "activation-1",
    items: [{ id: "finding-001", title: "路径穿越" }],
  });
  const second = instantiateGroupBundles({
    topology,
    groupRuleId: "finding-debate",
    activationId: "activation-2",
    items: [{ id: "finding-002", title: "鉴权缺失" }],
  });
  const third = instantiateGroupBundles({
    topology,
    groupRuleId: "finding-debate",
    activationId: "activation-3",
    items: [{ id: "finding-003", title: "调试接口泄露" }],
  });

  assert.deepEqual(first[0]?.nodes.map((node) => node.id), [
    "漏洞论证模板-1",
    "误报论证模板-1",
    "Summary模板-1",
  ]);
  assert.deepEqual(second[0]?.nodes.map((node) => node.id), [
    "漏洞论证模板-2",
    "误报论证模板-2",
    "Summary模板-2",
  ]);
  assert.deepEqual(third[0]?.nodes.map((node) => node.id), [
    "漏洞论证模板-3",
    "误报论证模板-3",
    "Summary模板-3",
  ]);
});

test("compileTeamDsl 产物可直接通过 validateGroupRule 与 instantiateGroupBundle 的嵌套 group 端到端校验", () => {
  const topology = createNestedGroupTopology();
  for (const rule of getGroupRules(topology)) {
    validateGroupRule(topology, rule);
  }

  const outerBundle = instantiateGroupBundle({
    topology,
    groupRuleId: "group-rule:Outer",
    activationId: "activation-outer",
    item: { id: "case-001", title: "外层条目" },
  });
  const innerGroupNode = outerBundle.nodes.find((node) => node.kind === "group" && node.templateName === "Inner");
  assert.deepEqual(innerGroupNode, {
    id: "Inner-1",
    kind: "group",
    templateName: "Inner",
    displayName: "Inner-1",
    sourceNodeId: "Source",
    groupId: "group-rule:Outer:case-001",
    role: "Inner",
    groupRuleId: "group-rule:Inner",
  });
  assert.deepEqual(outerBundle.edges, [
    {
      source: "Source",
      target: "OuterEntry-1",
      trigger: "<default>",
      messageMode: "last", maxTriggerRounds: 4,
    },
    {
      source: "OuterEntry-1",
      target: "Inner-1",
      trigger: "<outer-next>",
      messageMode: "last", maxTriggerRounds: 4,
    },
    {
      source: "Inner-1",
      target: "OuterEntry-1",
      trigger: "<inner-report>",
      messageMode: "none", maxTriggerRounds: 4,
    },
    {
      source: "OuterEntry-1",
      target: "Sink",
      trigger: "<outer-report>",
      messageMode: "none", maxTriggerRounds: 4,
    },
  ]);

  const innerBundle = instantiateGroupBundle({
    topology,
    groupRuleId: "group-rule:Inner",
    activationId: "activation-inner",
    item: { id: "case-002", title: "中层条目" },
  });
  const leafGroupNode = innerBundle.nodes.find((node) => node.kind === "group" && node.templateName === "Leaf");
  assert.deepEqual(leafGroupNode, {
    id: "Leaf-2",
    kind: "group",
    templateName: "Leaf",
    displayName: "Leaf-2",
    sourceNodeId: "OuterEntry",
    groupId: "group-rule:Inner:case-002",
    role: "Leaf",
    groupRuleId: "group-rule:Leaf",
  });
  assert.deepEqual(innerBundle.edges, [
    {
      source: "InnerEntry-2",
      target: "Leaf-2",
      trigger: "<inner-next>",
      messageMode: "last", maxTriggerRounds: 4,
    },
    {
      source: "Leaf-2",
      target: "InnerEntry-2",
      trigger: "<leaf-report>",
      messageMode: "none", maxTriggerRounds: 4,
    },
    {
      source: "InnerEntry-2",
      target: "OuterEntry",
      trigger: "<inner-report>",
      messageMode: "none", maxTriggerRounds: 4,
    },
  ]);

  const leafBundle = instantiateGroupBundle({
    topology,
    groupRuleId: "group-rule:Leaf",
    activationId: "activation-leaf",
    item: { id: "case-003", title: "叶子条目" },
  });
  assert.deepEqual(leafBundle.edges, [
    {
      source: "LeafWorker-3",
      target: "LeafSummary-3",
      trigger: "<leaf-complete>",
      messageMode: "last", maxTriggerRounds: 4,
    },
    {
      source: "LeafSummary-3",
      target: "InnerEntry",
      trigger: "<leaf-report>",
      messageMode: "none", maxTriggerRounds: 4,
    },
  ]);
});
