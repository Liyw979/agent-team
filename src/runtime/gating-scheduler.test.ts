import test from "node:test";
import assert from "node:assert/strict";

import type { TopologyRecord } from "@shared/types";

import {
  GatingScheduler,
  createGatingSchedulerRuntimeState,
} from "./gating-scheduler";

function createTopology(): TopologyRecord {
  return {
    projectId: "project-1",
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
}

function createAgentStates() {
  return [
    { name: "Build", status: "completed" as const },
    { name: "UnitTest", status: "idle" as const },
    { name: "TaskReview", status: "idle" as const },
    { name: "CodeReview", status: "idle" as const },
  ];
}

test("association 首轮派发会一次放行整批 reviewer", () => {
  const scheduler = new GatingScheduler(createTopology(), createGatingSchedulerRuntimeState());

  const plan = scheduler.planAssociationDispatch(
    "Build",
    "Build 第 1 轮实现完成",
    createAgentStates(),
  );

  assert.notEqual(plan, null);
  assert.deepEqual(plan?.displayTargets, ["UnitTest", "TaskReview", "CodeReview"]);
  assert.deepEqual(plan?.triggerTargets, ["UnitTest", "TaskReview", "CodeReview"]);
  assert.deepEqual(plan?.readyTargets, ["UnitTest", "TaskReview", "CodeReview"]);
  assert.deepEqual(plan?.queuedTargets, []);
});

test("association 批次在 reviewer 未收齐前不会提前推进下一位 reviewer 或回流修复", () => {
  const scheduler = new GatingScheduler(createTopology(), createGatingSchedulerRuntimeState());

  const plan = scheduler.planAssociationDispatch(
    "Build",
    "Build 第 1 轮实现完成",
    createAgentStates(),
  );

  assert.notEqual(plan, null);

  const continuation = scheduler.recordAssociationBatchResponse(
    "UnitTest",
    "fail",
    createAgentStates(),
  );

  assert.deepEqual(continuation, {
    matchedBatch: true,
    sourceAgentId: "Build",
    sourceContent: "Build 第 1 轮实现完成",
    pendingTargets: ["TaskReview", "CodeReview"],
    repairReviewerAgentId: null,
    redispatchTargets: [],
  });
});

test("单 reviewer 的 spawn 展开批次收尾时，不会把静态 spawn 节点误判成 stale target", () => {
  const runtime = createGatingSchedulerRuntimeState();
  runtime.activeAssociationBatchBySource.set("初筛", {
    sourceAgentId: "初筛",
    sourceContent: "发现一个可疑点",
    targets: ["正方-1"],
    pendingTargets: ["正方-1"],
    respondedTargets: [],
    sourceRevision: 1,
    failedTargets: [],
  });
  runtime.sourceRevisionStateByAgent.set("初筛", {
    currentRevision: 1,
    reviewerPassRevision: new Map(),
  });

  const scheduler = new GatingScheduler({
    projectId: "spawn-single-reviewer",
    nodes: ["初筛", "疑点辩论"],
    nodeRecords: [
      { id: "初筛", kind: "agent", templateName: "初筛" },
      { id: "疑点辩论", kind: "spawn", templateName: "疑点辩论", spawnRuleId: "spawn-rule:疑点辩论" },
    ],
    edges: [
      { source: "初筛", target: "疑点辩论", triggerOn: "association" },
    ],
  }, runtime);

  const continuation = scheduler.recordAssociationBatchResponse(
    "正方-1",
    "approved",
    [
      { name: "初筛", status: "completed" as const },
      { name: "疑点辩论", status: "idle" as const },
    ],
  );

  assert.deepEqual(continuation, {
    matchedBatch: true,
    sourceAgentId: "初筛",
    sourceContent: "发现一个可疑点",
    pendingTargets: [],
    repairReviewerAgentId: null,
    redispatchTargets: [],
  });
});

test("单 reviewer 的修复批次收尾时，会继续补跑同源的其他 stale reviewer", () => {
  const runtime = createGatingSchedulerRuntimeState();
  runtime.activeAssociationBatchBySource.set("Build", {
    sourceAgentId: "Build",
    sourceContent: "Build 第 2 轮实现完成",
    targets: ["UnitTest"],
    pendingTargets: ["UnitTest"],
    respondedTargets: [],
    sourceRevision: 2,
    failedTargets: [],
  });
  runtime.sourceRevisionStateByAgent.set("Build", {
    currentRevision: 2,
    reviewerPassRevision: new Map([
      ["TaskReview", 1],
      ["CodeReview", 1],
    ]),
  });

  const scheduler = new GatingScheduler({
    projectId: "single-reviewer-repair-batch",
    nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
    edges: [
      { source: "Build", target: "UnitTest", triggerOn: "association" },
      { source: "Build", target: "TaskReview", triggerOn: "association" },
      { source: "Build", target: "CodeReview", triggerOn: "association" },
    ],
  }, runtime);

  const continuation = scheduler.recordAssociationBatchResponse(
    "UnitTest",
    "approved",
    [
      { name: "Build", status: "completed" as const },
      { name: "UnitTest", status: "completed" as const },
      { name: "TaskReview", status: "completed" as const },
      { name: "CodeReview", status: "completed" as const },
    ],
  );

  assert.deepEqual(continuation, {
    matchedBatch: true,
    sourceAgentId: "Build",
    sourceContent: "Build 第 2 轮实现完成",
    pendingTargets: [],
    repairReviewerAgentId: null,
    redispatchTargets: ["TaskReview", "CodeReview"],
  });
});

test("approved 多入边命中任意一条时，就可以继续派发目标节点", () => {
  const scheduler = new GatingScheduler({
    projectId: "approved-any-incoming",
    nodes: ["正方", "反方", "裁决总结"],
    edges: [
      { source: "正方", target: "裁决总结", triggerOn: "approved" },
      { source: "反方", target: "裁决总结", triggerOn: "approved" },
    ],
  }, createGatingSchedulerRuntimeState());

  const plan = scheduler.planApprovedDispatch(
    "正方",
    "正方同意进入裁决",
    [
      { name: "正方", status: "completed" as const },
      { name: "反方", status: "idle" as const },
      { name: "裁决总结", status: "idle" as const },
    ],
  );

  assert.deepEqual(plan, {
    sourceAgentId: "正方",
    sourceContent: "正方同意进入裁决",
    displayTargets: ["裁决总结"],
    triggerTargets: ["裁决总结"],
    readyTargets: ["裁决总结"],
    queuedTargets: [],
  });
});
