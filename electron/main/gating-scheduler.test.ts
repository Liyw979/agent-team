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
