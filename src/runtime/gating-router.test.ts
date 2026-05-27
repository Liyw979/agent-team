// 历史要求：执行期决策 Agent 判断直接使用共享拓扑能力，不保留薄包装方法，不引入多个拓扑兼容设想。
import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  buildTopologyNodeRecords,
  createTopologyFlowRecord,
  isDecisionAgentInTopology,
  type TopologyRecord,
} from "@shared/types";

import {
  applyAgentResultToGraphState as applyAgentResultToGraphStateInternal,
  createUserDispatchDecision,
  type GraphAgentResult,
} from "./gating-router";
import { createEmptyGraphTaskState } from "./gating-state";

type TestGraphAgentResult =
  | Omit<Extract<GraphAgentResult, { status: "failed" }>, "messageId" | "forwardedAgentMessage">
  | Omit<Extract<GraphAgentResult, { status: "completed"; routingKind: "default" }>, "messageId" | "forwardedAgentMessage">
  | Omit<Extract<GraphAgentResult, { status: "completed"; routingKind: "invalid" }>, "messageId" | "forwardedAgentMessage">
  | Omit<Extract<GraphAgentResult, { status: "completed"; routingKind: "triggered" }>, "messageId" | "forwardedAgentMessage">;

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

function applyResult(
  state: Parameters<typeof applyAgentResultToGraphStateInternal>[0],
  result: TestGraphAgentResult,
) {
  const baseResult = {
    agentId: result.agentId,
    messageId: `message:${result.agentId}`,
    decisionAgent: result.decisionAgent,
    agentStatus: result.agentStatus,
    agentContextContent: result.agentContextContent,
    forwardedAgentMessage: ("forwardedAgentMessage" in result
      ? result.forwardedAgentMessage
      : "") as string,
    signalDone: result.signalDone,
  };

  if (result.status === "failed") {
    return applyAgentResultToGraphStateInternal(state, {
      ...baseResult,
      status: "failed",
      routingKind: "invalid",
      errorMessage: result.errorMessage,
    });
  }

  if (result.routingKind === "triggered") {
    return applyAgentResultToGraphStateInternal(state, {
      ...baseResult,
      status: "completed",
      routingKind: "triggered",
      trigger: result.trigger,
    });
  }

  if (result.routingKind === "invalid") {
    return applyAgentResultToGraphStateInternal(state, {
      ...baseResult,
      status: "completed",
      routingKind: "invalid",
    });
  }

  return applyAgentResultToGraphStateInternal(state, {
    ...baseResult,
    status: "completed",
    routingKind: "default",
  });
}

function driveJudgeReviseLimit(
  topology: TopologyRecord,
  judgeRound1Trigger: string = "<revise>",
  judgeRound2Trigger: string = "<revise>",
) {
  let state = createEmptyGraphTaskState({
    topology,
  });

  state = applyResult(state, {
    agentId: "Build",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "Build 第 1 轮完成",
    signalDone: false,
  }).state;

  state = applyResult(state, {
    agentId: "Judge",
    status: "completed",
    decisionAgent: true,
    routingKind: "triggered",
    trigger: judgeRound1Trigger,
    agentStatus: "completed",
    agentContextContent: "请继续修订",
    signalDone: false,
  }).state;

  state = applyResult(state, {
    agentId: "Build",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "Build 第 2 轮完成",
    signalDone: false,
  }).state;

  return applyResult(state, {
    agentId: "Judge",
    status: "completed",
    decisionAgent: true,
    routingKind: "triggered",
    trigger: judgeRound2Trigger,
    agentStatus: "completed",
    agentContextContent: "仍需修订",
    signalDone: false,
  });
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

test("isDecisionAgentInTopology 会识别带非 default 出边的节点", () => {
  const topology = withNodeRecords({
    nodes: ["Build", "Judge", "Summary"],
    edges: [
      { source: "Build", target: "Judge", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "Judge", target: "Summary", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
    ],
  });

  assert.equal(
    isDecisionAgentInTopology(topology, "Judge"),
    true,
  );
});

test("default handoff 会派发到所有 default 下游", () => {
  const topology = withNodeRecords({
    nodes: ["BA", "Build", "CodeReview", "UnitTest"],
    edges: [
      { source: "BA", target: "Build", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "Build", target: "CodeReview", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "Build", target: "UnitTest", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
    ],
  });
  const state = createEmptyGraphTaskState({
    topology,
  });

  const start = createUserDispatchDecision(state, {
    targetAgentId: "BA",
    content: "请开始处理",
  });
  assert.equal(start.type, "execute_batch");

  const afterBa = applyResult(state, {
    agentId: "BA",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "需求已整理",
    signalDone: false,
  });
  assert.equal(afterBa.decision.type, "execute_batch");
  assert.deepEqual(afterBa.decision.batch.jobs.map((job) => job.agentId), ["Build"]);

  const afterBuild = applyResult(afterBa.state, {
    agentId: "Build",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "Build 已完成",
    signalDone: false,
  });
  assert.equal(afterBuild.decision.type, "execute_batch");
  assert.deepEqual(afterBuild.decision.batch.jobs.map((job) => job.agentId), ["CodeReview", "UnitTest"]);
});

test("triggered 会按 trigger 字面值派发到匹配边", () => {
  const topology = withNodeRecords({
    nodes: ["Judge", "Build", "Doc", "Summary"],
    edges: [
      { source: "Judge", target: "Build", trigger: "<revise>", messageMode: "last", maxTriggerRounds: 2 },
      { source: "Judge", target: "Doc", trigger: "<revise>", messageMode: "last", maxTriggerRounds: 2 },
      { source: "Judge", target: "Summary", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
    ],
  });
  const state = createEmptyGraphTaskState({
    topology,
  });

  const afterJudge = applyResult(state, {
    agentId: "Judge",
    status: "completed",
    decisionAgent: true,
    routingKind: "triggered",
    trigger: "<revise>",
    agentStatus: "completed",
    agentContextContent: "请继续修订",
    signalDone: false,
  });

  assert.equal(afterJudge.decision.type, "execute_batch");
  assert.equal(afterJudge.decision.batch.routingKind, "triggered");
  assert.equal(afterJudge.decision.batch.trigger, "<revise>");
  assert.deepEqual(afterJudge.decision.batch.jobs.map((job) => job.agentId).sort(), ["Build", "Doc"]);
});

test("同一 trigger 多入边任一来源完成后会立即派发", () => {
  const topology: TopologyRecord = withNodeRecords({
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
  });
  const state = createEmptyGraphTaskState({
    topology,
  });

  const afterPro = applyResult(state, {
    agentId: "漏洞论证-1",
    status: "completed",
    decisionAgent: true,
    routingKind: "triggered",
    trigger: "<complete>",
    agentStatus: "completed",
    agentContextContent: "同意进入总结",
    signalDone: false,
  });
  assert.equal(afterPro.decision.type, "execute_batch");
  assert.deepEqual(afterPro.decision.batch.jobs.map((job) => job.agentId), ["讨论总结-1"]);
});

test("trigger 边达到 maxTriggerRounds 且没有其他 trigger 可转派时会失败", () => {
  const topology = withNodeRecords({
    nodes: ["Build", "Judge"],
    edges: [
      { source: "Build", target: "Judge", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "Judge", target: "Build", trigger: "<revise>", messageMode: "last", maxTriggerRounds: 1 },
    ],
  });
  const afterJudgeRound2 = driveJudgeReviseLimit(topology);

  assert.equal(afterJudgeRound2.decision.type, "failed");
  assert.match(afterJudgeRound2.decision.errorMessage, /已连续交流 1 次/u);
});

test("trigger 边达到 maxTriggerRounds 后会改走其他 trigger，避免团队停住", () => {
  const topology = withNodeRecords({
    nodes: ["Build", "Judge", "Summary"],
    edges: [
      { source: "Build", target: "Judge", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "Judge", target: "Build", trigger: "<revise>", messageMode: "last", maxTriggerRounds: 1 },
      { source: "Judge", target: "Summary", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
    ],
  });
  const afterJudgeRound2 = driveJudgeReviseLimit(topology);

  assert.equal(afterJudgeRound2.decision.type, "execute_batch");
  assert.equal(afterJudgeRound2.decision.batch.routingKind, "triggered");
  assert.equal(afterJudgeRound2.decision.batch.trigger, "<complete>");
  assert.equal(afterJudgeRound2.decision.batch.displayContent, "Judge -> Build 已连续交流 1 次");
  assert.deepEqual(afterJudgeRound2.decision.batch.jobs.map((job) => job.agentId), ["Summary"]);
});

test("trigger 边超限后会改走同一 target 的其他 trigger", () => {
  const topology = withNodeRecords({
    nodes: ["Build", "Judge"],
    edges: [
      { source: "Build", target: "Judge", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "Judge", target: "Build", trigger: "<revise>", messageMode: "last", maxTriggerRounds: 1 },
      { source: "Judge", target: "Build", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
    ],
  });
  const afterJudgeRound2 = driveJudgeReviseLimit(topology);

  assert.equal(afterJudgeRound2.decision.type, "execute_batch");
  assert.equal(afterJudgeRound2.decision.batch.routingKind, "triggered");
  assert.equal(afterJudgeRound2.decision.batch.trigger, "<complete>");
  assert.deepEqual(afterJudgeRound2.decision.batch.jobs.map((job) => job.agentId), ["Build"]);
});

test("多个可转派 trigger 都已超限时，不会无限递归，而是直接失败", () => {
  const topology = withNodeRecords({
    nodes: ["Build", "Judge", "Summary"],
    edges: [
      { source: "Build", target: "Judge", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "Judge", target: "Build", trigger: "<revise>", messageMode: "last", maxTriggerRounds: 1 },
      { source: "Judge", target: "Summary", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 1 },
    ],
  });
  let state = createEmptyGraphTaskState({
    topology,
  });

  state = driveJudgeReviseLimit(topology, "<revise>", "<complete>").state;

  const afterJudgeRound2 = applyResult(state, {
    agentId: "Judge",
    status: "completed",
    decisionAgent: true,
    routingKind: "triggered",
    trigger: "<revise>",
    agentStatus: "completed",
    agentContextContent: "仍需修订",
    signalDone: false,
  });

  assert.equal(afterJudgeRound2.decision.type, "failed");
  assert.match(afterJudgeRound2.decision.errorMessage, /已连续交流 1 次/u);
});

test("trigger 边超限后若唯一其他 trigger 指向 __end__，会按该 trigger 结束而不是失败", () => {
  const topology = withNodeRecords({
    nodes: ["Build", "Judge"],
    edges: [
      { source: "Build", target: "Judge", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "Judge", target: "Build", trigger: "<revise>", messageMode: "last", maxTriggerRounds: 1 },
    ],
    flow: {
      start: {
        id: "__start__",
        targets: ["Build"],
      },
      end: {
        id: "__end__",
        sources: ["Judge"],
        incoming: [{ source: "Judge", trigger: "<complete>" }],
      },
    },
  });
  const afterJudgeRound2 = driveJudgeReviseLimit(topology);

  assert.equal(afterJudgeRound2.decision.type, "finished");
  assert.equal(afterJudgeRound2.decision.finishReason, "end_edge_triggered");
  assert.equal(afterJudgeRound2.state.finishReason, "end_edge_triggered");
});

test("maxTriggerRounds=-1 表示无限次，不会触发上限失败", () => {
  const topology = withNodeRecords({
    nodes: ["Build", "Judge"],
    edges: [
      { source: "Build", target: "Judge", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "Judge", target: "Build", trigger: "<revise>", messageMode: "last", maxTriggerRounds: -1 },
    ],
  });
  let state = createEmptyGraphTaskState({
    topology,
  });

  for (let round = 0; round < 3; round += 1) {
    const afterBuild = applyResult(state, {
      agentId: "Build",
      status: "completed",
      decisionAgent: false,
      routingKind: "default",
      agentStatus: "completed",
      agentContextContent: `Build 第 ${round + 1} 轮完成`,
      signalDone: false,
    });
    state = afterBuild.state;

    const afterJudge = applyResult(state, {
      agentId: "Judge",
      status: "completed",
      decisionAgent: true,
      routingKind: "triggered",
      trigger: "<revise>",
      agentStatus: "completed",
      agentContextContent: `Judge 第 ${round + 1} 轮要求修订`,
      signalDone: false,
    });
    assert.equal(afterJudge.decision.type, "execute_batch");
    state = afterJudge.state;
  }
});
