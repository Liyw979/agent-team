import test from "node:test";
import assert from "node:assert/strict";

import type { TopologyRecord } from "@shared/types";

import {
  GatingScheduler,
  createGatingSchedulerRuntimeState,
} from "./gating-scheduler";

function createTopology(): TopologyRecord {
  return {
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
}

function createAgentStates() {
  return [
    { id: "Build", status: "completed" as const },
    { id: "UnitTest", status: "idle" as const },
    { id: "TaskReview", status: "idle" as const },
    { id: "CodeReview", status: "idle" as const },
  ];
}

test("handoff 首轮派发会一次放行整批 decisionAgent", () => {
  const scheduler = new GatingScheduler(createTopology(), createGatingSchedulerRuntimeState());

  const plan = scheduler.planHandoffDispatch(
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

test("handoff 批次在 decisionAgent 未收齐前不会提前推进下一位 decisionAgent 或回流修复", () => {
  const scheduler = new GatingScheduler(createTopology(), createGatingSchedulerRuntimeState());

  const plan = scheduler.planHandoffDispatch(
    "Build",
    "Build 第 1 轮实现完成",
    createAgentStates(),
  );

  assert.notEqual(plan, null);

  const continuation = scheduler.recordHandoffBatchResponse(
    "UnitTest",
    "fail",
  );

  assert.deepEqual(continuation, {
    matchedBatch: true,
    sourceAgentId: "Build",
    sourceContent: "Build 第 1 轮实现完成",
    pendingTargets: ["TaskReview", "CodeReview"],
    repairDecisionAgentId: null,
    redispatchTargets: [],
  });
});

test("单 decisionAgent 的 spawn 展开批次收尾时，不会把静态 spawn 节点误判成 stale target", () => {
  const runtime = createGatingSchedulerRuntimeState();
  runtime.activeHandoffBatchBySource.set("线索发现", {
    dispatchKind: "handoff",
    sourceAgentId: "线索发现",
    sourceContent: "发现一个可疑点",
    targets: ["漏洞论证-1"],
    pendingTargets: ["漏洞论证-1"],
    respondedTargets: [],
    sourceRevision: 1,
    failedTargets: [],
  });
  runtime.sourceRevisionStateByAgent.set("线索发现", {
    currentRevision: 1,
    decisionPassRevision: new Map(),
  });

  const scheduler = new GatingScheduler({
    nodes: ["线索发现", "疑点辩论"],
    nodeRecords: [
      { id: "线索发现", kind: "agent", templateName: "线索发现" },
      { id: "疑点辩论", kind: "spawn", templateName: "疑点辩论", spawnRuleId: "spawn-rule:疑点辩论" },
    ],
    edges: [
      { source: "线索发现", target: "疑点辩论", triggerOn: "transfer", messageMode: "last" },
    ],
  }, runtime);

  const continuation = scheduler.recordHandoffBatchResponse(
    "漏洞论证-1",
    "complete",
  );

  assert.deepEqual(continuation, {
    matchedBatch: true,
    sourceAgentId: "线索发现",
    sourceContent: "发现一个可疑点",
    pendingTargets: [],
    repairDecisionAgentId: null,
    redispatchTargets: [],
  });
});

test("单 decisionAgent 的修复批次收尾时，会继续补跑同源的其他 stale decisionAgent", () => {
  const runtime = createGatingSchedulerRuntimeState();
  runtime.activeHandoffBatchBySource.set("Build", {
    dispatchKind: "handoff",
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
    decisionPassRevision: new Map([
      ["TaskReview", 1],
      ["CodeReview", 1],
    ]),
  });

  const scheduler = new GatingScheduler({
    nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
    edges: [
      { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "CodeReview", triggerOn: "transfer", messageMode: "last" },
    ],
  }, runtime);

  const continuation = scheduler.recordHandoffBatchResponse(
    "UnitTest",
    "complete",
  );

  assert.deepEqual(continuation, {
    matchedBatch: true,
    sourceAgentId: "Build",
    sourceContent: "Build 第 2 轮实现完成",
    pendingTargets: [],
    repairDecisionAgentId: null,
    redispatchTargets: ["TaskReview", "CodeReview"],
  });
});

test("approved 多入边命中任意一条时，就可以继续派发目标节点", () => {
  const scheduler = new GatingScheduler({
    nodes: ["漏洞论证", "漏洞挑战", "讨论总结"],
    edges: [
      { source: "漏洞论证", target: "讨论总结", triggerOn: "complete", messageMode: "last" },
      { source: "漏洞挑战", target: "讨论总结", triggerOn: "complete", messageMode: "last" },
    ],
  }, createGatingSchedulerRuntimeState());

  const plan = scheduler.planApprovedDispatch(
    "漏洞论证",
    "漏洞论证同意进入裁决",
    [
      { id: "漏洞论证", status: "completed" as const },
      { id: "漏洞挑战", status: "idle" as const },
      { id: "讨论总结", status: "idle" as const },
    ],
  );

  assert.deepEqual(plan, {
    sourceAgentId: "漏洞论证",
    sourceContent: "漏洞论证同意进入裁决",
    displayTargets: ["讨论总结"],
    triggerTargets: ["讨论总结"],
    readyTargets: ["讨论总结"],
    queuedTargets: [],
  });
});

test("approved 派发也会写入核心批次状态，后续 decisionAgent 回复时仍能继续等待剩余 decisionAgent", () => {
  const runtime = createGatingSchedulerRuntimeState();
  const scheduler = new GatingScheduler({
    nodes: ["CodeReview", "TaskReview", "UnitTest"],
    edges: [
      { source: "CodeReview", target: "TaskReview", triggerOn: "complete", messageMode: "last" },
      { source: "CodeReview", target: "UnitTest", triggerOn: "complete", messageMode: "last" },
    ],
  }, runtime);

  const plan = scheduler.planApprovedDispatch(
    "CodeReview",
    "CodeReview 通过并进入后续判定",
    [
      { id: "CodeReview", status: "completed" as const },
      { id: "TaskReview", status: "idle" as const },
      { id: "UnitTest", status: "idle" as const },
    ],
  );

  assert.deepEqual(plan?.readyTargets, ["TaskReview", "UnitTest"]);
  assert.deepEqual(runtime.activeHandoffBatchBySource.get("CodeReview")?.pendingTargets, [
    "TaskReview",
    "UnitTest",
  ]);

  const continuation = scheduler.recordHandoffBatchResponse("TaskReview", "complete");

  assert.deepEqual(continuation, {
    matchedBatch: true,
    sourceAgentId: "CodeReview",
    sourceContent: "CodeReview 通过并进入后续判定",
    pendingTargets: ["UnitTest"],
    repairDecisionAgentId: null,
    redispatchTargets: [],
  });
});

test("运行时 spawn report 边完成后，会满足对应静态 spawn report 入边并放行外层节点", () => {
  const runtime = createGatingSchedulerRuntimeState();
  runtime.completedEdges.add("裁决总结-1__初筛__transfer");
  runtime.edgeTriggerVersion.set("裁决总结-1__初筛__transfer", 1);
  const scheduler = new GatingScheduler({
    nodes: ["初筛", "疑点辩论", "反方-1", "裁决总结-1"],
    nodeRecords: [
      { id: "初筛", kind: "agent", templateName: "初筛" },
      { id: "疑点辩论", kind: "spawn", templateName: "疑点辩论", spawnRuleId: "spawn-rule:疑点辩论" },
      { id: "反方-1", kind: "agent", templateName: "反方" },
      { id: "裁决总结-1", kind: "agent", templateName: "裁决总结" },
    ],
    edges: [
      { source: "疑点辩论", target: "初筛", triggerOn: "transfer", messageMode: "last" },
      { source: "裁决总结-1", target: "初筛", triggerOn: "transfer", messageMode: "last" },
    ],
    spawnRules: [
      {
        id: "spawn-rule:疑点辩论",
        spawnNodeName: "疑点辩论",
        entryRole: "反方",
        spawnedAgents: [
          { role: "反方", templateName: "反方" },
          { role: "裁决总结", templateName: "裁决总结" },
        ],
        edges: [
          { sourceRole: "反方", targetRole: "裁决总结", triggerOn: "complete", messageMode: "last" },
        ],
        exitWhen: "all_completed",
        reportToTemplateName: "初筛",
        reportToTriggerOn: "transfer",
      },
    ],
  }, runtime);

  const plan = scheduler.planHandoffDispatch(
    "裁决总结-1",
    "通过",
    [
      { id: "初筛", status: "completed" as const },
      { id: "疑点辩论", status: "idle" as const },
      { id: "反方-1", status: "completed" as const },
      { id: "裁决总结-1", status: "completed" as const },
    ],
  );

  assert.deepEqual(plan?.readyTargets, ["初筛"]);
});
