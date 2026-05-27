import { test } from "bun:test";
import assert from "node:assert/strict";

import {
  createTopologyFlowRecord,
  type TopologyAgentNodeRecord,
  type TopologyRecord,
} from "@shared/types";

import {
  getDownstreamMode,
  setDownstreamMode,
  setGroupEnabledForDownstream,
} from "./topology-group-toggle";

function withFlow(
  topology: Omit<TopologyRecord, "flow"> & Partial<Pick<TopologyRecord, "flow">>,
): TopologyRecord {
  return {
    ...topology,
    flow: topology.flow ?? createTopologyFlowRecord({
      nodes: topology.nodes,
      edges: topology.edges,
    }),
  };
}

function agentNode(input: { id: string; templateName: string; prompt: string; writable: boolean }) {
  return {
    id: input.id,
    kind: "agent" as const,
    templateName: input.templateName,
    initialMessageRouting: { mode: "inherit" as const },
    prompt: input.prompt,
    writable: input.writable,
  };
}

function groupNode(input: { id: string; templateName: string; groupRuleId: string }) {
  return {
    id: input.id,
    kind: "group" as const,
    templateName: input.templateName,
    groupRuleId: input.groupRuleId,
    initialMessageRouting: { mode: "inherit" as const },
  };
}

function createAgentNodeMetadataById(nodes: TopologyAgentNodeRecord[]) {
  return new Map(
    nodes.map((node) => [
      node.id,
      {
        templateName: node.templateName,
        prompt: node.prompt,
        writable: node.writable,
      },
    ] as const),
  );
}

test("在下游配置中把某个下游勾选为 group 后，会自动把该下游及其后续可达 Agent 组成同一个动态团队", () => {
  const topology: TopologyRecord = withFlow({
    nodes: ["Build", "漏洞论证", "误报论证", "Summary"],
    nodeRecords: (() => {
      const nodes = [
        agentNode({ id: "Build", templateName: "Build", prompt: "", writable: false }),
        agentNode({ id: "漏洞论证", templateName: "漏洞论证", prompt: "你负责漏洞论证。", writable: false }),
        agentNode({ id: "误报论证", templateName: "误报论证", prompt: "你负责误报论证。", writable: false }),
        agentNode({ id: "Summary", templateName: "Summary", prompt: "你负责总结。", writable: false }),
      ];
      return nodes;
    })(),
    edges: [
      { source: "Build", target: "漏洞论证", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "漏洞论证", target: "误报论证", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "误报论证", target: "Summary", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
    ],
    groupRules: [],
  });

  const next = setGroupEnabledForDownstream({
    topology,
    sourceNodeId: "Build",
    targetNodeId: "漏洞论证",
    enabled: true,
    agentNodeMetadataById: createAgentNodeMetadataById(
      topology.nodeRecords.filter((node): node is Extract<typeof topology.nodeRecords[number], { kind: "agent" }> => node.kind === "agent"),
    ),
  });

  const groupNode = next.nodeRecords.find((node) => node.id === "漏洞论证");
  assert.equal(groupNode?.kind, "group");
  assert.equal(groupNode?.groupRuleId, "group-rule:漏洞论证");

  const groupRule = next.groupRules?.find((rule) => rule.id === "group-rule:漏洞论证");
  assert.notEqual(groupRule, undefined);
  assert.equal(groupRule?.sourceTemplateName, "Build");
  assert.deepEqual(
    groupRule?.members.map((agent) => agent.templateName),
    ["漏洞论证", "误报论证", "Summary"],
  );
});

test("启用 group 时，会清掉同一下游上的其它触发类型，保证四种模式完全互斥", () => {
  const topology: TopologyRecord = withFlow({
    nodes: ["Build", "漏洞论证", "误报论证", "Summary"],
    nodeRecords: [
      agentNode({ id: "Build", templateName: "Build", prompt: "", writable: false }),
      agentNode({ id: "漏洞论证", templateName: "漏洞论证", prompt: "你负责漏洞论证。", writable: false }),
      agentNode({ id: "误报论证", templateName: "误报论证", prompt: "你负责误报论证。", writable: false }),
      agentNode({ id: "Summary", templateName: "Summary", prompt: "你负责总结。", writable: false }),
    ],
    edges: [
      { source: "Build", target: "漏洞论证", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "Build", target: "漏洞论证", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "Build", target: "漏洞论证", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "漏洞论证", target: "误报论证", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "误报论证", target: "Summary", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
    ],
    groupRules: [],
  });

  const next = setGroupEnabledForDownstream({
    topology,
    sourceNodeId: "Build",
    targetNodeId: "漏洞论证",
    enabled: true,
    agentNodeMetadataById: createAgentNodeMetadataById(
      topology.nodeRecords.filter((node): node is Extract<typeof topology.nodeRecords[number], { kind: "agent" }> => node.kind === "agent"),
    ),
  });

  assert.deepEqual(
    next.edges
      .filter((edge) => edge.source === "Build" && edge.target === "漏洞论证")
      .map((edge) => edge.trigger)
      .sort(),
    ["<default>"],
  );
});

test("切换到传递时，会关闭 group、删除动态团队规则，并只保留传递一种模式", () => {
  const topology: TopologyRecord = withFlow({
    nodes: ["Build", "漏洞论证", "误报论证", "Summary"],
    nodeRecords: [
      agentNode({ id: "Build", templateName: "Build", prompt: "", writable: false }),
      groupNode({ id: "漏洞论证", templateName: "漏洞论证", groupRuleId: "group-rule:漏洞论证" }),
      agentNode({ id: "误报论证", templateName: "误报论证", prompt: "你负责误报论证。", writable: false }),
      agentNode({ id: "Summary", templateName: "Summary", prompt: "你负责总结。", writable: false }),
    ],
    edges: [
      { source: "Build", target: "漏洞论证", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "漏洞论证", target: "误报论证", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "误报论证", target: "Summary", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
    ],
    groupRules: [
      {
        id: "group-rule:漏洞论证",
        groupNodeName: "漏洞论证",
        sourceTemplateName: "Build",
        entryRole: "entry",
        members: [
          { role: "entry", templateName: "漏洞论证" },
          { role: "误报论证", templateName: "误报论证" },
          { role: "Summary", templateName: "Summary" },
        ],
        edges: [
          { sourceRole: "entry", targetRole: "误报论证", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
          { sourceRole: "误报论证", targetRole: "Summary", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
        ],
        report: {
          sourceRole: "summary",
          templateName: "Summary",
          trigger: "<default>",
          messageMode: "last",
          maxTriggerRounds: -1,
        },
      },
    ],
  });

  const next = setDownstreamMode({
    topology,
    sourceNodeId: "Build",
    targetNodeId: "漏洞论证",
    mode: "<default>",
    agentNodeMetadataById: createAgentNodeMetadataById([
      agentNode({ id: "Build", templateName: "Build", prompt: "", writable: false }),
      agentNode({ id: "漏洞论证", templateName: "漏洞论证", prompt: "你负责漏洞论证。", writable: true }),
      agentNode({ id: "误报论证", templateName: "误报论证", prompt: "你负责误报论证。", writable: false }),
      agentNode({ id: "Summary", templateName: "Summary", prompt: "你负责总结。", writable: false }),
    ]),
  });

  const targetNode = next.nodeRecords.find((node) => node.id === "漏洞论证");
  assert.equal(targetNode?.kind, "agent");
  assert.equal(targetNode && "groupRuleId" in targetNode, false);
  assert.deepEqual(
    targetNode,
    agentNode({ id: "漏洞论证", templateName: "漏洞论证", prompt: "你负责漏洞论证。", writable: true }),
  );
  assert.equal(next.groupRules?.length ?? 0, 0);
  assert.deepEqual(
    next.edges
      .filter((edge) => edge.source === "Build" && edge.target === "漏洞论证")
      .map((edge) => edge.trigger)
      .sort(),
    ["<default>"],
  );
});

test("切换到 <continue> 时，会关闭 group 并保留一条可调度的 trigger 入口边", () => {
  const topology: TopologyRecord = withFlow({
    nodes: ["Build", "漏洞论证", "误报论证"],
    nodeRecords: [
      agentNode({ id: "Build", templateName: "Build", prompt: "", writable: false }),
      groupNode({ id: "漏洞论证", templateName: "漏洞论证", groupRuleId: "group-rule:漏洞论证" }),
      agentNode({ id: "误报论证", templateName: "误报论证", prompt: "你负责误报论证。", writable: false }),
    ],
    edges: [],
    groupRules: [
      {
        id: "group-rule:漏洞论证",
        groupNodeName: "漏洞论证",
        sourceTemplateName: "Build",
        entryRole: "entry",
        members: [{ role: "entry", templateName: "漏洞论证" }],
        edges: [],
        report: {
          sourceRole: "summary",
          templateName: "Build",
          trigger: "<default>",
          messageMode: "last",
          maxTriggerRounds: -1,
        },
      },
    ],
  });

  const next = setDownstreamMode({
    topology,
    sourceNodeId: "Build",
    targetNodeId: "漏洞论证",
    mode: "<continue>",
    agentNodeMetadataById: createAgentNodeMetadataById([
      agentNode({ id: "Build", templateName: "Build", prompt: "", writable: false }),
      agentNode({ id: "漏洞论证", templateName: "漏洞论证", prompt: "你负责漏洞论证。", writable: false }),
      agentNode({ id: "误报论证", templateName: "误报论证", prompt: "你负责误报论证。", writable: false }),
    ]),
  });

  assert.equal(next.nodeRecords.find((node) => node.id === "漏洞论证")?.kind, "agent");
  assert.equal(next.groupRules?.length ?? 0, 0);
  assert.deepEqual(
    next.edges
      .filter((edge) => edge.source === "Build" && edge.target === "漏洞论证")
      .map((edge) => edge.trigger),
    ["<continue>"],
  );
});

test("当前下游模式会在 group、传递、<complete>、<continue> 四种触发里返回唯一结果", () => {
  const spawnTopology: TopologyRecord = withFlow({
    nodes: ["Build", "漏洞论证"],
    nodeRecords: [
      agentNode({ id: "Build", templateName: "Build", prompt: "", writable: false }),
      groupNode({ id: "漏洞论证", templateName: "漏洞论证", groupRuleId: "group-rule:漏洞论证" }),
    ],
    edges: [],
    groupRules: [],
  });
  assert.equal(
    getDownstreamMode({
      topology: spawnTopology,
      sourceNodeId: "Build",
      targetNodeId: "漏洞论证",
    }),
    "group",
  );

  const handoffTopology: TopologyRecord = withFlow({
    nodes: ["Build", "漏洞论证"],
    nodeRecords: [
      agentNode({ id: "Build", templateName: "Build", prompt: "", writable: false }),
      agentNode({ id: "漏洞论证", templateName: "漏洞论证", prompt: "你负责漏洞论证。", writable: false }),
    ],
    edges: [{ source: "Build", target: "漏洞论证", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 }],
    groupRules: [],
  });
  assert.equal(
    getDownstreamMode({
      topology: handoffTopology,
      sourceNodeId: "Build",
      targetNodeId: "漏洞论证",
    }),
    "<default>",
  );

  const passTopology: TopologyRecord = withFlow({
    nodes: ["Build", "漏洞论证"],
    nodeRecords: [
      agentNode({ id: "Build", templateName: "Build", prompt: "", writable: false }),
      agentNode({ id: "漏洞论证", templateName: "漏洞论证", prompt: "你负责漏洞论证。", writable: false }),
    ],
    edges: [{ source: "Build", target: "漏洞论证", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 }],
    groupRules: [],
  });
  assert.equal(
    getDownstreamMode({
      topology: passTopology,
      sourceNodeId: "Build",
      targetNodeId: "漏洞论证",
    }),
    "<complete>",
  );

  const failTopology: TopologyRecord = withFlow({
    nodes: ["Build", "漏洞论证"],
    nodeRecords: [
      agentNode({ id: "Build", templateName: "Build", prompt: "", writable: false }),
      agentNode({ id: "漏洞论证", templateName: "漏洞论证", prompt: "你负责漏洞论证。", writable: false }),
    ],
    edges: [{ source: "Build", target: "漏洞论证", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 }],
    groupRules: [],
  });
  assert.equal(
    getDownstreamMode({
      topology: failTopology,
      sourceNodeId: "Build",
      targetNodeId: "漏洞论证",
    }),
    "<continue>",
  );
});
