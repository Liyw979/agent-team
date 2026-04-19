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
      { source: "CodeReview", target: "Build", triggerOn: "review_fail" },
      { source: "CodeReview", target: "TaskReview", triggerOn: "review_pass" },
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
    reviewDecision: "pass",
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
    reviewDecision: "pass",
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

  const afterReviewPass = applyAgentResultToGraphState(afterBuildFirst.state, {
    agentName: "CodeReview",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "pass",
    agentStatus: "completed",
    agentContextContent: "CodeReview 已通过",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterReviewPass.decision.type, "execute_batch");
  assert.deepEqual(afterReviewPass.decision.batch.jobs.map((job) => job.agentName), ["TaskReview"]);

  const afterTaskReview = applyAgentResultToGraphState(afterReviewPass.state, {
    agentName: "TaskReview",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "pass",
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
    reviewDecision: "pass",
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
      { source: "UnitTest", target: "Build", triggerOn: "review_fail" },
      { source: "TaskReview", target: "Build", triggerOn: "review_fail" },
      { source: "CodeReview", target: "Build", triggerOn: "review_fail" },
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
    reviewDecision: "pass",
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
