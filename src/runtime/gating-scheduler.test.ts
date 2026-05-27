import { test } from "bun:test";
import assert from "node:assert/strict";

import {
  buildTopologyNodeRecords,
  createTopologyFlowRecord,
  type TopologyRecord,
} from "@shared/types";

import {
  GatingScheduler,
  createGatingSchedulerRuntimeState,
} from "./gating-scheduler";

function withNodeRecords(
  topology: Omit<TopologyRecord, "flow" | "nodeRecords"> &
    Partial<Pick<TopologyRecord, "flow" | "nodeRecords">>,
): TopologyRecord {
  const flowInput = topology.flow
    ? {
        startTargets: topology.flow.start.targets,
        endSources: topology.flow.end.sources,
        endIncoming: topology.flow.end.incoming,
      }
    : {};
  return {
    ...topology,
    flow: createTopologyFlowRecord({
      nodes: topology.nodes,
      edges: topology.edges,
      ...flowInput,
    }),
    nodeRecords: topology.nodeRecords ?? buildTopologyNodeRecords({
      nodes: topology.nodes,
      groupNodeIds: new Set(),
      templateNameByNodeId: new Map(),
      initialMessageRoutingByNodeId: new Map(),
      groupRuleIdByNodeId: new Map(),
      promptByNodeId: new Map(),
      writableNodeIds: new Set(),
    }),
  };
}

function runtimeAgentNode(id: string, templateName: string) {
  return {
    id,
    kind: "agent" as const,
    templateName,
    initialMessageRouting: { mode: "inherit" as const },
    prompt: "",
    writable: false,
  };
}

test("handoff 首轮会放行 default 下游", () => {
  const scheduler = new GatingScheduler(withNodeRecords({
    nodes: ["Build", "UnitTest", "TaskReview"],
    edges: [
      { source: "Build", target: "UnitTest", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "Build", target: "TaskReview", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
    ],
  }), createGatingSchedulerRuntimeState());

  const plan = scheduler.planHandoffDispatch("Build", "Build 已完成", [
    { id: "Build", status: "completed" },
    { id: "UnitTest", status: "idle" },
    { id: "TaskReview", status: "idle" },
  ]);

  assert.deepEqual(plan, {
    sourceAgentId: "Build",
    sourceContent: "Build 已完成",
    triggerTargets: ["UnitTest", "TaskReview"],
    readyTargets: ["UnitTest", "TaskReview"],
    queuedTargets: [],
  });
});

test("triggered 派发会按 trigger 过滤目标", () => {
  const scheduler = new GatingScheduler(withNodeRecords({
    nodes: ["Judge", "Build", "Doc", "Summary"],
    edges: [
      { source: "Judge", target: "Build", trigger: "<revise>", messageMode: "last", maxTriggerRounds: 2 },
      { source: "Judge", target: "Doc", trigger: "<revise>", messageMode: "last", maxTriggerRounds: 2 },
      { source: "Judge", target: "Summary", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
    ],
  }), createGatingSchedulerRuntimeState());

  const plan = scheduler.planTriggeredDispatch("Judge", "请继续修订", [
    { id: "Judge", status: "completed" },
    { id: "Build", status: "idle" },
    { id: "Doc", status: "idle" },
    { id: "Summary", status: "idle" },
  ], {
    trigger: "<revise>",
  });

  assert.deepEqual(plan, {
    sourceAgentId: "Judge",
    sourceContent: "请继续修订",
    triggerTargets: ["Build", "Doc"],
    readyTargets: ["Build", "Doc"],
    queuedTargets: [],
  });
});

test("triggered 派发不会被同一目标未满足的 default 入边阻塞", () => {
  const scheduler = new GatingScheduler(withNodeRecords({
    nodes: ["发现", "总结", "评估"],
    edges: [
      { source: "总结", target: "发现", trigger: "<default>", messageMode: "none", maxTriggerRounds: 4 },
      { source: "发现", target: "评估", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "评估", target: "发现", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 999 },
    ],
  }), createGatingSchedulerRuntimeState());

  const plan = scheduler.planTriggeredDispatch("评估", "必须继续挖掘", [
    { id: "发现", status: "completed" },
    { id: "总结", status: "idle" },
    { id: "评估", status: "completed" },
  ], {
    trigger: "<continue>",
  });

  assert.deepEqual(plan, {
    sourceAgentId: "评估",
    sourceContent: "必须继续挖掘",
    triggerTargets: ["发现"],
    readyTargets: ["发现"],
    queuedTargets: [],
  });
});

test("同一 trigger 多入边 triggered 任一来源满足后即可派发", () => {
  const scheduler = new GatingScheduler(withNodeRecords({
    nodes: ["漏洞论证-1", "误报论证-1", "讨论总结-1"],
    nodeRecords: [
      runtimeAgentNode("漏洞论证-1", "漏洞论证"),
      runtimeAgentNode("误报论证-1", "误报论证"),
      runtimeAgentNode("讨论总结-1", "讨论总结"),
    ],
    edges: [
      { source: "漏洞论证-1", target: "讨论总结-1", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "误报论证-1", target: "讨论总结-1", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
    ],
    groupRules: [
      {
        id: "group-rule:疑点辩论",
        groupNodeName: "疑点辩论",
        entryRole: "误报论证",
        members: [
          { role: "误报论证", templateName: "误报论证" },
          { role: "漏洞论证", templateName: "漏洞论证" },
          { role: "讨论总结", templateName: "讨论总结" },
        ],
        edges: [
          { sourceRole: "漏洞论证", targetRole: "讨论总结", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
          { sourceRole: "误报论证", targetRole: "讨论总结", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
        ],
        report: false,
      },
    ],
  }), createGatingSchedulerRuntimeState());

  const plan = scheduler.planTriggeredDispatch("漏洞论证-1", "进入总结", [
    { id: "漏洞论证-1", status: "completed" },
    { id: "误报论证-1", status: "idle" },
    { id: "讨论总结-1", status: "idle" },
  ], {
    trigger: "<complete>",
  });
  assert.deepEqual(plan, {
    sourceAgentId: "漏洞论证-1",
    sourceContent: "进入总结",
    triggerTargets: ["讨论总结-1"],
    readyTargets: ["讨论总结-1"],
    queuedTargets: [],
  });
});

test("同一 trigger 多入边 triggered 的另一来源同样可以直接派发", () => {
  const scheduler = new GatingScheduler(withNodeRecords({
    nodes: ["漏洞论证-1", "误报论证-1", "讨论总结-1"],
    nodeRecords: [
      runtimeAgentNode("漏洞论证-1", "漏洞论证"),
      runtimeAgentNode("误报论证-1", "误报论证"),
      runtimeAgentNode("讨论总结-1", "讨论总结"),
    ],
    edges: [
      { source: "漏洞论证-1", target: "讨论总结-1", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "误报论证-1", target: "讨论总结-1", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
    ],
    groupRules: [
      {
        id: "group-rule:疑点辩论",
        groupNodeName: "疑点辩论",
        entryRole: "误报论证",
        members: [
          { role: "误报论证", templateName: "误报论证" },
          { role: "漏洞论证", templateName: "漏洞论证" },
          { role: "讨论总结", templateName: "讨论总结" },
        ],
        edges: [
          { sourceRole: "漏洞论证", targetRole: "讨论总结", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
          { sourceRole: "误报论证", targetRole: "讨论总结", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
        ],
        report: false,
      },
    ],
  }), createGatingSchedulerRuntimeState());

  const plan = scheduler.planTriggeredDispatch("误报论证-1", "进入总结", [
    { id: "漏洞论证-1", status: "idle" },
    { id: "误报论证-1", status: "completed" },
    { id: "讨论总结-1", status: "idle" },
  ], {
    trigger: "<complete>",
  });
  assert.deepEqual(plan, {
    sourceAgentId: "误报论证-1",
    sourceContent: "进入总结",
    triggerTargets: ["讨论总结-1"],
    readyTargets: ["讨论总结-1"],
    queuedTargets: [],
  });
});

test("default handoff 不会被未满足的自定义 trigger 入边阻塞", () => {
  const scheduler = new GatingScheduler(withNodeRecords({
    nodes: ["BA", "Build", "Judge"],
    edges: [
      { source: "BA", target: "Build", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "Judge", target: "Build", trigger: "<revise>", messageMode: "last", maxTriggerRounds: 2 },
    ],
  }), createGatingSchedulerRuntimeState());

  const plan = scheduler.planHandoffDispatch("BA", "需求已澄清", [
    { id: "BA", status: "completed" },
    { id: "Build", status: "idle" },
    { id: "Judge", status: "idle" },
  ]);

  assert.deepEqual(plan?.readyTargets, ["Build"]);
});
