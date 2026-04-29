import assert from "node:assert/strict";
import test from "node:test";

import type { TopologyRecord } from "@shared/types";

import {
  applyAgentResultToGraphState as applyAgentResultToGraphStateInternal,
  createGraphTaskState,
  createUserDispatchDecision,
  resolveRestrictedRepairTargetsForSource,
  type GraphAgentResult,
} from "./gating-router";
import { compileBuiltinVulnerabilityTopology } from "./builtin-topology-test-helpers";
import { resolveExecutionDecisionAgent } from "./decision-agent-context";

function createBuiltinVulnerabilityTopology(): TopologyRecord {
  return compileBuiltinVulnerabilityTopology().topology;
}

type TestGraphAgentResult =
  | Omit<Extract<GraphAgentResult, { status: "failed" }>, "messageId">
  | Omit<Extract<GraphAgentResult, { status: "completed"; routingKind: "default" }>, "messageId">
  | Omit<Extract<GraphAgentResult, { status: "completed"; routingKind: "invalid" }>, "messageId">
  | Omit<Extract<GraphAgentResult, { status: "completed"; routingKind: "labeled" }>, "messageId">;

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
    opinion: result.opinion,
    signalDone: result.signalDone,
  };
  let graphResult: GraphAgentResult;
  if (result.status === "failed") {
    graphResult = {
      ...baseResult,
      status: "failed",
      routingKind: "invalid",
      errorMessage: result.errorMessage,
    };
  } else if (result.routingKind === "labeled") {
    graphResult = {
      ...baseResult,
      status: "completed",
      routingKind: "labeled",
      trigger: result.trigger,
    };
  } else {
    graphResult = {
      ...baseResult,
      status: "completed",
      routingKind: result.routingKind,
    };
  }
  return applyAgentResultToGraphStateInternal(state, graphResult);
}

function createTopology(): TopologyRecord {
  return {
    nodes: ["BA", "Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      { source: "BA", target: "Build", trigger: "<default>", messageMode: "last" },
      { source: "Build", target: "CodeReview", trigger: "<default>", messageMode: "last" },
      { source: "Build", target: "UnitTest", trigger: "<default>", messageMode: "last" },
      { source: "Build", target: "TaskReview", trigger: "<default>", messageMode: "last" },
      { source: "CodeReview", target: "Build", trigger: "<continue>", maxTriggerRounds: 4, messageMode: "last" },
      { source: "CodeReview", target: "TaskReview", trigger: "<complete>", messageMode: "last" },
    ],
  };
}

test("resolveExecutionDecisionAgent 会把 spawn 子图里带结束 trigger 出边的运行时实例识别为 decision agent", () => {
  const topology: TopologyRecord = {
    nodes: ["线索发现", "疑点辩论", "漏洞论证", "讨论总结"],
    nodeRecords: [
      { id: "线索发现", kind: "agent", templateName: "线索发现" },
      { id: "疑点辩论", kind: "spawn", templateName: "疑点辩论", spawnRuleId: "spawn-rule:疑点辩论" },
      { id: "漏洞论证", kind: "agent", templateName: "漏洞论证" },
      { id: "讨论总结", kind: "agent", templateName: "讨论总结" },
    ],
    edges: [
      { source: "线索发现", target: "疑点辩论", trigger: "<default>", messageMode: "last" },
      { source: "疑点辩论", target: "线索发现", trigger: "<default>", messageMode: "last" },
    ],
    spawnRules: [
      {
        id: "疑点辩论",
        spawnNodeName: "疑点辩论",
        entryRole: "漏洞论证",
        spawnedAgents: [
          { role: "漏洞论证", templateName: "漏洞论证" },
          { role: "讨论总结", templateName: "讨论总结" },
        ],
        edges: [
          { sourceRole: "漏洞论证", targetRole: "讨论总结", trigger: "<complete>", messageMode: "last" },
        ],
        exitWhen: "all_completed",
        reportToTemplateName: "线索发现",
        reportToTrigger: "<default>",
      },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-decision-agent-context",
    topology,
  });
  state.runtimeNodes = [
    {
      id: "漏洞论证-1",
      kind: "agent",
      templateName: "漏洞论证",
      displayName: "漏洞论证-1",
      sourceNodeId: "疑点辩论",
      groupId: "spawn-rule:疑点辩论:spawn-rule:疑点辩论-0001",
      role: "漏洞论证",
    },
    {
      id: "讨论总结-1",
      kind: "agent",
      templateName: "讨论总结",
      displayName: "讨论总结-1",
      sourceNodeId: "疑点辩论",
      groupId: "spawn-rule:疑点辩论:spawn-rule:疑点辩论-0001",
      role: "讨论总结",
    },
  ];
  state.runtimeEdges = [
    {
      source: "漏洞论证-1",
      target: "讨论总结-1",
      trigger: "<complete>",
      messageMode: "last",
    },
  ];

  assert.equal(
    resolveExecutionDecisionAgent({
      state,
      topology,
      runtimeAgentId: "漏洞论证-1",
      executableAgentId: "漏洞论证",
    }),
    true,
  );
});

test("resolveRestrictedRepairTargetsForSource 只会保留 source 的直接 handoff decisionAgent", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "UnitTest", "CodeReview", "TaskReview"],
    edges: [
      { source: "Build", target: "UnitTest", trigger: "<default>", messageMode: "last" },
      { source: "UnitTest", target: "CodeReview", trigger: "<complete>", messageMode: "last" },
      { source: "CodeReview", target: "Build", trigger: "<continue>", maxTriggerRounds: 4, messageMode: "last" },
      { source: "CodeReview", target: "TaskReview", trigger: "<complete>", messageMode: "last" },
    ],
  };

  assert.deepEqual(
    resolveRestrictedRepairTargetsForSource(topology, "Build", ["CodeReview"]),
    [],
  );
  assert.deepEqual(
    resolveRestrictedRepairTargetsForSource(topology, "Build", ["UnitTest", "CodeReview"]),
    ["UnitTest"],
  );
});

test("resolveExecutionDecisionAgent 不会把没有任何非 <default> trigger 出边的普通 agent 误判为 decision agent", () => {
  const topology: TopologyRecord = {
    nodes: ["线索发现", "疑点辩论"],
    edges: [
      { source: "线索发现", target: "疑点辩论", trigger: "<default>", messageMode: "last" },
    ],
  };

  assert.equal(
    resolveExecutionDecisionAgent({
      state: null,
      topology,
      runtimeAgentId: "线索发现",
      executableAgentId: "线索发现",
    }),
    false,
  );
});

test("resolveExecutionDecisionAgent 会把仅通过 __end__ 暴露结束 trigger 分支的节点识别为 decision agent", () => {
  const topology: TopologyRecord = {
    nodes: ["线索发现"],
    edges: [],
    langgraph: {
      start: {
        id: "__start__",
        targets: ["线索发现"],
      },
      end: {
        id: "__end__",
        sources: ["线索发现"],
        incoming: [
          { source: "线索发现", trigger: "<complete>" },
        ],
      },
    },
  };

  assert.equal(
    resolveExecutionDecisionAgent({
      state: null,
      topology,
      runtimeAgentId: "线索发现",
      executableAgentId: "线索发现",
    }),
    true,
  );
});

test("router 会按当前批次完整放行 default handoff 下游，不再保留旧的嵌套优先语义", () => {
  const topology = createTopology();
  const state = createGraphTaskState({
    taskId: "task-1",
    topology,
  });

  const startDecision = createUserDispatchDecision(state, {
    targetAgentId: "BA",
    content: "请先实现，然后经过 CodeReview。",
  });
  assert.equal(startDecision.type, "execute_batch");
  assert.deepEqual(startDecision.batch.jobs.map((job) => job.agentId), ["BA"]);

  const afterBa = applyResult(state, {
    agentId: "BA",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "需求已澄清",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterBa.decision.type, "execute_batch");
  assert.deepEqual(afterBa.decision.batch.jobs.map((job) => job.agentId), ["Build"]);

  const afterBuildFirst = applyResult(afterBa.state, {
    agentId: "Build",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "Build 首轮已完成",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterBuildFirst.decision.type, "execute_batch");
  assert.deepEqual(
    afterBuildFirst.decision.batch.jobs.map((job) => job.agentId),
    ["CodeReview", "UnitTest", "TaskReview"],
  );

  const afterApproved = applyResult(afterBuildFirst.state, {
    agentId: "CodeReview",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<complete>",
    agentStatus: "completed",
    agentContextContent: "CodeReview 已通过",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterApproved.decision.type, "execute_batch");
  assert.deepEqual(afterApproved.decision.batch.jobs.map((job) => job.agentId), ["TaskReview"]);

  const afterTaskReview = applyResult(afterApproved.state, {
    agentId: "TaskReview",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<complete>",
    agentStatus: "completed",
    agentContextContent: "TaskReview 已收到最新结果",
    opinion: "",
    signalDone: false,
  });
  assert.deepEqual(afterTaskReview.decision, {
    type: "finished",
    finishReason: "no_runnable_agents",
  });

  const afterUnitTest = applyResult(afterTaskReview.state, {
    agentId: "UnitTest",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<complete>",
    agentStatus: "completed",
    agentContextContent: "UnitTest 已收到最新结果",
    opinion: "",
    signalDone: false,
  });
  assert.deepEqual(afterUnitTest.decision, {
    type: "finished",
    finishReason: "no_runnable_agents",
  });
});

test("CodeReview 通过 UnitTest 间接回流 Build 后，Build 下一轮仍会重新派发直接 handoff decisionAgent", () => {
  const topology: TopologyRecord = {
    nodes: ["BA", "Build", "UnitTest", "CodeReview", "TaskReview"],
    edges: [
      { source: "BA", target: "Build", trigger: "<default>", messageMode: "last" },
      { source: "Build", target: "UnitTest", trigger: "<default>", messageMode: "last" },
      { source: "UnitTest", target: "Build", trigger: "<continue>", maxTriggerRounds: 4, messageMode: "last" },
      { source: "UnitTest", target: "CodeReview", trigger: "<complete>", messageMode: "last" },
      { source: "CodeReview", target: "Build", trigger: "<continue>", maxTriggerRounds: 4, messageMode: "last" },
      { source: "CodeReview", target: "TaskReview", trigger: "<complete>", messageMode: "last" },
      { source: "TaskReview", target: "Build", trigger: "<continue>", maxTriggerRounds: 4, messageMode: "last" },
    ],
  };
  const baseResult = {
    status: "completed" as const,
    agentStatus: "completed" as const,
    opinion: "",
    signalDone: false,
  };

  const startState = createGraphTaskState({
    taskId: "nested-decision-back-to-build",
    topology,
  });
  const afterBa = applyResult(startState, {
    agentId: "BA",
    decisionAgent: false,
    routingKind: "default",
    agentContextContent: "BA 已整理需求",
    ...baseResult,
  });
  const afterBuild1 = applyResult(afterBa.state, {
    agentId: "Build",
    decisionAgent: false,
    routingKind: "default",
    agentContextContent: "Build 第 1 次构建完成",
    ...baseResult,
  });
  const afterUnitTestFail1 = applyResult(afterBuild1.state, {
    agentId: "UnitTest",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<continue>",
    agentContextContent: "UnitTest 第 1 轮未通过",
    ...baseResult,
  });
  const afterBuild2 = applyResult(afterUnitTestFail1.state, {
    agentId: "Build",
    decisionAgent: false,
    routingKind: "default",
    agentContextContent: "Build 第 2 次构建完成",
    ...baseResult,
  });
  const afterUnitTestPass2 = applyResult(afterBuild2.state, {
    agentId: "UnitTest",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<complete>",
    agentContextContent: "UnitTest 第 2 轮通过",
    ...baseResult,
  });
  const afterCodeReviewFail = applyResult(afterUnitTestPass2.state, {
    agentId: "CodeReview",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<continue>",
    agentContextContent: "CodeReview 未通过",
    ...baseResult,
  });

  assert.equal(afterCodeReviewFail.decision.type, "execute_batch");
  assert.deepEqual(afterCodeReviewFail.decision.batch.jobs.map((job) => job.agentId), ["Build"]);

  const afterBuild3 = applyResult(afterCodeReviewFail.state, {
    agentId: "Build",
    decisionAgent: false,
    routingKind: "default",
    agentContextContent: "Build 第 3 次构建完成",
    ...baseResult,
  });

  assert.equal(afterBuild3.decision.type, "execute_batch");
  assert.deepEqual(afterBuild3.decision.batch.jobs.map((job) => job.agentId), ["UnitTest"]);
});

test("router 会在并发 decisionAgent 未收齐前保持等待，不会提前回流", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
    edges: [
      { source: "Build", target: "UnitTest", trigger: "<default>", messageMode: "last" },
      { source: "Build", target: "TaskReview", trigger: "<default>", messageMode: "last" },
      { source: "Build", target: "CodeReview", trigger: "<default>", messageMode: "last" },
      { source: "UnitTest", target: "Build", trigger: "<continue>", maxTriggerRounds: 4, messageMode: "last" },
      { source: "TaskReview", target: "Build", trigger: "<continue>", maxTriggerRounds: 4, messageMode: "last" },
      { source: "CodeReview", target: "Build", trigger: "<continue>", maxTriggerRounds: 4, messageMode: "last" },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-2",
    topology,
  });

  const afterBuild = applyResult(state, {
    agentId: "Build",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "Build 已完成",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterBuild.decision.type, "execute_batch");
  assert.deepEqual(
    afterBuild.decision.batch.jobs.map((job) => job.agentId),
    ["UnitTest", "TaskReview", "CodeReview"],
  );

  const afterUnitTestFail = applyResult(afterBuild.state, {
    agentId: "UnitTest",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<continue>",
    agentStatus: "action_required",
    agentContextContent: "UnitTest 未通过",
    opinion: "请修复单测问题",
    signalDone: false,
  });
  assert.deepEqual(afterUnitTestFail.decision, {
    type: "finished",
    finishReason: "wait_pending_decision_agents",
  });
});


test("并发 decisionAgent 补发旧回流时，必须沿旧 decisionAgent 自己的 trigger 路由", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "UnitTest", "TaskReview"],
    edges: [
      { source: "Build", target: "UnitTest", trigger: "<default>", messageMode: "last" },
      { source: "Build", target: "TaskReview", trigger: "<default>", messageMode: "last" },
      { source: "UnitTest", target: "Build", trigger: "<first>", messageMode: "last" },
      { source: "TaskReview", target: "Build", trigger: "<second>", messageMode: "last" },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-trigger-repair",
    topology,
  });

  const afterBuild = applyResult(state, {
    agentId: "Build",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "Build 首轮已完成",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterBuild.decision.type, "execute_batch");
  assert.deepEqual(afterBuild.decision.batch.jobs.map((job) => job.agentId), ["UnitTest", "TaskReview"]);

  const afterUnitTest = applyResult(afterBuild.state, {
    agentId: "UnitTest",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<first>",
    agentStatus: "action_required",
    agentContextContent: "UnitTest 发现问题",
    opinion: "请 Build 先修第一类问题。",
    signalDone: false,
  });
  assert.equal(afterUnitTest.decision.type, "execute_batch");
  assert.equal(afterUnitTest.decision.batch.sourceAgentId, "UnitTest");
  assert.equal(afterUnitTest.decision.batch.trigger, "<first>");
  assert.deepEqual(afterUnitTest.decision.batch.jobs.map((job) => job.agentId), ["Build"]);

  const afterTaskReview = applyResult(afterUnitTest.state, {
    agentId: "TaskReview",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<second>",
    agentStatus: "action_required",
    agentContextContent: "TaskReview 也发现问题",
    opinion: "请 Build 先修第二类问题。",
    signalDone: false,
  });
  assert.equal(afterTaskReview.decision.type, "execute_batch");
  assert.equal(afterTaskReview.decision.batch.sourceAgentId, "TaskReview");
  assert.equal(afterTaskReview.decision.batch.trigger, "<second>");
  assert.deepEqual(afterTaskReview.decision.batch.jobs.map((job) => job.agentId), ["Build"]);
});

test("带 maxTriggerRounds 的 <revise> 会按 action_required 回流，而不是被当成普通 labeled 派发", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "Judge", "Research", "Summary"],
    edges: [
      { source: "Build", target: "Judge", trigger: "<default>", messageMode: "last" },
      { source: "Judge", target: "Research", trigger: "<revise>", messageMode: "last", maxTriggerRounds: 2 },
      { source: "Judge", target: "Summary", trigger: "<approved>", messageMode: "last" },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-revise-action-required",
    topology,
  });

  const afterBuild = applyResult(state, {
    agentId: "Build",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "Build 已完成首轮。",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterBuild.decision.type, "execute_batch");

  const afterJudge = applyResult(afterBuild.state, {
    agentId: "Judge",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<revise>",
    agentStatus: "action_required",
    agentContextContent: "Judge 需要继续补证。",
    opinion: "请 Research 继续补证。",
    signalDone: false,
  });

  assert.equal(afterJudge.decision.type, "execute_batch");
  assert.equal(afterJudge.decision.batch.sourceAgentId, "Judge");
  assert.equal(afterJudge.decision.batch.trigger, "<revise>");
  assert.deepEqual(afterJudge.decision.batch.jobs.map((job) => ({
    agentId: job.agentId,
    sourceAgentId: "sourceAgentId" in job ? job.sourceAgentId : null,
    sourceMessageId: "sourceMessageId" in job ? job.sourceMessageId : null,
    sourceContent: "sourceContent" in job ? job.sourceContent : null,
    displayContent: "displayContent" in job ? job.displayContent : null,
    kind: job.kind,
  })), [
    {
      agentId: "Research",
      sourceAgentId: "Judge",
      sourceMessageId: "message:Judge",
      sourceContent: "请 Research 继续补证。",
      displayContent: "请 Research 继续补证。",
      kind: "action_required_request",
    },
  ]);
});

test("action_required 同 trigger 命中多个下游时，会按整组目标派发并限制每个修复节点的后续回流", () => {
  const topology: TopologyRecord = {
    nodes: ["Judge", "Build", "Doc", "OtherJudge"],
    edges: [
      { source: "Build", target: "Judge", trigger: "<default>", messageMode: "last" },
      { source: "Build", target: "OtherJudge", trigger: "<default>", messageMode: "last" },
      { source: "Doc", target: "Judge", trigger: "<default>", messageMode: "last" },
      { source: "Judge", target: "Build", trigger: "<revise>", messageMode: "last", maxTriggerRounds: 2 },
      { source: "Judge", target: "Doc", trigger: "<revise>", messageMode: "last", maxTriggerRounds: 2 },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-multi-action-required-targets",
    topology,
  });

  const afterJudge = applyResult(state, {
    agentId: "Judge",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<revise>",
    agentStatus: "action_required",
    agentContextContent: "Judge 需要 Build 和 Doc 同时补齐。",
    opinion: "请分别补齐实现与文档。",
    signalDone: false,
  });

  assert.equal(afterJudge.decision.type, "execute_batch");
  assert.deepEqual(
    afterJudge.decision.batch.jobs.map((job) => job.agentId).sort(),
    ["Build", "Doc"],
  );
  assert.deepEqual(afterJudge.state.pendingHandoffRepairTargetsBySource, {
    Build: ["Judge"],
    Doc: ["Judge"],
  });

  const afterBuildRepair = applyResult(afterJudge.state, {
    agentId: "Build",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "Build 已补齐实现。",
    opinion: "",
    signalDone: false,
  });

  assert.equal(afterBuildRepair.decision.type, "finished");
  assert.equal(afterBuildRepair.decision.finishReason, "no_runnable_agents");
});

test("并发 decisionAgent 中单条回流链路超限时，会先继续其他待处理 action_required 链路", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "UnitTest", "TaskReview", "CodeReview", "Judge"],
    edges: [
      { source: "Build", target: "UnitTest", trigger: "<default>", messageMode: "last" },
      { source: "Build", target: "TaskReview", trigger: "<default>", messageMode: "last" },
      { source: "Build", target: "CodeReview", trigger: "<default>", messageMode: "last" },
      { source: "UnitTest", target: "Build", trigger: "<continue>", maxTriggerRounds: 1, messageMode: "last" },
      { source: "UnitTest", target: "Judge", trigger: "<complete>", messageMode: "last" },
      { source: "TaskReview", target: "Build", trigger: "<continue>", maxTriggerRounds: 4, messageMode: "last" },
      { source: "CodeReview", target: "Build", trigger: "<continue>", maxTriggerRounds: 4, messageMode: "last" },
    ],
  };
  let state = createGraphTaskState({
    taskId: "task-parallel-loop-isolation",
    topology,
  });

  const afterBuildRound1 = applyResult(state, {
    agentId: "Build",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "Build 第 1 轮已完成",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterBuildRound1.decision.type, "execute_batch");
  assert.deepEqual(
    afterBuildRound1.decision.batch.jobs.map((job) => job.agentId),
    ["UnitTest", "TaskReview", "CodeReview"],
  );

  const afterTaskReviewApproved = applyResult(afterBuildRound1.state, {
    agentId: "TaskReview",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<complete>",
    agentStatus: "completed",
    agentContextContent: "TaskReview 通过",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterTaskReviewApproved.decision.type, "finished");

  const afterCodeReviewActionRequired = applyResult(afterTaskReviewApproved.state, {
    agentId: "CodeReview",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<continue>",
    agentStatus: "action_required",
    agentContextContent: "CodeReview 第 1 轮未通过",
    opinion: "请修复 CodeReview 第 1 轮问题",
    signalDone: false,
  });
  assert.equal(afterCodeReviewActionRequired.decision.type, "finished");

  const afterUnitTestActionRequiredRound1 = applyResult(afterCodeReviewActionRequired.state, {
    agentId: "UnitTest",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<continue>",
    agentStatus: "action_required",
    agentContextContent: "UnitTest 第 1 轮未通过",
    opinion: "请修复 UnitTest 第 1 轮问题",
    signalDone: false,
  });
  assert.equal(afterUnitTestActionRequiredRound1.decision.type, "execute_batch");
  assert.deepEqual(afterUnitTestActionRequiredRound1.decision.batch.jobs.map((job) => job.agentId), ["Build"]);
  state = afterUnitTestActionRequiredRound1.state;

  const afterBuildRound2 = applyResult(state, {
    agentId: "Build",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "Build 第 2 轮已完成",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterBuildRound2.decision.type, "execute_batch");
  assert.deepEqual(afterBuildRound2.decision.batch.jobs.map((job) => job.agentId), ["UnitTest"]);

  const afterUnitTestActionRequiredRound2 = applyResult(afterBuildRound2.state, {
    agentId: "UnitTest",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<continue>",
    agentStatus: "action_required",
    agentContextContent: "UnitTest 第 2 轮未通过",
    opinion: "请修复 UnitTest 第 2 轮问题",
    signalDone: false,
  });

  assert.equal(afterUnitTestActionRequiredRound2.decision.type, "execute_batch");
  assert.deepEqual(afterUnitTestActionRequiredRound2.decision.batch.jobs.map((job) => ({
    agentId: job.agentId,
    sourceAgentId: "sourceAgentId" in job ? job.sourceAgentId : null,
    sourceMessageId: "sourceMessageId" in job ? job.sourceMessageId : null,
    sourceContent: "sourceContent" in job ? job.sourceContent : null,
    displayContent: "displayContent" in job ? job.displayContent : null,
    kind: job.kind,
  })), [
    {
      agentId: "Build",
      sourceAgentId: "CodeReview",
      sourceMessageId: "message:CodeReview",
      sourceContent: "请修复 CodeReview 第 1 轮问题",
      displayContent: "请修复 CodeReview 第 1 轮问题",
      kind: "action_required_request",
    },
  ]);
  assert.equal(afterUnitTestActionRequiredRound2.decision.batch.sourceAgentId, "CodeReview");
  assert.match(afterUnitTestActionRequiredRound2.decision.batch.sourceContent ?? "", /请修复 CodeReview 第 1 轮问题/u);
  assert.equal(
    afterUnitTestActionRequiredRound2.decision.batch.jobs.some((job) => job.agentId === "Judge"),
    false,
  );
});

test("回流超限时，如果存在唯一其他 trigger 下游，会直接升级到该 trigger 下游", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "漏洞挑战-1", "讨论总结-1"],
    edges: [
      { source: "Build", target: "漏洞挑战-1", trigger: "<default>", messageMode: "last" },
      { source: "漏洞挑战-1", target: "Build", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 1 },
      { source: "漏洞挑战-1", target: "讨论总结-1", trigger: "<complete>", messageMode: "last" },
    ],
  };
  let state = createGraphTaskState({
    taskId: "task-loop-limit-dedup",
    topology,
  });

  const afterBuildRound1 = applyResult(state, {
    agentId: "Build",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "Build 第 1 轮已完成",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterBuildRound1.decision.type, "execute_batch");
  state = afterBuildRound1.state;

  const decisionBody = `当前证据仍不足以证明越权成立。

漏洞挑战-1 -> Build 已连续交流 1 次`;
  const afterDecisionAgentRound1 = applyResult(state, {
    agentId: "漏洞挑战-1",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<continue>",
    agentStatus: "action_required",
    agentContextContent: decisionBody,
    opinion: decisionBody,
    signalDone: false,
  });
  assert.equal(afterDecisionAgentRound1.decision.type, "execute_batch");
  assert.deepEqual(afterDecisionAgentRound1.decision.batch.jobs.map((job) => job.agentId), ["Build"]);
  state = afterDecisionAgentRound1.state;

  const afterBuildRound2 = applyResult(state, {
    agentId: "Build",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "Build 第 2 轮已完成",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterBuildRound2.decision.type, "execute_batch");
  assert.deepEqual(afterBuildRound2.decision.batch.jobs.map((job) => job.agentId), ["漏洞挑战-1"]);
  state = afterBuildRound2.state;

  const afterDecisionAgentRound2 = applyResult(state, {
    agentId: "漏洞挑战-1",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<continue>",
    agentStatus: "action_required",
    agentContextContent: decisionBody,
    opinion: decisionBody,
    signalDone: false,
  });

  assert.equal(afterDecisionAgentRound2.decision.type, "execute_batch");
  assert.deepEqual(afterDecisionAgentRound2.decision.batch.jobs.map((job) => job.agentId), ["讨论总结-1"]);
  assert.equal(afterDecisionAgentRound2.decision.batch.trigger, "<complete>");
  assert.equal(afterDecisionAgentRound2.decision.batch.sourceContent, decisionBody);
});

test("回流超限升级到其他 trigger 下游时，不应把系统超限提示注入到下游 agent 正文", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "漏洞挑战-1", "讨论总结-1"],
    edges: [
      { source: "Build", target: "漏洞挑战-1", trigger: "<default>", messageMode: "last" },
      { source: "漏洞挑战-1", target: "Build", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 1 },
      { source: "漏洞挑战-1", target: "讨论总结-1", trigger: "<complete>", messageMode: "last" },
    ],
  };
  let state = createGraphTaskState({
    taskId: "task-loop-limit-no-system-prompt",
    topology,
  });

  const afterBuildRound1 = applyResult(state, {
    agentId: "Build",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "Build 第 1 轮已完成",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterBuildRound1.decision.type, "execute_batch");
  state = afterBuildRound1.state;

  const decisionBody = "当前证据仍不足以证明越权成立。";
  const afterDecisionAgentRound1 = applyResult(state, {
    agentId: "漏洞挑战-1",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<continue>",
    agentStatus: "action_required",
    agentContextContent: decisionBody,
    opinion: decisionBody,
    signalDone: false,
  });
  assert.equal(afterDecisionAgentRound1.decision.type, "execute_batch");
  state = afterDecisionAgentRound1.state;

  const afterBuildRound2 = applyResult(state, {
    agentId: "Build",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "Build 第 2 轮已完成",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterBuildRound2.decision.type, "execute_batch");
  state = afterBuildRound2.state;

  const afterDecisionAgentRound2 = applyResult(state, {
    agentId: "漏洞挑战-1",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<continue>",
    agentStatus: "action_required",
    agentContextContent: decisionBody,
    opinion: decisionBody,
    signalDone: false,
  });

  assert.equal(afterDecisionAgentRound2.decision.type, "execute_batch");
  assert.deepEqual(afterDecisionAgentRound2.decision.batch.jobs.map((job) => job.agentId), ["讨论总结-1"]);
  assert.equal(afterDecisionAgentRound2.decision.batch.trigger, "<complete>");
  assert.equal(afterDecisionAgentRound2.decision.batch.sourceContent, decisionBody);
  assert.doesNotMatch(afterDecisionAgentRound2.decision.batch.sourceContent ?? "", /系统/u);
});

test("回流超限后若剩余候选只包含 action_required trigger，则必须直接失败", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "Judge", "Research"],
    edges: [
      { source: "Build", target: "Judge", trigger: "<default>", messageMode: "last" },
      { source: "Judge", target: "Build", trigger: "<revise>", messageMode: "last", maxTriggerRounds: 1 },
      { source: "Judge", target: "Research", trigger: "<retry>", messageMode: "last", maxTriggerRounds: 1 },
    ],
  };
  let state = createGraphTaskState({
    taskId: "task-loop-limit-no-labeled-escalation",
    topology,
  });

  const afterBuildRound1 = applyResult(state, {
    agentId: "Build",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "Build 第 1 轮已完成",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterBuildRound1.decision.type, "execute_batch");
  state = afterBuildRound1.state;

  const afterJudgeRound1 = applyResult(state, {
    agentId: "Judge",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<revise>",
    agentStatus: "action_required",
    agentContextContent: "Judge 需要继续修订。",
    opinion: "请 Build 继续修订。",
    signalDone: false,
  });
  assert.equal(afterJudgeRound1.decision.type, "execute_batch");
  state = afterJudgeRound1.state;

  const afterBuildRound2 = applyResult(state, {
    agentId: "Build",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "Build 第 2 轮已完成",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterBuildRound2.decision.type, "execute_batch");
  state = afterBuildRound2.state;

  const afterJudgeRound2 = applyResult(state, {
    agentId: "Judge",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<revise>",
    agentStatus: "action_required",
    agentContextContent: "Judge 仍需继续修订。",
    opinion: "Build 还需要继续修订。",
    signalDone: false,
  });

  assert.equal(afterJudgeRound2.decision.type, "failed");
  assert.match(afterJudgeRound2.decision.errorMessage, /已连续交流 1 次/u);
});

test("回流超限时会按真实自定义 trigger 升级到对应下游", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "Judge", "Summary"],
    edges: [
      { source: "Build", target: "Judge", trigger: "<default>", messageMode: "last" },
      { source: "Judge", target: "Build", trigger: "<revise>", messageMode: "last", maxTriggerRounds: 1 },
      { source: "Judge", target: "Summary", trigger: "<approved>", messageMode: "last" },
    ],
  };
  let state = createGraphTaskState({
    taskId: "task-loop-limit-custom-approved-trigger",
    topology,
  });

  const afterBuildRound1 = applyResult(state, {
    agentId: "Build",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "Build 第 1 轮已完成",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterBuildRound1.decision.type, "execute_batch");
  state = afterBuildRound1.state;

  const afterJudgeRound1 = applyResult(state, {
    agentId: "Judge",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<revise>",
    agentStatus: "action_required",
    agentContextContent: "还需要继续修订。",
    opinion: "请继续修改。",
    signalDone: false,
  });
  assert.equal(afterJudgeRound1.decision.type, "execute_batch");
  state = afterJudgeRound1.state;

  const afterBuildRound2 = applyResult(state, {
    agentId: "Build",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "Build 第 2 轮已完成",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterBuildRound2.decision.type, "execute_batch");
  state = afterBuildRound2.state;

  const afterJudgeRound2 = applyResult(state, {
    agentId: "Judge",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<revise>",
    agentStatus: "action_required",
    agentContextContent: "仍然需要修改，但已达到超限。",
    opinion: "请升级到总结节点。",
    signalDone: false,
  });

  assert.equal(afterJudgeRound2.decision.type, "execute_batch");
  assert.equal(afterJudgeRound2.decision.batch.trigger, "<approved>");
  assert.deepEqual(afterJudgeRound2.decision.batch.jobs.map((job) => job.agentId), ["Summary"]);
});

test("用户消息命中 spawn 节点时会自动生成实例组并启动入口角色", () => {
  const topology: TopologyRecord = {
    nodes: ["线索发现", "漏洞论证模板", "漏洞挑战模板", "Summary模板"],
    nodeRecords: [
      { id: "线索发现", kind: "agent", templateName: "线索发现" },
      { id: "漏洞论证模板", kind: "agent", templateName: "漏洞论证模板" },
      { id: "漏洞挑战模板", kind: "agent", templateName: "漏洞挑战模板" },
      { id: "Summary模板", kind: "agent", templateName: "Summary模板" },
      { id: "疑点辩论工厂", kind: "spawn", templateName: "漏洞论证模板", spawnRuleId: "finding-debate" },
    ],
    edges: [],
    spawnRules: [
      {
        id: "finding-debate",
        spawnNodeName: "疑点辩论工厂",
        sourceTemplateName: "线索发现",
        entryRole: "pro",
        spawnedAgents: [
          { role: "pro", templateName: "漏洞论证模板" },
          { role: "con", templateName: "漏洞挑战模板" },
          { role: "summary", templateName: "Summary模板" },
        ],
        edges: [
          { sourceRole: "pro", targetRole: "con", trigger: "<continue>", maxTriggerRounds: 4, messageMode: "last" },
          { sourceRole: "con", targetRole: "pro", trigger: "<continue>", maxTriggerRounds: 4, messageMode: "last" },
          { sourceRole: "pro", targetRole: "summary", trigger: "<complete>", messageMode: "last" },
          { sourceRole: "con", targetRole: "summary", trigger: "<complete>", messageMode: "last" },
        ],
        exitWhen: "one_side_agrees",
        reportToTemplateName: "线索发现",
        reportToTrigger: "<default>",
      },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-spawn-router",
    topology,
  });

  const decision = createUserDispatchDecision(state, {
    targetAgentId: "疑点辩论工厂",
    content: "发现上传文件名被直接拼到目标路径。",
  });

  assert.equal(decision.type, "execute_batch");
  assert.deepEqual(
    decision.batch.jobs.map((job) => job.agentId),
    ["漏洞论证模板-1"],
  );
  assert.equal(state.spawnBundles.length, 1);
  assert.equal(
    state.runtimeNodes.some((node) => node.id === "漏洞挑战模板-1"),
    true,
  );
});

test("自动 handoff 命中 spawn 节点时，会实例化动态团队并派发入口角色，而不是停在 spawn 模板节点", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
    nodeRecords: [
      { id: "Build", kind: "agent", templateName: "Build" },
      { id: "UnitTest", kind: "spawn", templateName: "UnitTest", spawnRuleId: "spawn-rule:UnitTest", spawnEnabled: true },
      { id: "TaskReview", kind: "spawn", templateName: "TaskReview", spawnRuleId: "spawn-rule:TaskReview", spawnEnabled: true },
      { id: "CodeReview", kind: "spawn", templateName: "CodeReview", spawnRuleId: "spawn-rule:CodeReview", spawnEnabled: true },
    ],
    edges: [
      { source: "Build", target: "UnitTest", trigger: "<default>", messageMode: "last" },
      { source: "Build", target: "TaskReview", trigger: "<default>", messageMode: "last" },
      { source: "Build", target: "CodeReview", trigger: "<default>", messageMode: "last" },
    ],
    spawnRules: [
      {
        id: "spawn-rule:UnitTest",
        spawnNodeName: "UnitTest",
        sourceTemplateName: "Build",
        entryRole: "entry",
        spawnedAgents: [{ role: "entry", templateName: "UnitTest" }],
        edges: [],
        exitWhen: "one_side_agrees",
        reportToTemplateName: "Build",
        reportToTrigger: "<default>",
      },
      {
        id: "spawn-rule:TaskReview",
        spawnNodeName: "TaskReview",
        sourceTemplateName: "Build",
        entryRole: "entry",
        spawnedAgents: [{ role: "entry", templateName: "TaskReview" }],
        edges: [],
        exitWhen: "one_side_agrees",
        reportToTemplateName: "Build",
        reportToTrigger: "<default>",
      },
      {
        id: "spawn-rule:CodeReview",
        spawnNodeName: "CodeReview",
        sourceTemplateName: "Build",
        entryRole: "entry",
        spawnedAgents: [{ role: "entry", templateName: "CodeReview" }],
        edges: [],
        exitWhen: "one_side_agrees",
        reportToTemplateName: "Build",
        reportToTrigger: "<default>",
      },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-auto-spawn-router",
    topology,
  });

  const afterBuild = applyResult(state, {
    agentId: "Build",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "Build 已完成",
    opinion: "",
    signalDone: false,
  });

  assert.equal(afterBuild.decision.type, "execute_batch");
  assert.deepEqual(
    afterBuild.decision.batch.jobs.map((job) => job.agentId),
    [
      "UnitTest-1",
      "TaskReview-1",
      "CodeReview-1",
    ],
  );
  assert.equal(afterBuild.state.spawnBundles.length, 3);
});

test("线索发现没有 finding 并命中结束 trigger 时，会先转给线索完备性评估而不是继续触发 spawn decisionAgent", () => {
  const topology = createBuiltinVulnerabilityTopology();
  const state = createGraphTaskState({
    taskId: "task-vulnerability-no-findings",
    topology,
  });

  const afterTriage = applyResult(state, {
    agentId: "线索发现",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<complete>",
    agentStatus: "completed",
    agentContextContent: "本轮没有发现新的可疑点。",
    opinion: "",
    signalDone: false,
  });

  assert.equal(afterTriage.decision.type, "execute_batch");
  assert.deepEqual(afterTriage.decision.batch.jobs.map((job) => job.agentId), ["线索完备性评估"]);
  assert.equal(afterTriage.state.spawnBundles.length, 0);
});

test("线索发现存在 finding 且未发出 TASK_DONE 时，会按条件分支继续触发 spawn decisionAgent", () => {
  const topology = createBuiltinVulnerabilityTopology();
  const state = createGraphTaskState({
    taskId: "task-vulnerability-has-finding",
    topology,
  });

  const afterTriage = applyResult(state, {
    agentId: "线索发现",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<continue>",
    agentStatus: "action_required",
    agentContextContent: "发现一个新的可疑点：上传文件名可能被直接拼接到落盘路径。",
    opinion: "",
    signalDone: false,
  });

  assert.equal(afterTriage.decision.type, "execute_batch");
  assert.deepEqual(afterTriage.decision.batch.jobs.map((job) => job.agentId), ["漏洞挑战-1"]);
});

test("漏洞团队里漏洞挑战首轮直接命中结束 trigger 时，会继续派发到漏洞论证而不是结束任务", () => {
  const topology = createBuiltinVulnerabilityTopology();
  const state = createGraphTaskState({
    taskId: "task-vulnerability-challenge-complete-needs-argument",
    topology,
  });

  const afterTriage = applyResult(state, {
    agentId: "线索发现",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<continue>",
    agentStatus: "action_required",
    agentContextContent: "发现一个新的可疑点。",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterTriage.decision.type, "execute_batch");
  assert.deepEqual(afterTriage.decision.batch.jobs.map((job) => job.agentId), ["漏洞挑战-1"]);

  const afterChallenge = applyResult(afterTriage.state, {
    agentId: "漏洞挑战-1",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<complete>",
    agentStatus: "completed",
    agentContextContent: "当前材料已经足够，可以进入总结。",
    opinion: "",
    signalDone: false,
  });

  assert.equal(afterChallenge.decision.type, "execute_batch");
  assert.equal(afterChallenge.decision.batch.sourceAgentId, "漏洞挑战-1");
  assert.deepEqual(afterChallenge.decision.batch.jobs.map((job) => ({
    agentId: job.agentId,
    sourceAgentId: "sourceAgentId" in job ? job.sourceAgentId : null,
    sourceMessageId: "sourceMessageId" in job ? job.sourceMessageId : null,
    sourceContent: "sourceContent" in job ? job.sourceContent : null,
    displayContent: "displayContent" in job ? job.displayContent : null,
    kind: job.kind,
  })), [
    {
      agentId: "漏洞论证-1",
      sourceAgentId: "漏洞挑战-1",
      sourceMessageId: "message:漏洞挑战-1",
      sourceContent: "当前材料已经足够，可以进入总结。",
      displayContent: "当前材料已经足够，可以进入总结。",
      kind: "action_required_request",
    },
  ]);
});

test("__end__ 带 trigger 时，不匹配的判定结论不能直接结束", () => {
  const topology = createBuiltinVulnerabilityTopology();
  const state = createGraphTaskState({
    taskId: "task-vulnerability-end-trigger-mismatch",
    topology,
  });

  const afterTriage = applyResult(state, {
    agentId: "线索发现",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<continue>",
    agentStatus: "action_required",
    agentContextContent: "发现一个新的可疑点。",
    opinion: "",
    signalDone: true,
  });

  assert.equal(afterTriage.decision.type, "execute_batch");
  assert.deepEqual(afterTriage.decision.batch.jobs.map((job) => job.agentId), ["漏洞挑战-1"]);
});

test("自定义结束 trigger 命中 __end__ 时必须直接给出 end_edge_triggered", () => {
  const state = createGraphTaskState({
    taskId: "task-custom-end-trigger",
    topology: {
      nodes: ["Reviewer"],
      edges: [],
      langgraph: {
        start: {
          id: "__start__",
          targets: ["Reviewer"],
        },
        end: {
          id: "__end__",
          sources: ["Reviewer"],
          incoming: [{ source: "Reviewer", trigger: "<done>" }],
        },
      },
    },
  });

  const afterReview = applyResult(state, {
    agentId: "Reviewer",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<done>",
    agentStatus: "completed",
    agentContextContent: "已经可以结束。",
    opinion: "当前任务可以结束。",
    signalDone: false,
  });

  assert.equal(afterReview.decision.type, "finished");
  assert.equal(afterReview.decision.finishReason, "end_edge_triggered");
});

test("spawn 展开后，handoff 批次会把待响应目标同步成运行时实例 id，而不是残留静态 spawn 节点", () => {
  const topology: TopologyRecord = {
    nodes: ["线索发现", "辩论", "漏洞论证", "讨论总结"],
    nodeRecords: [
      { id: "线索发现", kind: "agent", templateName: "线索发现" },
      { id: "辩论", kind: "spawn", templateName: "辩论", spawnRuleId: "spawn-rule:辩论", spawnEnabled: true },
      { id: "漏洞论证", kind: "agent", templateName: "漏洞论证" },
      { id: "讨论总结", kind: "agent", templateName: "讨论总结" },
    ],
    edges: [
      { source: "线索发现", target: "辩论", trigger: "<default>", messageMode: "last" },
      { source: "辩论", target: "线索发现", trigger: "<default>", messageMode: "last" },
    ],
    spawnRules: [
      {
        id: "spawn-rule:辩论",
        spawnNodeName: "辩论",
        entryRole: "漏洞论证",
        spawnedAgents: [
          { role: "漏洞论证", templateName: "漏洞论证" },
          { role: "讨论总结", templateName: "讨论总结" },
        ],
        edges: [
          { sourceRole: "漏洞论证", targetRole: "讨论总结", trigger: "<complete>", messageMode: "last" },
        ],
        exitWhen: "all_completed",
        reportToTemplateName: "线索发现",
        reportToTrigger: "<default>",
      },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-spawn-batch-runtime-targets",
    topology,
  });

  const afterTriage = applyResult(state, {
    agentId: "线索发现",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "发现一个可疑点：上传文件名被直接拼进目标路径",
    opinion: "",
    signalDone: false,
  });

  assert.equal(afterTriage.decision.type, "execute_batch");
  assert.deepEqual(afterTriage.state.activeHandoffBatchBySource["线索发现"]?.targets, [
    "漏洞论证-1",
  ]);
  assert.deepEqual(afterTriage.state.activeHandoffBatchBySource["线索发现"]?.pendingTargets, [
    "漏洞论证-1",
  ]);
});

test("spawn 子图全部完成后，会把 spawn 节点视为完成并按普通 handoff 边继续流转", () => {
  const topology: TopologyRecord = {
    nodes: ["线索发现", "辩论", "漏洞论证", "讨论总结"],
    nodeRecords: [
      { id: "线索发现", kind: "agent", templateName: "线索发现" },
      { id: "辩论", kind: "spawn", templateName: "辩论", spawnRuleId: "spawn-rule:辩论", spawnEnabled: true },
      { id: "漏洞论证", kind: "agent", templateName: "漏洞论证" },
      { id: "讨论总结", kind: "agent", templateName: "讨论总结" },
    ],
    edges: [
      { source: "线索发现", target: "辩论", trigger: "<default>", messageMode: "last" },
      { source: "辩论", target: "线索发现", trigger: "<default>", messageMode: "last" },
    ],
    spawnRules: [
      {
        id: "spawn-rule:辩论",
        spawnNodeName: "辩论",
        sourceTemplateName: "线索发现",
        entryRole: "漏洞论证",
        spawnedAgents: [
          { role: "漏洞论证", templateName: "漏洞论证" },
          { role: "讨论总结", templateName: "讨论总结" },
        ],
        edges: [
          { sourceRole: "漏洞论证", targetRole: "讨论总结", trigger: "<complete>", messageMode: "last" },
        ],
        exitWhen: "all_completed",
        reportToTemplateName: "线索发现",
        reportToTrigger: "<default>",
      },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-spawn-complete",
    topology,
  });

  const afterTriage = applyResult(state, {
    agentId: "线索发现",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "路径穿越",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterTriage.decision.type, "execute_batch");
  assert.deepEqual(afterTriage.decision.batch.jobs.map((job) => job.agentId), [
    "漏洞论证-1",
  ]);

  const afterPro = applyResult(afterTriage.state, {
    agentId: "漏洞论证-1",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<complete>",
    agentStatus: "completed",
    agentContextContent: "漏洞论证认为漏洞成立",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterPro.decision.type, "execute_batch");
  assert.deepEqual(afterPro.decision.batch.jobs.map((job) => job.agentId), [
    "讨论总结-1",
  ]);

  const afterSummary = applyResult(afterPro.state, {
    agentId: "讨论总结-1",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "裁决：漏洞成立",
    opinion: "",
    signalDone: false,
  });

  assert.equal(afterSummary.decision.type, "execute_batch");
  assert.equal(afterSummary.decision.batch.sourceAgentId, "讨论总结-1");
  assert.deepEqual(afterSummary.decision.batch.jobs.map((job) => job.agentId), ["线索发现"]);
});

test("all_completed 特殊补发会按 trigger 精确挑选匹配目标", () => {
  const topology: TopologyRecord = {
    nodes: ["线索发现", "辩论", "漏洞论证", "漏洞挑战", "证据补查", "总结甲", "总结乙"],
    nodeRecords: [
      { id: "线索发现", kind: "agent", templateName: "线索发现" },
      { id: "辩论", kind: "spawn", templateName: "辩论", spawnRuleId: "spawn-rule:辩论", spawnEnabled: true },
      { id: "漏洞论证", kind: "agent", templateName: "漏洞论证" },
      { id: "漏洞挑战", kind: "agent", templateName: "漏洞挑战" },
      { id: "证据补查", kind: "agent", templateName: "证据补查" },
      { id: "总结甲", kind: "agent", templateName: "总结甲" },
      { id: "总结乙", kind: "agent", templateName: "总结乙" },
    ],
    edges: [
      { source: "线索发现", target: "辩论", trigger: "<default>", messageMode: "last" },
    ],
    spawnRules: [
      {
        id: "spawn-rule:辩论",
        spawnNodeName: "辩论",
        sourceTemplateName: "线索发现",
        entryRole: "pro",
        spawnedAgents: [
          { role: "pro", templateName: "漏洞论证" },
          { role: "con", templateName: "漏洞挑战" },
          { role: "research", templateName: "证据补查" },
          { role: "summary-a", templateName: "总结甲" },
          { role: "summary-b", templateName: "总结乙" },
        ],
        edges: [
          { sourceRole: "pro", targetRole: "con", trigger: "<approve>", messageMode: "last" },
          { sourceRole: "pro", targetRole: "research", trigger: "<revise>", messageMode: "last" },
          { sourceRole: "pro", targetRole: "summary-a", trigger: "<approve>", messageMode: "last" },
          { sourceRole: "con", targetRole: "summary-a", trigger: "<approve>", messageMode: "last" },
          { sourceRole: "pro", targetRole: "summary-b", trigger: "<revise>", messageMode: "last" },
          { sourceRole: "research", targetRole: "summary-b", trigger: "<revise>", messageMode: "last" },
        ],
        exitWhen: "all_completed",
      },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-all-completed-trigger",
    topology,
  });

  const afterDiscovery = applyResult(state, {
    agentId: "线索发现",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "疑点 1",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterDiscovery.decision.type, "execute_batch");
  assert.deepEqual(afterDiscovery.decision.batch.jobs.map((job) => job.agentId), ["漏洞论证-1"]);

  const afterArgument = applyResult(afterDiscovery.state, {
    agentId: "漏洞论证-1",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<approve>",
    agentStatus: "action_required",
    agentContextContent: "漏洞论证认为可以进入总结甲",
    opinion: "请漏洞挑战补齐同意或反驳意见。",
    signalDone: false,
  });

  assert.equal(afterArgument.decision.type, "execute_batch");
  assert.equal(afterArgument.decision.batch.sourceAgentId, "漏洞论证-1");
  assert.equal(afterArgument.decision.batch.trigger, "<approve>");
  assert.deepEqual(afterArgument.decision.batch.jobs.map((job) => job.agentId), ["漏洞挑战-1"]);
});

test("all_completed 特殊补发会按自定义结束 trigger 继续派发等待中的对弈目标", () => {
  const topology: TopologyRecord = {
    nodes: ["线索发现", "辩论", "漏洞论证", "漏洞挑战", "总结甲"],
    nodeRecords: [
      { id: "线索发现", kind: "agent", templateName: "线索发现" },
      { id: "辩论", kind: "spawn", templateName: "辩论", spawnRuleId: "spawn-rule:辩论", spawnEnabled: true },
      { id: "漏洞论证", kind: "agent", templateName: "漏洞论证" },
      { id: "漏洞挑战", kind: "agent", templateName: "漏洞挑战" },
      { id: "总结甲", kind: "agent", templateName: "总结甲" },
    ],
    edges: [
      { source: "线索发现", target: "辩论", trigger: "<default>", messageMode: "last" },
    ],
    spawnRules: [
      {
        id: "spawn-rule:辩论",
        spawnNodeName: "辩论",
        sourceTemplateName: "线索发现",
        entryRole: "pro",
        spawnedAgents: [
          { role: "pro", templateName: "漏洞论证" },
          { role: "con", templateName: "漏洞挑战" },
          { role: "summary-a", templateName: "总结甲" },
        ],
        edges: [
          { sourceRole: "pro", targetRole: "con", trigger: "<approve>", messageMode: "last" },
          { sourceRole: "pro", targetRole: "summary-a", trigger: "<approve>", messageMode: "last" },
          { sourceRole: "con", targetRole: "summary-a", trigger: "<approve>", messageMode: "last" },
        ],
        exitWhen: "all_completed",
      },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-all-completed-custom-complete-trigger",
    topology,
  });

  const afterDiscovery = applyResult(state, {
    agentId: "线索发现",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "疑点 1",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterDiscovery.decision.type, "execute_batch");
  assert.deepEqual(afterDiscovery.decision.batch.jobs.map((job) => job.agentId), ["漏洞论证-1"]);

  const afterArgument = applyResult(afterDiscovery.state, {
    agentId: "漏洞论证-1",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<approve>",
    agentStatus: "completed",
    agentContextContent: "漏洞论证认为已经可以推进到总结阶段。",
    opinion: "请漏洞挑战补齐最终意见。",
    signalDone: false,
  });

  assert.equal(afterArgument.decision.type, "execute_batch");
  assert.equal(afterArgument.decision.batch.sourceAgentId, "漏洞论证-1");
  assert.equal(afterArgument.decision.batch.trigger, "<approve>");
  assert.deepEqual(afterArgument.decision.batch.jobs.map((job) => job.agentId), ["漏洞挑战-1"]);
});

test("裁决直接回流到外层节点时，也会同步把 spawn 激活标记完成，避免后续卡住", () => {
  const topology: TopologyRecord = {
    nodes: ["线索发现", "辩论", "漏洞论证", "讨论总结"],
    nodeRecords: [
      { id: "线索发现", kind: "agent", templateName: "线索发现" },
      { id: "辩论", kind: "spawn", templateName: "辩论", spawnRuleId: "spawn-rule:辩论", spawnEnabled: true },
      { id: "漏洞论证", kind: "agent", templateName: "漏洞论证" },
      { id: "讨论总结", kind: "agent", templateName: "讨论总结" },
    ],
    edges: [
      { source: "线索发现", target: "辩论", trigger: "<default>", messageMode: "last" },
    ],
    spawnRules: [
      {
        id: "spawn-rule:辩论",
        spawnNodeName: "辩论",
        entryRole: "漏洞论证",
        spawnedAgents: [
          { role: "漏洞论证", templateName: "漏洞论证" },
          { role: "讨论总结", templateName: "讨论总结" },
        ],
        edges: [
          { sourceRole: "漏洞论证", targetRole: "讨论总结", trigger: "<complete>", messageMode: "last" },
        ],
        exitWhen: "all_completed",
        reportToTemplateName: "线索发现",
        reportToTrigger: "<default>",
      },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-spawn-summary-report",
    topology,
  });

  const afterTriage = applyResult(state, {
    agentId: "线索发现",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "发现一个可疑点：上传文件名被拼接到目标路径",
    opinion: "",
    signalDone: false,
  });

  const afterPro = applyResult(afterTriage.state, {
    agentId: "漏洞论证-1",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<complete>",
    agentStatus: "completed",
    agentContextContent: "漏洞论证认为需要交给裁决",
    opinion: "",
    signalDone: false,
  });

  const afterSummary = applyResult(afterPro.state, {
    agentId: "讨论总结-1",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "裁决：该点讨论完毕，回到线索发现继续下一个 finding",
    opinion: "",
    signalDone: false,
  });

  assert.equal(afterSummary.decision.type, "execute_batch");
  assert.equal(afterSummary.decision.batch.sourceAgentId, "讨论总结-1");
  assert.deepEqual(afterSummary.decision.batch.jobs.map((job) => job.agentId), ["线索发现"]);
  assert.equal(afterSummary.state.spawnActivations[0]?.dispatched, true);
  assert.equal(afterSummary.state.agentStatusesByName["辩论"], "completed");
});

test("单条 finding 的 spawn 通过 report 回外层时，会在总结完成后标记 activation 完成", () => {
  const topology: TopologyRecord = {
    nodes: ["辩论", "归档"],
    nodeRecords: [
      { id: "辩论", kind: "spawn", templateName: "辩论", spawnRuleId: "spawn-rule:辩论" },
      { id: "归档", kind: "agent", templateName: "归档" },
    ],
    edges: [
      { source: "辩论", target: "归档", trigger: "<default>", messageMode: "last" },
    ],
    spawnRules: [
      {
        id: "spawn-rule:辩论",
        spawnNodeName: "辩论",
        entryRole: "summary",
        spawnedAgents: [
          { role: "summary", templateName: "讨论总结" },
        ],
        edges: [],
        exitWhen: "all_completed",
        reportToTemplateName: "归档",
        reportToTrigger: "<default>",
      },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-single-item-spawn-report",
    topology,
  });

  const start = createUserDispatchDecision(state, {
    targetAgentId: "辩论",
    content: "finding-1",
  });
  assert.equal(start.type, "execute_batch");
  assert.deepEqual(start.batch.jobs.map((job) => job.agentId), ["讨论总结-1"]);

  const afterSummary = applyResult(state, {
    agentId: "讨论总结-1",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "第一个 finding 已总结完成",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterSummary.decision.type, "execute_batch");
  assert.deepEqual(afterSummary.decision.batch.jobs.map((job) => job.agentId), ["归档"]);
  assert.equal(afterSummary.state.spawnActivations[0]?.dispatched, true);
});

test("漏洞团队第一轮讨论总结回到线索发现后，第二轮 finding 不会继续派发上一轮的漏洞挑战实例", () => {
  const topology = createBuiltinVulnerabilityTopology();
  const state = createGraphTaskState({
    taskId: "task-vulnerability-team-stale-runtime-decisionAgent",
    topology,
  });

  const afterFirstFinding = applyResult(state, {
    agentId: "线索发现",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<continue>",
    agentStatus: "action_required",
    agentContextContent: "第 1 个 finding",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterFirstFinding.decision.type, "execute_batch");
  assert.deepEqual(afterFirstFinding.decision.batch.jobs.map((job) => job.agentId), ["漏洞挑战-1"]);

  const afterChallenge = applyResult(afterFirstFinding.state, {
    agentId: "漏洞挑战-1",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<continue>",
    agentStatus: "action_required",
    agentContextContent: "当前材料仍需漏洞论证继续补证",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterChallenge.decision.type, "execute_batch");
  assert.deepEqual(afterChallenge.decision.batch.jobs.map((job) => job.agentId), ["漏洞论证-1"]);

  const afterArgument = applyResult(afterChallenge.state, {
    agentId: "漏洞论证-1",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<complete>",
    agentStatus: "completed",
    agentContextContent: "当前材料已经足够，进入讨论总结",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterArgument.decision.type, "execute_batch");
  assert.deepEqual(afterArgument.decision.batch.jobs.map((job) => job.agentId), ["讨论总结-1"]);

  const afterSummary = applyResult(afterArgument.state, {
    agentId: "讨论总结-1",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "当前这条更像真实漏洞，回到线索发现继续挖掘",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterSummary.decision.type, "execute_batch");
  assert.deepEqual(afterSummary.decision.batch.jobs.map((job) => job.agentId), ["线索发现"]);
  assert.equal(afterSummary.state.spawnActivations[0]?.dispatched, true);

  const afterSecondFinding = applyResult(afterSummary.state, {
    agentId: "线索发现",
    status: "completed",
    decisionAgent: true,
    routingKind: "labeled",
    trigger: "<continue>",
    agentStatus: "action_required",
    agentContextContent: "第 2 个 finding",
    opinion: "",
    signalDone: false,
  });

  assert.equal(afterSecondFinding.decision.type, "execute_batch");
  assert.deepEqual(afterSecondFinding.decision.batch.jobs.map((job) => job.agentId), ["漏洞挑战-2"]);
});

test("最后一个叶子节点完成后，router 会直接判定 finished，而不是错误停在旧的暂停语义", () => {
  const topology: TopologyRecord = {
    nodes: ["BA", "Build", "QA"],
    edges: [
      { source: "BA", target: "Build", trigger: "<default>", messageMode: "last" },
      { source: "Build", target: "QA", trigger: "<default>", messageMode: "last" },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-finish-leaf",
    topology,
  });

  const afterBa = applyResult(state, {
    agentId: "BA",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "需求已澄清",
    opinion: "",
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
    agentContextContent: "实现已完成",
    opinion: "",
    signalDone: false,
  });
  assert.equal(afterBuild.decision.type, "execute_batch");
  assert.deepEqual(afterBuild.decision.batch.jobs.map((job) => job.agentId), ["QA"]);

  const afterQa = applyResult(afterBuild.state, {
    agentId: "QA",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "验证已完成",
    opinion: "",
    signalDone: false,
  });
  assert.deepEqual(afterQa.decision, {
    type: "finished",
    finishReason: "all_agents_completed",
  });
});

test("单一路径上游完成后，router 会继续派发下一个 handoff 下游，而不是错误提前结束本轮", () => {
  const topology: TopologyRecord = {
    nodes: ["BA", "Build", "QA"],
    edges: [
      { source: "BA", target: "Build", trigger: "<default>", messageMode: "last" },
      { source: "Build", target: "QA", trigger: "<default>", messageMode: "last" },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-simple-chain",
    topology,
  });

  const afterBa = applyResult(state, {
    agentId: "BA",
    status: "completed",
    decisionAgent: false,
    routingKind: "default",
    agentStatus: "completed",
    agentContextContent: "需求已澄清",
    opinion: "",
    signalDone: false,
  });

  assert.equal(afterBa.decision.type, "execute_batch");
  assert.deepEqual(afterBa.decision.batch.jobs.map((job) => job.agentId), ["Build"]);
});
