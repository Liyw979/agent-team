import assert from "node:assert/strict";
import test from "node:test";

import type { TopologyRecord } from "@shared/types";

import {
  applyAgentResultToGraphState,
  createGraphTaskState,
  createUserDispatchDecision,
} from "./gating-router";

function createTopology(): TopologyRecord {
  return {
    projectId: "router-project",
    nodes: ["BA", "Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      { source: "BA", target: "Build", triggerOn: "association" },
      { source: "Build", target: "CodeReview", triggerOn: "association" },
      { source: "Build", target: "UnitTest", triggerOn: "association" },
      { source: "Build", target: "TaskReview", triggerOn: "association" },
      { source: "CodeReview", target: "Build", triggerOn: "needs_revision" },
      { source: "CodeReview", target: "TaskReview", triggerOn: "approved" },
    ],
  };
}

test("router 会保留 CodeReview 嵌套链路可先于外层 association 批次剩余 reviewer 继续推进的旧语义", () => {
  const topology = createTopology();
  const state = createGraphTaskState({
    taskId: "task-1",
    projectId: topology.projectId,
    topology,
  });

  const startDecision = createUserDispatchDecision(state, {
    targetAgentName: "BA",
    content: "请先实现，然后经过 CodeReview。",
  });
  assert.equal(startDecision.type, "execute_batch");
  assert.deepEqual(startDecision.batch.jobs.map((job) => job.agentName), ["BA"]);

  const afterBa = applyAgentResultToGraphState(state, {
    agentName: "BA",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "approved",
    agentStatus: "completed",
    agentContextContent: "需求已澄清",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterBa.decision.type, "execute_batch");
  assert.deepEqual(afterBa.decision.batch.jobs.map((job) => job.agentName), ["Build"]);

  const afterBuildFirst = applyAgentResultToGraphState(afterBa.state, {
    agentName: "Build",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "approved",
    agentStatus: "completed",
    agentContextContent: "Build 首轮已完成",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterBuildFirst.decision.type, "execute_batch");
  assert.deepEqual(
    afterBuildFirst.decision.batch.jobs.map((job) => job.agentName),
    ["CodeReview", "UnitTest"],
  );

  const afterApproved = applyAgentResultToGraphState(afterBuildFirst.state, {
    agentName: "CodeReview",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "approved",
    agentStatus: "completed",
    agentContextContent: "CodeReview 已通过",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterApproved.decision.type, "execute_batch");
  assert.deepEqual(afterApproved.decision.batch.jobs.map((job) => job.agentName), ["TaskReview"]);

  const afterTaskReview = applyAgentResultToGraphState(afterApproved.state, {
    agentName: "TaskReview",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "approved",
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
    agentName: "UnitTest",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "approved",
    agentStatus: "completed",
    agentContextContent: "UnitTest 已收到最新结果",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.deepEqual(afterUnitTest.decision, {
    type: "waiting",
    waitingReason: "no_runnable_agents",
  });
});

test("router 会在并发 reviewer 未收齐前保持等待，不会提前回流", () => {
  const topology: TopologyRecord = {
    projectId: "router-project-2",
    nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
    edges: [
      { source: "Build", target: "UnitTest", triggerOn: "association" },
      { source: "Build", target: "TaskReview", triggerOn: "association" },
      { source: "Build", target: "CodeReview", triggerOn: "association" },
      { source: "UnitTest", target: "Build", triggerOn: "needs_revision" },
      { source: "TaskReview", target: "Build", triggerOn: "needs_revision" },
      { source: "CodeReview", target: "Build", triggerOn: "needs_revision" },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-2",
    projectId: topology.projectId,
    topology,
  });

  const afterBuild = applyAgentResultToGraphState(state, {
    agentName: "Build",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "approved",
    agentStatus: "completed",
    agentContextContent: "Build 已完成",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterBuild.decision.type, "execute_batch");
  assert.deepEqual(
    afterBuild.decision.batch.jobs.map((job) => job.agentName),
    ["UnitTest", "TaskReview", "CodeReview"],
  );

  const afterUnitTestFail = applyAgentResultToGraphState(afterBuild.state, {
    agentName: "UnitTest",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "needs_revision",
    agentStatus: "needs_revision",
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

test("同一 reviewer 连续第 5 次回流修复时会直接终止，避免无限循环", () => {
  const topology: TopologyRecord = {
    projectId: "router-project-loop-limit",
    nodes: ["Build", "UnitTest"],
    edges: [
      { source: "Build", target: "UnitTest", triggerOn: "association" },
      { source: "UnitTest", target: "Build", triggerOn: "needs_revision" },
    ],
  };
  let state = createGraphTaskState({
    taskId: "task-loop-limit",
    projectId: topology.projectId,
    topology,
  });

  for (let round = 1; round <= 4; round += 1) {
    const afterBuild = applyAgentResultToGraphState(state, {
      agentName: "Build",
      status: "completed",
      reviewAgent: false,
      reviewDecision: "approved",
      agentStatus: "completed",
      agentContextContent: `Build 已修复第 ${round} 轮问题`,
      opinion: null,
      allowDirectFallbackWhenNoBatch: false,
      signalDone: false,
    });
    assert.equal(afterBuild.decision.type, "execute_batch");
    assert.deepEqual(afterBuild.decision.batch.jobs.map((job) => job.agentName), ["UnitTest"]);

    const afterUnitTestFail = applyAgentResultToGraphState(afterBuild.state, {
      agentName: "UnitTest",
      status: "completed",
      reviewAgent: true,
      reviewDecision: "needs_revision",
      agentStatus: "needs_revision",
      agentContextContent: `UnitTest 第 ${round} 轮未通过`,
      opinion: `请修复第 ${round} 轮问题`,
      allowDirectFallbackWhenNoBatch: true,
      signalDone: false,
    });
    assert.equal(afterUnitTestFail.decision.type, "execute_batch");
    assert.deepEqual(afterUnitTestFail.decision.batch.jobs.map((job) => job.agentName), ["Build"]);
    state = afterUnitTestFail.state;
  }

  const afterBuild = applyAgentResultToGraphState(state, {
    agentName: "Build",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "approved",
    agentStatus: "completed",
    agentContextContent: "Build 已修复第 5 轮问题",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterBuild.decision.type, "execute_batch");
  assert.deepEqual(afterBuild.decision.batch.jobs.map((job) => job.agentName), ["UnitTest"]);

  const afterUnitTestFail = applyAgentResultToGraphState(afterBuild.state, {
    agentName: "UnitTest",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "needs_revision",
    agentStatus: "needs_revision",
    agentContextContent: "UnitTest 第 5 轮未通过",
    opinion: "请修复第 5 轮问题",
    allowDirectFallbackWhenNoBatch: true,
    signalDone: false,
  });
  assert.deepEqual(afterUnitTestFail.decision, {
    type: "failed",
    errorMessage: "UnitTest -> Build 连续回流已达到 4 轮上限，任务已终止以避免无限循环",
  });
});

test("同一 reviewer 连续 4 次回流后，只要第 5 次改为通过，流程仍然允许继续", () => {
  const topology: TopologyRecord = {
    projectId: "router-project-loop-limit-pass-boundary",
    nodes: ["Build", "UnitTest"],
    edges: [
      { source: "Build", target: "UnitTest", triggerOn: "association" },
      { source: "UnitTest", target: "Build", triggerOn: "needs_revision" },
    ],
  };
  let state = createGraphTaskState({
    taskId: "task-loop-limit-pass-boundary",
    projectId: topology.projectId,
    topology,
  });

  for (let round = 1; round <= 4; round += 1) {
    const afterBuild = applyAgentResultToGraphState(state, {
      agentName: "Build",
      status: "completed",
      reviewAgent: false,
      reviewDecision: "approved",
      agentStatus: "completed",
      agentContextContent: `Build 已修复第 ${round} 轮问题`,
      opinion: null,
      allowDirectFallbackWhenNoBatch: false,
      signalDone: false,
    });
    assert.equal(afterBuild.decision.type, "execute_batch");
    assert.deepEqual(afterBuild.decision.batch.jobs.map((job) => job.agentName), ["UnitTest"]);

    const afterUnitTestFail = applyAgentResultToGraphState(afterBuild.state, {
      agentName: "UnitTest",
      status: "completed",
      reviewAgent: true,
      reviewDecision: "needs_revision",
      agentStatus: "needs_revision",
      agentContextContent: `UnitTest 第 ${round} 轮未通过`,
      opinion: `请修复第 ${round} 轮问题`,
      allowDirectFallbackWhenNoBatch: true,
      signalDone: false,
    });
    assert.equal(afterUnitTestFail.decision.type, "execute_batch");
    assert.deepEqual(afterUnitTestFail.decision.batch.jobs.map((job) => job.agentName), ["Build"]);
    state = afterUnitTestFail.state;
  }

  const afterBuild = applyAgentResultToGraphState(state, {
    agentName: "Build",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "approved",
    agentStatus: "completed",
    agentContextContent: "Build 已修复第 5 轮问题",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterBuild.decision.type, "execute_batch");
  assert.deepEqual(afterBuild.decision.batch.jobs.map((job) => job.agentName), ["UnitTest"]);

  const afterUnitTestPass = applyAgentResultToGraphState(afterBuild.state, {
    agentName: "UnitTest",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "approved",
    agentStatus: "completed",
    agentContextContent: "UnitTest 第 5 轮通过",
    opinion: null,
    allowDirectFallbackWhenNoBatch: true,
    signalDone: false,
  });
  assert.deepEqual(afterUnitTestPass.decision, {
    type: "waiting",
    waitingReason: "no_runnable_agents",
  });
});
