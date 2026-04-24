import assert from "node:assert/strict";
import test from "node:test";

import type { TopologyRecord } from "@shared/types";

import {
  applyAgentResultToGraphState,
  createGraphTaskState,
  createUserDispatchDecision,
  resolveRestrictedRepairTargetsForSource,
} from "./gating-router";
import { resolveExecutionReviewAgent } from "./review-agent-context";

function createTopology(): TopologyRecord {
  return {
    nodes: ["BA", "Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      { source: "BA", target: "Build", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "CodeReview", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
      { source: "CodeReview", target: "Build", triggerOn: "continue", messageMode: "last" },
      { source: "CodeReview", target: "TaskReview", triggerOn: "complete", messageMode: "last" },
    ],
  };
}

test("resolveExecutionReviewAgent 会把 spawn 子图里带 complete 出边的运行时实例识别为 review agent", () => {
  const topology: TopologyRecord = {
    nodes: ["线索发现", "疑点辩论", "漏洞论证", "讨论总结"],
    nodeRecords: [
      { id: "线索发现", kind: "agent", templateName: "线索发现" },
      { id: "疑点辩论", kind: "spawn", templateName: "疑点辩论", spawnRuleId: "spawn-rule:疑点辩论" },
      { id: "漏洞论证", kind: "agent", templateName: "漏洞论证" },
      { id: "讨论总结", kind: "agent", templateName: "讨论总结" },
    ],
    edges: [
      { source: "线索发现", target: "疑点辩论", triggerOn: "transfer", messageMode: "last" },
      { source: "疑点辩论", target: "线索发现", triggerOn: "transfer", messageMode: "last" },
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
          { sourceRole: "漏洞论证", targetRole: "讨论总结", triggerOn: "complete", messageMode: "last" },
        ],
        exitWhen: "all_completed",
        reportToTemplateName: "线索发现",
        reportToTriggerOn: "transfer",
      },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-review-agent-context",
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
      triggerOn: "complete",
      messageMode: "last",
    },
  ];

  assert.equal(
    resolveExecutionReviewAgent({
      state,
      topology,
      runtimeAgentId: "漏洞论证-1",
      executableAgentId: "漏洞论证",
    }),
    true,
  );
});

test("resolveRestrictedRepairTargetsForSource 只会保留 source 的直接 handoff reviewer", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "UnitTest", "CodeReview", "TaskReview"],
    edges: [
      { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
      { source: "UnitTest", target: "CodeReview", triggerOn: "complete", messageMode: "last" },
      { source: "CodeReview", target: "Build", triggerOn: "continue", messageMode: "last" },
      { source: "CodeReview", target: "TaskReview", triggerOn: "complete", messageMode: "last" },
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

test("resolveExecutionReviewAgent 不会把没有 complete 或 continue 出边的普通 agent 误判为 review agent", () => {
  const topology: TopologyRecord = {
    nodes: ["线索发现", "疑点辩论"],
    edges: [
      { source: "线索发现", target: "疑点辩论", triggerOn: "transfer", messageMode: "last" },
    ],
  };

  assert.equal(
    resolveExecutionReviewAgent({
      state: null,
      topology,
      runtimeAgentId: "线索发现",
      executableAgentId: "线索发现",
    }),
    false,
  );
});

test("resolveExecutionReviewAgent 会把仅通过 __end__ 暴露 complete 分支的节点识别为 review agent", () => {
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
          { source: "线索发现", triggerOn: "complete" },
        ],
      },
    },
  };

  assert.equal(
    resolveExecutionReviewAgent({
      state: null,
      topology,
      runtimeAgentId: "线索发现",
      executableAgentId: "线索发现",
    }),
    true,
  );
});

test("router 会保留 CodeReview 嵌套链路可先于外层 handoff 批次剩余 reviewer 继续推进的旧语义", () => {
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

  const afterBa = applyAgentResultToGraphState(state, {
    agentId: "BA",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: "需求已澄清",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterBa.decision.type, "execute_batch");
  assert.deepEqual(afterBa.decision.batch.jobs.map((job) => job.agentId), ["Build"]);

  const afterBuildFirst = applyAgentResultToGraphState(afterBa.state, {
    agentId: "Build",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: "Build 首轮已完成",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterBuildFirst.decision.type, "execute_batch");
  assert.deepEqual(
    afterBuildFirst.decision.batch.jobs.map((job) => job.agentId),
    ["CodeReview", "UnitTest"],
  );

  const afterApproved = applyAgentResultToGraphState(afterBuildFirst.state, {
    agentId: "CodeReview",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: "CodeReview 已通过",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterApproved.decision.type, "execute_batch");
  assert.deepEqual(afterApproved.decision.batch.jobs.map((job) => job.agentId), ["TaskReview"]);

  const afterTaskReview = applyAgentResultToGraphState(afterApproved.state, {
    agentId: "TaskReview",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: "TaskReview 已收到最新结果",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.deepEqual(afterTaskReview.decision, {
    type: "waiting",
    waitingReason: "no_runnable_agents",
  });

  const afterUnitTest = applyAgentResultToGraphState(afterTaskReview.state, {
    agentId: "UnitTest",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: "UnitTest 已收到最新结果",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.deepEqual(afterUnitTest.decision, {
    type: "finished",
  });
});

test("CodeReview 通过 UnitTest 间接回流 Build 后，Build 下一轮仍会重新派发直接 handoff reviewer", () => {
  const topology: TopologyRecord = {
    nodes: ["BA", "Build", "UnitTest", "CodeReview", "TaskReview"],
    edges: [
      { source: "BA", target: "Build", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
      { source: "UnitTest", target: "Build", triggerOn: "continue", messageMode: "last" },
      { source: "UnitTest", target: "CodeReview", triggerOn: "complete", messageMode: "last" },
      { source: "CodeReview", target: "Build", triggerOn: "continue", messageMode: "last" },
      { source: "CodeReview", target: "TaskReview", triggerOn: "complete", messageMode: "last" },
      { source: "TaskReview", target: "Build", triggerOn: "continue", messageMode: "last" },
    ],
  };
  const baseResult = {
    status: "completed" as const,
    agentStatus: "completed" as const,
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  };

  const startState = createGraphTaskState({
    taskId: "nested-review-back-to-build",
    topology,
  });
  const afterBa = applyAgentResultToGraphState(startState, {
    agentId: "BA",
    reviewAgent: false,
    reviewDecision: "complete",
    agentContextContent: "BA 已整理需求",
    ...baseResult,
  });
  const afterBuild1 = applyAgentResultToGraphState(afterBa.state, {
    agentId: "Build",
    reviewAgent: false,
    reviewDecision: "complete",
    agentContextContent: "Build 第 1 次构建完成",
    ...baseResult,
  });
  const afterUnitTestFail1 = applyAgentResultToGraphState(afterBuild1.state, {
    agentId: "UnitTest",
    reviewAgent: true,
    reviewDecision: "continue",
    agentContextContent: "UnitTest 第 1 轮未通过",
    ...baseResult,
  });
  const afterBuild2 = applyAgentResultToGraphState(afterUnitTestFail1.state, {
    agentId: "Build",
    reviewAgent: false,
    reviewDecision: "complete",
    agentContextContent: "Build 第 2 次构建完成",
    ...baseResult,
  });
  const afterUnitTestPass2 = applyAgentResultToGraphState(afterBuild2.state, {
    agentId: "UnitTest",
    reviewAgent: true,
    reviewDecision: "complete",
    agentContextContent: "UnitTest 第 2 轮通过",
    ...baseResult,
  });
  const afterCodeReviewFail = applyAgentResultToGraphState(afterUnitTestPass2.state, {
    agentId: "CodeReview",
    reviewAgent: true,
    reviewDecision: "continue",
    agentContextContent: "CodeReview 未通过",
    ...baseResult,
  });

  assert.equal(afterCodeReviewFail.decision.type, "execute_batch");
  assert.deepEqual(afterCodeReviewFail.decision.batch.jobs.map((job) => job.agentId), ["Build"]);

  const afterBuild3 = applyAgentResultToGraphState(afterCodeReviewFail.state, {
    agentId: "Build",
    reviewAgent: false,
    reviewDecision: "complete",
    agentContextContent: "Build 第 3 次构建完成",
    ...baseResult,
  });

  assert.equal(afterBuild3.decision.type, "execute_batch");
  assert.deepEqual(afterBuild3.decision.batch.jobs.map((job) => job.agentId), ["UnitTest"]);
});

test("router 会在并发 reviewer 未收齐前保持等待，不会提前回流", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
    edges: [
      { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "CodeReview", triggerOn: "transfer", messageMode: "last" },
      { source: "UnitTest", target: "Build", triggerOn: "continue", messageMode: "last" },
      { source: "TaskReview", target: "Build", triggerOn: "continue", messageMode: "last" },
      { source: "CodeReview", target: "Build", triggerOn: "continue", messageMode: "last" },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-2",
    topology,
  });

  const afterBuild = applyAgentResultToGraphState(state, {
    agentId: "Build",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: "Build 已完成",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterBuild.decision.type, "execute_batch");
  assert.deepEqual(
    afterBuild.decision.batch.jobs.map((job) => job.agentId),
    ["UnitTest", "TaskReview", "CodeReview"],
  );

  const afterUnitTestFail = applyAgentResultToGraphState(afterBuild.state, {
    agentId: "UnitTest",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "continue",
    agentStatus: "continue",
    agentContextContent: "UnitTest 未通过",
    opinion: "请修复单测问题",
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.deepEqual(afterUnitTestFail.decision, {
    type: "waiting",
    waitingReason: "wait_pending_reviewers",
  });
});

test("并发 reviewer 中单条回流链路超限时，不应提前打断其他 reviewer", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "UnitTest", "TaskReview", "CodeReview", "Judge"],
    edges: [
      { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "CodeReview", triggerOn: "transfer", messageMode: "last" },
      { source: "UnitTest", target: "Build", triggerOn: "continue", maxRevisionRounds: 1, messageMode: "last" },
      { source: "UnitTest", target: "Judge", triggerOn: "complete", messageMode: "last" },
      { source: "TaskReview", target: "Build", triggerOn: "continue", messageMode: "last" },
      { source: "CodeReview", target: "Build", triggerOn: "continue", messageMode: "last" },
    ],
  };
  let state = createGraphTaskState({
    taskId: "task-parallel-loop-isolation",
    topology,
  });

  const afterBuildRound1 = applyAgentResultToGraphState(state, {
    agentId: "Build",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: "Build 第 1 轮已完成",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterBuildRound1.decision.type, "execute_batch");
  assert.deepEqual(
    afterBuildRound1.decision.batch.jobs.map((job) => job.agentId),
    ["UnitTest", "TaskReview", "CodeReview"],
  );

  const afterTaskReviewApproved = applyAgentResultToGraphState(afterBuildRound1.state, {
    agentId: "TaskReview",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: "TaskReview 通过",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterTaskReviewApproved.decision.type, "waiting");

  const afterCodeReviewActionRequired = applyAgentResultToGraphState(afterTaskReviewApproved.state, {
    agentId: "CodeReview",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "continue",
    agentStatus: "continue",
    agentContextContent: "CodeReview 第 1 轮未通过",
    opinion: "请修复 CodeReview 第 1 轮问题",
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterCodeReviewActionRequired.decision.type, "waiting");

  const afterUnitTestActionRequiredRound1 = applyAgentResultToGraphState(afterCodeReviewActionRequired.state, {
    agentId: "UnitTest",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "continue",
    agentStatus: "continue",
    agentContextContent: "UnitTest 第 1 轮未通过",
    opinion: "请修复 UnitTest 第 1 轮问题",
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterUnitTestActionRequiredRound1.decision.type, "execute_batch");
  assert.deepEqual(afterUnitTestActionRequiredRound1.decision.batch.jobs.map((job) => job.agentId), ["Build"]);
  state = afterUnitTestActionRequiredRound1.state;

  const afterBuildRound2 = applyAgentResultToGraphState(state, {
    agentId: "Build",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: "Build 第 2 轮已完成",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterBuildRound2.decision.type, "execute_batch");
  assert.deepEqual(afterBuildRound2.decision.batch.jobs.map((job) => job.agentId), ["UnitTest"]);

  const afterUnitTestActionRequiredRound2 = applyAgentResultToGraphState(afterBuildRound2.state, {
    agentId: "UnitTest",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "continue",
    agentStatus: "continue",
    agentContextContent: "UnitTest 第 2 轮未通过",
    opinion: "请修复 UnitTest 第 2 轮问题",
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });

  assert.equal(afterUnitTestActionRequiredRound2.decision.type, "execute_batch");
  assert.deepEqual(afterUnitTestActionRequiredRound2.decision.batch.jobs, [
    {
      agentId: "Build",
      sourceAgentId: "CodeReview",
      kind: "continue_request",
    },
  ]);
  assert.equal(afterUnitTestActionRequiredRound2.decision.batch.sourceAgentId, "CodeReview");
  assert.match(
    afterUnitTestActionRequiredRound2.decision.batch.sourceContent ?? "",
    /请修复 CodeReview 第 1 轮问题/u,
  );
  assert.equal(
    afterUnitTestActionRequiredRound2.decision.batch.jobs.some((job) => job.agentId === "Judge"),
    false,
  );
});

test("回流超限时，如果 reviewer 正文已包含最终结论提示，不应再重复追加一遍", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "漏洞挑战-1", "讨论总结-1"],
    edges: [
      { source: "Build", target: "漏洞挑战-1", triggerOn: "transfer", messageMode: "last" },
      { source: "漏洞挑战-1", target: "Build", triggerOn: "continue", messageMode: "last", maxRevisionRounds: 1 },
      { source: "漏洞挑战-1", target: "讨论总结-1", triggerOn: "complete", messageMode: "last" },
    ],
  };
  let state = createGraphTaskState({
    taskId: "task-loop-limit-dedup",
    topology,
  });

  const afterBuildRound1 = applyAgentResultToGraphState(state, {
    agentId: "Build",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: "Build 第 1 轮已完成",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterBuildRound1.decision.type, "execute_batch");
  state = afterBuildRound1.state;

  const reviewBody = `当前证据仍不足以证明越权成立。

漏洞挑战-1 -> Build 已连续交流 1 次`;
  const afterReviewerRound1 = applyAgentResultToGraphState(state, {
    agentId: "漏洞挑战-1",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "continue",
    agentStatus: "continue",
    agentContextContent: reviewBody,
    opinion: reviewBody,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterReviewerRound1.decision.type, "execute_batch");
  assert.deepEqual(afterReviewerRound1.decision.batch.jobs.map((job) => job.agentId), ["Build"]);
  state = afterReviewerRound1.state;

  const afterBuildRound2 = applyAgentResultToGraphState(state, {
    agentId: "Build",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: "Build 第 2 轮已完成",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterBuildRound2.decision.type, "execute_batch");
  assert.deepEqual(afterBuildRound2.decision.batch.jobs.map((job) => job.agentId), ["漏洞挑战-1"]);
  state = afterBuildRound2.state;

  const afterReviewerRound2 = applyAgentResultToGraphState(state, {
    agentId: "漏洞挑战-1",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "continue",
    agentStatus: "continue",
    agentContextContent: reviewBody,
    opinion: reviewBody,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });

  assert.equal(afterReviewerRound2.decision.type, "execute_batch");
  assert.deepEqual(afterReviewerRound2.decision.batch.jobs.map((job) => job.agentId), ["讨论总结-1"]);
  assert.equal(
    afterReviewerRound2.decision.batch.sourceContent,
    reviewBody,
  );
});

test("回流超限转给 approved 下游时，不应把系统超限提示注入到下游 agent 正文", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "漏洞挑战-1", "讨论总结-1"],
    edges: [
      { source: "Build", target: "漏洞挑战-1", triggerOn: "transfer", messageMode: "last" },
      { source: "漏洞挑战-1", target: "Build", triggerOn: "continue", messageMode: "last", maxRevisionRounds: 1 },
      { source: "漏洞挑战-1", target: "讨论总结-1", triggerOn: "complete", messageMode: "last" },
    ],
  };
  let state = createGraphTaskState({
    taskId: "task-loop-limit-no-system-prompt",
    topology,
  });

  const afterBuildRound1 = applyAgentResultToGraphState(state, {
    agentId: "Build",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: "Build 第 1 轮已完成",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterBuildRound1.decision.type, "execute_batch");
  state = afterBuildRound1.state;

  const reviewBody = "当前证据仍不足以证明越权成立。";
  const afterReviewerRound1 = applyAgentResultToGraphState(state, {
    agentId: "漏洞挑战-1",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "continue",
    agentStatus: "continue",
    agentContextContent: reviewBody,
    opinion: reviewBody,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterReviewerRound1.decision.type, "execute_batch");
  state = afterReviewerRound1.state;

  const afterBuildRound2 = applyAgentResultToGraphState(state, {
    agentId: "Build",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: "Build 第 2 轮已完成",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterBuildRound2.decision.type, "execute_batch");
  state = afterBuildRound2.state;

  const afterReviewerRound2 = applyAgentResultToGraphState(state, {
    agentId: "漏洞挑战-1",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "continue",
    agentStatus: "continue",
    agentContextContent: reviewBody,
    opinion: reviewBody,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });

  assert.equal(afterReviewerRound2.decision.type, "execute_batch");
  assert.deepEqual(afterReviewerRound2.decision.batch.jobs.map((job) => job.agentId), ["讨论总结-1"]);
  assert.equal(afterReviewerRound2.decision.batch.sourceContent, reviewBody);
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
          { sourceRole: "pro", targetRole: "con", triggerOn: "continue", messageMode: "last" },
          { sourceRole: "con", targetRole: "pro", triggerOn: "continue", messageMode: "last" },
          { sourceRole: "pro", targetRole: "summary", triggerOn: "complete", messageMode: "last" },
          { sourceRole: "con", targetRole: "summary", triggerOn: "complete", messageMode: "last" },
        ],
        exitWhen: "one_side_agrees",
        reportToTemplateName: "线索发现",
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
      { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "CodeReview", triggerOn: "transfer", messageMode: "last" },
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
      },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-auto-spawn-router",
    topology,
  });

  const afterBuild = applyAgentResultToGraphState(state, {
    agentId: "Build",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: "Build 已完成",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
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

test("线索发现没有 finding 并命中 complete -> END 时，会直接结束而不是继续触发 spawn reviewer", () => {
  const topology: TopologyRecord = {
    nodes: ["线索发现", "疑点辩论", "漏洞挑战", "讨论总结"],
    langgraph: {
      start: {
        id: "__start__",
        targets: ["线索发现"],
      },
      end: {
        id: "__end__",
        sources: ["线索发现"],
        incoming: [
          { source: "线索发现", triggerOn: "complete" },
        ],
      },
    },
    nodeRecords: [
      { id: "线索发现", kind: "agent", templateName: "线索发现" },
      { id: "疑点辩论", kind: "spawn", templateName: "疑点辩论", spawnRuleId: "spawn-rule:疑点辩论" },
      { id: "漏洞挑战", kind: "agent", templateName: "漏洞挑战" },
      { id: "讨论总结", kind: "agent", templateName: "讨论总结" },
    ],
    edges: [
      { source: "线索发现", target: "疑点辩论", triggerOn: "continue", messageMode: "last" },
      { source: "疑点辩论", target: "线索发现", triggerOn: "transfer", messageMode: "last" },
    ],
    spawnRules: [
      {
        id: "spawn-rule:疑点辩论",
        spawnNodeName: "疑点辩论",
        sourceTemplateName: "线索发现",
        entryRole: "漏洞挑战",
        spawnedAgents: [
          { role: "漏洞挑战", templateName: "漏洞挑战" },
          { role: "讨论总结", templateName: "讨论总结" },
        ],
        edges: [
          { sourceRole: "漏洞挑战", targetRole: "讨论总结", triggerOn: "complete", messageMode: "last" },
        ],
        exitWhen: "all_completed",
        reportToTemplateName: "线索发现",
        reportToTriggerOn: "transfer",
      },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-vulnerability-no-findings",
    topology,
  });

  const afterTriage = applyAgentResultToGraphState(state, {
    agentId: "线索发现",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: "本轮没有发现新的可疑点。",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });

  assert.equal(afterTriage.decision.type, "finished");
  assert.equal(afterTriage.state.spawnBundles.length, 0);
});

test("线索发现存在 finding 且未发出 TASK_DONE 时，会按条件分支继续触发 spawn reviewer", () => {
  const topology: TopologyRecord = {
    nodes: ["线索发现", "疑点辩论", "漏洞挑战", "讨论总结"],
    langgraph: {
      start: {
        id: "__start__",
        targets: ["线索发现"],
      },
      end: {
        id: "__end__",
        sources: ["线索发现"],
        incoming: [
          { source: "线索发现", triggerOn: "complete" },
        ],
      },
    },
    nodeRecords: [
      { id: "线索发现", kind: "agent", templateName: "线索发现" },
      { id: "疑点辩论", kind: "spawn", templateName: "疑点辩论", spawnRuleId: "spawn-rule:疑点辩论" },
      { id: "漏洞挑战", kind: "agent", templateName: "漏洞挑战" },
      { id: "讨论总结", kind: "agent", templateName: "讨论总结" },
    ],
    edges: [
      { source: "线索发现", target: "疑点辩论", triggerOn: "continue", messageMode: "last" },
      { source: "疑点辩论", target: "线索发现", triggerOn: "transfer", messageMode: "last" },
    ],
    spawnRules: [
      {
        id: "spawn-rule:疑点辩论",
        spawnNodeName: "疑点辩论",
        sourceTemplateName: "线索发现",
        entryRole: "漏洞挑战",
        spawnedAgents: [
          { role: "漏洞挑战", templateName: "漏洞挑战" },
          { role: "讨论总结", templateName: "讨论总结" },
        ],
        edges: [
          { sourceRole: "漏洞挑战", targetRole: "讨论总结", triggerOn: "complete", messageMode: "last" },
        ],
        exitWhen: "all_completed",
        reportToTemplateName: "线索发现",
        reportToTriggerOn: "transfer",
      },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-vulnerability-has-finding",
    topology,
  });

  const afterTriage = applyAgentResultToGraphState(state, {
    agentId: "线索发现",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "continue",
    agentStatus: "continue",
    agentContextContent: "发现一个新的可疑点：上传文件名可能被直接拼接到落盘路径。",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });

  assert.equal(afterTriage.decision.type, "execute_batch");
  assert.deepEqual(afterTriage.decision.batch.jobs.map((job) => job.agentId), ["漏洞挑战-1"]);
});

test("__end__ 带 trigger 时，不匹配的审查结论不能直接结束", () => {
  const topology: TopologyRecord = {
    nodes: ["线索发现", "疑点辩论", "漏洞挑战", "讨论总结"],
    langgraph: {
      start: {
        id: "__start__",
        targets: ["线索发现"],
      },
      end: {
        id: "__end__",
        sources: ["线索发现"],
        incoming: [
          { source: "线索发现", triggerOn: "complete" },
        ],
      },
    },
    nodeRecords: [
      { id: "线索发现", kind: "agent", templateName: "线索发现" },
      { id: "疑点辩论", kind: "spawn", templateName: "疑点辩论", spawnRuleId: "spawn-rule:疑点辩论" },
      { id: "漏洞挑战", kind: "agent", templateName: "漏洞挑战" },
      { id: "讨论总结", kind: "agent", templateName: "讨论总结" },
    ],
    edges: [
      { source: "线索发现", target: "疑点辩论", triggerOn: "continue", messageMode: "last" },
      { source: "疑点辩论", target: "线索发现", triggerOn: "transfer", messageMode: "last" },
    ],
    spawnRules: [
      {
        id: "spawn-rule:疑点辩论",
        spawnNodeName: "疑点辩论",
        sourceTemplateName: "线索发现",
        entryRole: "漏洞挑战",
        spawnedAgents: [
          { role: "漏洞挑战", templateName: "漏洞挑战" },
          { role: "讨论总结", templateName: "讨论总结" },
        ],
        edges: [
          { sourceRole: "漏洞挑战", targetRole: "讨论总结", triggerOn: "complete", messageMode: "last" },
        ],
        exitWhen: "all_completed",
        reportToTemplateName: "线索发现",
        reportToTriggerOn: "transfer",
      },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-vulnerability-end-trigger-mismatch",
    topology,
  });

  const afterTriage = applyAgentResultToGraphState(state, {
    agentId: "线索发现",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "continue",
    agentStatus: "continue",
    agentContextContent: "发现一个新的可疑点。",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: true,
  });

  assert.equal(afterTriage.decision.type, "execute_batch");
  assert.deepEqual(afterTriage.decision.batch.jobs.map((job) => job.agentId), ["漏洞挑战-1"]);
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
      { source: "线索发现", target: "辩论", triggerOn: "transfer", messageMode: "last" },
      { source: "辩论", target: "线索发现", triggerOn: "transfer", messageMode: "last" },
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
          { sourceRole: "漏洞论证", targetRole: "讨论总结", triggerOn: "complete", messageMode: "last" },
        ],
        exitWhen: "all_completed",
        reportToTemplateName: "线索发现",
        reportToTriggerOn: "transfer",
      },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-spawn-batch-runtime-targets",
    topology,
  });

  const afterTriage = applyAgentResultToGraphState(state, {
    agentId: "线索发现",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: "发现一个可疑点：上传文件名被直接拼进目标路径",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
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
      { source: "线索发现", target: "辩论", triggerOn: "transfer", messageMode: "last" },
      { source: "辩论", target: "线索发现", triggerOn: "transfer", messageMode: "last" },
    ],
    spawnRules: [
      {
        id: "spawn-rule:辩论",
        sourceTemplateName: "辩论",
        entryRole: "漏洞论证",
        spawnedAgents: [
          { role: "漏洞论证", templateName: "漏洞论证" },
          { role: "讨论总结", templateName: "讨论总结" },
        ],
        edges: [
          { sourceRole: "漏洞论证", targetRole: "讨论总结", triggerOn: "complete", messageMode: "last" },
        ],
        exitWhen: "all_completed",
      },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-spawn-complete",
    topology,
  });

  const afterTriage = applyAgentResultToGraphState(state, {
    agentId: "线索发现",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: `{"items":[{"title":"路径穿越"}]}`,
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterTriage.decision.type, "execute_batch");
  assert.deepEqual(afterTriage.decision.batch.jobs.map((job) => job.agentId), [
    "漏洞论证-1",
  ]);

  const afterPro = applyAgentResultToGraphState(afterTriage.state, {
    agentId: "漏洞论证-1",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: "漏洞论证认为漏洞成立",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterPro.decision.type, "execute_batch");
  assert.deepEqual(afterPro.decision.batch.jobs.map((job) => job.agentId), [
    "讨论总结-1",
  ]);

  const afterSummary = applyAgentResultToGraphState(afterPro.state, {
    agentId: "讨论总结-1",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: "裁决：漏洞成立",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });

  assert.equal(afterSummary.decision.type, "execute_batch");
  assert.deepEqual(afterSummary.decision.batch.jobs.map((job) => job.agentId), ["线索发现"]);
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
      { source: "线索发现", target: "辩论", triggerOn: "transfer", messageMode: "last" },
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
          { sourceRole: "漏洞论证", targetRole: "讨论总结", triggerOn: "complete", messageMode: "last" },
        ],
        exitWhen: "all_completed",
        reportToTemplateName: "线索发现",
        reportToTriggerOn: "transfer",
      },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-spawn-summary-report",
    topology,
  });

  const afterTriage = applyAgentResultToGraphState(state, {
    agentId: "线索发现",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: "发现一个可疑点：上传文件名被拼接到目标路径",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });

  const afterPro = applyAgentResultToGraphState(afterTriage.state, {
    agentId: "漏洞论证-1",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: "漏洞论证认为需要交给裁决",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });

  const afterSummary = applyAgentResultToGraphState(afterPro.state, {
    agentId: "讨论总结-1",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: "裁决：该点讨论完毕，回到线索发现继续下一个 finding",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });

  assert.equal(afterSummary.decision.type, "execute_batch");
  assert.deepEqual(afterSummary.decision.batch.jobs.map((job) => job.agentId), ["线索发现"]);
  assert.equal(afterSummary.state.spawnActivations[0]?.dispatched, true);
  assert.equal(afterSummary.state.agentStatusesByName["辩论"], "completed");
});

test("最后一个叶子节点完成后，router 会直接判定 finished，而不是错误停在 waiting", () => {
  const topology: TopologyRecord = {
    nodes: ["BA", "Build", "QA"],
    edges: [
      { source: "BA", target: "Build", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "QA", triggerOn: "transfer", messageMode: "last" },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-finish-leaf",
    topology,
  });

  const afterBa = applyAgentResultToGraphState(state, {
    agentId: "BA",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: "需求已澄清",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterBa.decision.type, "execute_batch");
  assert.deepEqual(afterBa.decision.batch.jobs.map((job) => job.agentId), ["Build"]);

  const afterBuild = applyAgentResultToGraphState(afterBa.state, {
    agentId: "Build",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: "实现已完成",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterBuild.decision.type, "execute_batch");
  assert.deepEqual(afterBuild.decision.batch.jobs.map((job) => job.agentId), ["QA"]);

  const afterQa = applyAgentResultToGraphState(afterBuild.state, {
    agentId: "QA",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: "验证已完成",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.deepEqual(afterQa.decision, {
    type: "finished",
  });
});

test("单一路径上游完成后，router 会继续派发下一个 handoff 下游，而不是错误 waiting", () => {
  const topology: TopologyRecord = {
    nodes: ["BA", "Build", "QA"],
    edges: [
      { source: "BA", target: "Build", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "QA", triggerOn: "transfer", messageMode: "last" },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-simple-chain",
    topology,
  });

  const afterBa = applyAgentResultToGraphState(state, {
    agentId: "BA",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "complete",
    agentStatus: "completed",
    agentContextContent: "需求已澄清",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });

  assert.equal(afterBa.decision.type, "execute_batch");
  assert.deepEqual(afterBa.decision.batch.jobs.map((job) => job.agentId), ["Build"]);
});
