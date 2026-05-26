import { test } from "bun:test";
import assert from "node:assert/strict";

import {
  buildTopologyNodeRecords,
  collectTopologyTriggerShapes,
  createDefaultTopology,
  createTopologyFlowRecord,
  getGroupRules,
  getTriggerEdgeLoopLimit,
  isDecisionAgentInTopology,
  normalizeMaxTriggerRounds,
  normalizeTopologyEdgeTrigger,
  type TopologyRecord,
  usesOpenCodeBuiltinPrompt,
} from "./types";

function withAgentNodeRecords(
  topology: Omit<TopologyRecord, "nodeRecords" | "flow"> & Partial<Pick<TopologyRecord, "flow">>,
): TopologyRecord {
  const flowInput = topology.flow
    ? {
        startTargets: topology.flow.start.targets,
        endSources: topology.flow.end.sources,
        endIncoming: topology.flow.end.incoming,
      }
    : {};
  const flow = createTopologyFlowRecord({
    nodes: topology.nodes,
    edges: topology.edges,
    ...flowInput,
  });
  return {
    ...topology,
    flow,
    nodeRecords: buildTopologyNodeRecords({
      nodes: topology.nodes,
      groupNodeIds: new Set(),
      templateNameByNodeId: new Map(),
      initialMessageRoutingByNodeId: new Map(),
      groupRuleIdByNodeId: new Map(),
      groupEnabledNodeIds: new Set(),
      promptByNodeId: new Map(),
      writableNodeIds: new Set(),
    }),
  };
}

test("默认拓扑只生成首节点到次节点的 transfer 边", () => {
  const agents = ["BA", "Build", "TaskReview"];

  const topology = createDefaultTopology(agents);

  assert.deepEqual(topology.nodes, ["Build", "BA", "TaskReview"]);
  assert.equal(topology.edges.length, 1);
  assert.deepEqual(topology.edges[0], {
    source: "Build",
    target: "BA",
    trigger: "<default>",
    messageMode: "last", maxTriggerRounds: 4,
  });
  assert.deepEqual(topology.flow, {
    start: {
      id: "__start__",
      targets: ["Build"],
    },
    end: {
      id: "__end__",
      sources: [],
      incoming: [],
    },
  });
  assert.equal(
    topology.edges.some((edge) => edge.trigger === "complete" || edge.trigger === "continue"),
    false,
  );
});

test("默认拓扑在缺少 Build 时不会偷偷把首个 Agent 当起点", () => {
  const agents = ["BA", "TaskReview"];

  const topology = createDefaultTopology(agents);

  assert.deepEqual(topology.nodes, ["BA", "TaskReview"]);
  assert.deepEqual(topology.edges, []);
  assert.deepEqual(topology.flow, {
    start: {
      id: "__start__",
      targets: ["BA"],
    },
    end: {
      id: "__end__",
      sources: [],
      incoming: [],
    },
  });
});

test("存在 decision 出边时 isDecisionAgentInTopology 返回 true", () => {
  const topology: TopologyRecord = withAgentNodeRecords({
    nodes: ["Build", "TaskReview"],
    edges: [
      {
        source: "TaskReview",
        target: "Build",
        trigger: "<continue>",
        messageMode: "last", maxTriggerRounds: 4,
      },
    ],
  });

  assert.equal(isDecisionAgentInTopology(topology, "TaskReview"), true);
  assert.equal(isDecisionAgentInTopology(topology, "Build"), false);
});

test("回流边默认上限为 4，且支持按显式 trigger 单独覆盖", () => {
  const topology: TopologyRecord = withAgentNodeRecords({
    nodes: ["Build", "UnitTest", "TaskReview"],
    edges: [
      {
        source: "UnitTest",
        target: "Build",
        trigger: "<continue>",
        messageMode: "last",
        maxTriggerRounds: 4,
      },
      {
        source: "TaskReview",
        target: "Build",
        trigger: "<continue>",
        messageMode: "last",
        maxTriggerRounds: 7,
      },
    ],
  });

  assert.equal(getTriggerEdgeLoopLimit(topology, "UnitTest", "Build", "<continue>"), 4);
  assert.equal(getTriggerEdgeLoopLimit(topology, "TaskReview", "Build", "<continue>"), 7);
});

test("getTriggerEdgeLoopLimit 会按 trigger 精确命中同源同目标回流边", () => {
  const topology: TopologyRecord = withAgentNodeRecords({
    nodes: ["漏洞论证", "Build"],
    edges: [
      {
        source: "漏洞论证",
        target: "Build",
        trigger: "<first>",
        messageMode: "last",
        maxTriggerRounds: 2,
      },
      {
        source: "漏洞论证",
        target: "Build",
        trigger: "<second>",
        messageMode: "last",
        maxTriggerRounds: 5,
      },
    ],
  });

  assert.equal(getTriggerEdgeLoopLimit(topology, "漏洞论证", "Build", "<first>"), 2);
  assert.equal(getTriggerEdgeLoopLimit(topology, "漏洞论证", "Build", "<second>"), 5);
});

test("getTriggerEdgeLoopLimit 在 trigger 不匹配时必须直接报错", () => {
  const topology: TopologyRecord = withAgentNodeRecords({
    nodes: ["漏洞论证", "Build"],
    edges: [
      {
        source: "漏洞论证",
        target: "Build",
        trigger: "<first>",
        messageMode: "last",
        maxTriggerRounds: 2,
      },
    ],
  });

  assert.throws(
    () => getTriggerEdgeLoopLimit(topology, "漏洞论证", "Build", "<second>"),
    /未找到匹配 trigger 的边/u,
  );
});

test("自定义 label 的回流与通过不再按 trigger 名字推断，而是按边配置区分", () => {
  const topology: TopologyRecord = withAgentNodeRecords({
    nodes: ["Build", "Judge", "Summary"],
    edges: [
      {
        source: "Build",
        target: "Judge",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "Judge",
        target: "Build",
        trigger: "<revise>",
        messageMode: "last",
        maxTriggerRounds: 2,
      },
      {
        source: "Judge",
        target: "Summary",
        trigger: "<approved>",
        messageMode: "last", maxTriggerRounds: 4,
      },
    ],
  });

  assert.deepEqual(collectTopologyTriggerShapes({
    edges: topology.edges,
    endIncoming: topology.flow.end.incoming,
  }), [
    { source: "Judge", trigger: "<revise>" },
    { source: "Judge", trigger: "<approved>" },
  ]);
});

test("示例 label 作为普通 trigger 时不会获得特殊待遇，仍只按边配置区分", () => {
  const topology: TopologyRecord = withAgentNodeRecords({
    nodes: ["Judge", "Build", "Summary"],
    edges: [
      {
        source: "Judge",
        target: "Summary",
        trigger: "<continue>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "Judge",
        target: "Build",
        trigger: "<complete>",
        messageMode: "last",
        maxTriggerRounds: 3,
      },
    ],
  });

  assert.deepEqual(collectTopologyTriggerShapes({
    edges: topology.edges,
    endIncoming: topology.flow.end.incoming,
  }), [
    { source: "Judge", trigger: "<continue>" },
    { source: "Judge", trigger: "<complete>" },
  ]);
});

test("只有 Build 继续视为 OpenCode 内置 prompt", () => {
  assert.equal(usesOpenCodeBuiltinPrompt("Build"), true);
  assert.equal(usesOpenCodeBuiltinPrompt("build"), true);
  assert.equal(usesOpenCodeBuiltinPrompt("BA"), false);
  assert.equal(usesOpenCodeBuiltinPrompt("UnitTest"), false);
});

test("未知 trigger 必须直接报错，canonical trigger 保持新命名", () => {
  assert.throws(() => normalizeTopologyEdgeTrigger("unknown"), /非法拓扑 trigger/u);
  assert.throws(() => normalizeTopologyEdgeTrigger("transfer"), /非法拓扑 trigger/u);
  assert.throws(() => normalizeTopologyEdgeTrigger("complete"), /非法拓扑 trigger/u);
  assert.throws(() => normalizeTopologyEdgeTrigger("continue"), /非法拓扑 trigger/u);
  assert.equal(normalizeTopologyEdgeTrigger("<default>"), "<default>");
  assert.equal(normalizeTopologyEdgeTrigger("<complete>"), "<complete>");
  assert.equal(normalizeTopologyEdgeTrigger("<continue>"), "<continue>");
});

test("非法 maxTriggerRounds 必须直接报错，不能偷偷修正", () => {
  assert.throws(() => normalizeMaxTriggerRounds(0), /maxTriggerRounds 必须是 -1 或大于等于 1 的整数/u);
  assert.throws(() => normalizeMaxTriggerRounds(1.5), /maxTriggerRounds 必须是 -1 或大于等于 1 的整数/u);
  assert.throws(() => normalizeMaxTriggerRounds("4"), /maxTriggerRounds 必须是 -1 或大于等于 1 的整数/u);
  assert.equal(normalizeMaxTriggerRounds(-1), -1);
  assert.equal(normalizeMaxTriggerRounds(4), 4);
});

test("getGroupRules 保留显式声明的 messageMode，不再依赖默认补值", () => {
  const topology: TopologyRecord = {
    nodes: ["线索发现", "疑点辩论"],
    edges: [],
    flow: createTopologyFlowRecord({
      nodes: ["线索发现", "疑点辩论"],
      edges: [],
    }),
    nodeRecords: [
      {
        id: "线索发现",
        kind: "agent",
        templateName: "线索发现",
        initialMessageRouting: { mode: "inherit" },
      },
      {
        id: "疑点辩论",
        kind: "group",
        templateName: "疑点辩论",
        groupEnabled: true,
        groupRuleId: "group-rule:疑点辩论",
        initialMessageRouting: { mode: "inherit" },
      },
    ],
    groupRules: [
      {
        id: "疑点辩论",
        groupNodeName: "疑点辩论",
        sourceTemplateName: "线索发现",
        entryRole: "pro",
        members: [
          { role: "pro", templateName: "漏洞论证" },
          { role: "con", templateName: "误报论证" },
        ],
        edges: [
          {
            sourceRole: "pro",
            targetRole: "con",
            trigger: "<continue>",
            messageMode: "last", maxTriggerRounds: 4,
          },
        ],
        report: false,
      },
    ],
  };

  assert.deepEqual(getGroupRules(topology)[0]?.edges, [
    {
      sourceRole: "pro",
      targetRole: "con",
      trigger: "<continue>",
      messageMode: "last", maxTriggerRounds: 4,
    },
  ]);
});
