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
    type: "finished",
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

test("needs_revision 边支持单独配置更小的回流上限", () => {
  const topology: TopologyRecord = {
    projectId: "router-project-loop-limit-override",
    nodes: ["Build", "UnitTest"],
    edges: [
      { source: "Build", target: "UnitTest", triggerOn: "association" },
      { source: "UnitTest", target: "Build", triggerOn: "needs_revision", maxRevisionRounds: 2 },
    ],
  };
  let state = createGraphTaskState({
    taskId: "task-loop-limit-override",
    projectId: topology.projectId,
    topology,
  });

  for (let round = 1; round <= 2; round += 1) {
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
    state = afterUnitTestFail.state;
  }

  const afterBuild = applyAgentResultToGraphState(state, {
    agentName: "Build",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "approved",
    agentStatus: "completed",
    agentContextContent: "Build 已修复第 3 轮问题",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  const afterUnitTestFail = applyAgentResultToGraphState(afterBuild.state, {
    agentName: "UnitTest",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "needs_revision",
    agentStatus: "needs_revision",
    agentContextContent: "UnitTest 第 3 轮未通过",
    opinion: "请修复第 3 轮问题",
    allowDirectFallbackWhenNoBatch: true,
    signalDone: false,
  });

  assert.deepEqual(afterUnitTestFail.decision, {
    type: "failed",
    errorMessage: "UnitTest -> Build 连续回流已达到 2 轮上限，任务已终止以避免无限循环",
  });
});

test("并发 reviewer 中单条回流链路超限时，不应提前打断其他 reviewer", () => {
  const topology: TopologyRecord = {
    projectId: "router-project-parallel-loop-isolation",
    nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
    edges: [
      { source: "Build", target: "UnitTest", triggerOn: "association" },
      { source: "Build", target: "TaskReview", triggerOn: "association" },
      { source: "Build", target: "CodeReview", triggerOn: "association" },
      { source: "UnitTest", target: "Build", triggerOn: "needs_revision", maxRevisionRounds: 1 },
      { source: "TaskReview", target: "Build", triggerOn: "needs_revision" },
      { source: "CodeReview", target: "Build", triggerOn: "needs_revision" },
    ],
  };
  let state = createGraphTaskState({
    taskId: "task-parallel-loop-isolation",
    projectId: topology.projectId,
    topology,
  });

  const afterBuildRound1 = applyAgentResultToGraphState(state, {
    agentName: "Build",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "approved",
    agentStatus: "completed",
    agentContextContent: "Build 第 1 轮已完成",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterBuildRound1.decision.type, "execute_batch");
  assert.deepEqual(
    afterBuildRound1.decision.batch.jobs.map((job) => job.agentName),
    ["UnitTest", "TaskReview", "CodeReview"],
  );

  const afterTaskReviewApproved = applyAgentResultToGraphState(afterBuildRound1.state, {
    agentName: "TaskReview",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "approved",
    agentStatus: "completed",
    agentContextContent: "TaskReview 通过",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterTaskReviewApproved.decision.type, "waiting");

  const afterCodeReviewNeedsRevision = applyAgentResultToGraphState(afterTaskReviewApproved.state, {
    agentName: "CodeReview",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "needs_revision",
    agentStatus: "needs_revision",
    agentContextContent: "CodeReview 第 1 轮未通过",
    opinion: "请修复 CodeReview 第 1 轮问题",
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterCodeReviewNeedsRevision.decision.type, "waiting");

  const afterUnitTestNeedsRevisionRound1 = applyAgentResultToGraphState(afterCodeReviewNeedsRevision.state, {
    agentName: "UnitTest",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "needs_revision",
    agentStatus: "needs_revision",
    agentContextContent: "UnitTest 第 1 轮未通过",
    opinion: "请修复 UnitTest 第 1 轮问题",
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterUnitTestNeedsRevisionRound1.decision.type, "execute_batch");
  assert.deepEqual(afterUnitTestNeedsRevisionRound1.decision.batch.jobs.map((job) => job.agentName), ["Build"]);
  state = afterUnitTestNeedsRevisionRound1.state;

  const afterBuildRound2 = applyAgentResultToGraphState(state, {
    agentName: "Build",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "approved",
    agentStatus: "completed",
    agentContextContent: "Build 第 2 轮已完成",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterBuildRound2.decision.type, "execute_batch");
  assert.deepEqual(afterBuildRound2.decision.batch.jobs.map((job) => job.agentName), ["UnitTest"]);

  const afterUnitTestNeedsRevisionRound2 = applyAgentResultToGraphState(afterBuildRound2.state, {
    agentName: "UnitTest",
    status: "completed",
    reviewAgent: true,
    reviewDecision: "needs_revision",
    agentStatus: "needs_revision",
    agentContextContent: "UnitTest 第 2 轮未通过",
    opinion: "请修复 UnitTest 第 2 轮问题",
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });

  assert.notEqual(afterUnitTestNeedsRevisionRound2.decision.type, "failed");
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
    type: "finished",
  });
});

test("用户消息命中 spawn 节点时会自动生成实例组并启动入口角色", () => {
  const topology: TopologyRecord = {
    projectId: "router-spawn-project",
    nodes: ["初筛", "正方模板", "反方模板", "Summary模板"],
    nodeRecords: [
      { id: "初筛", kind: "agent", templateName: "初筛" },
      { id: "正方模板", kind: "agent", templateName: "正方模板" },
      { id: "反方模板", kind: "agent", templateName: "反方模板" },
      { id: "Summary模板", kind: "agent", templateName: "Summary模板" },
      { id: "疑点辩论工厂", kind: "spawn", templateName: "正方模板", spawnRuleId: "finding-debate" },
    ],
    edges: [],
    spawnRules: [
      {
        id: "finding-debate",
        name: "漏洞疑点辩论",
        sourceTemplateName: "初筛",
        itemKey: "findings",
        entryRole: "pro",
        spawnedAgents: [
          { role: "pro", templateName: "正方模板" },
          { role: "con", templateName: "反方模板" },
          { role: "summary", templateName: "Summary模板" },
        ],
        edges: [
          { sourceRole: "pro", targetRole: "con", triggerOn: "review_fail" },
          { sourceRole: "con", targetRole: "pro", triggerOn: "review_fail" },
          { sourceRole: "pro", targetRole: "summary", triggerOn: "review_pass" },
          { sourceRole: "con", targetRole: "summary", triggerOn: "review_pass" },
        ],
        exitWhen: "one_side_agrees",
        reportToTemplateName: "初筛",
      },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-spawn-router",
    projectId: topology.projectId,
    topology,
  });

  const decision = createUserDispatchDecision(state, {
    targetAgentName: "疑点辩论工厂",
    content: "发现上传文件名被直接拼到目标路径。",
  });

  assert.equal(decision.type, "execute_batch");
  assert.deepEqual(
    decision.batch.jobs.map((job) => job.agentName),
    ["pro#finding-debate:finding-debate-0001"],
  );
  assert.equal(state.spawnBundles.length, 1);
  assert.equal(
    state.runtimeNodes.some((node) => node.id === "con#finding-debate:finding-debate-0001"),
    true,
  );
});

test("自动 association 命中 spawn 节点时，会实例化动态团队并派发入口角色，而不是停在 spawn 模板节点", () => {
  const topology: TopologyRecord = {
    projectId: "router-auto-spawn-project",
    nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
    nodeRecords: [
      { id: "Build", kind: "agent", templateName: "Build" },
      { id: "UnitTest", kind: "spawn", templateName: "UnitTest", spawnRuleId: "spawn-rule:UnitTest", spawnEnabled: true },
      { id: "TaskReview", kind: "spawn", templateName: "TaskReview", spawnRuleId: "spawn-rule:TaskReview", spawnEnabled: true },
      { id: "CodeReview", kind: "spawn", templateName: "CodeReview", spawnRuleId: "spawn-rule:CodeReview", spawnEnabled: true },
    ],
    edges: [
      { source: "Build", target: "UnitTest", triggerOn: "association" },
      { source: "Build", target: "TaskReview", triggerOn: "association" },
      { source: "Build", target: "CodeReview", triggerOn: "association" },
    ],
    spawnRules: [
      {
        id: "spawn-rule:UnitTest",
        name: "UnitTest",
        sourceTemplateName: "Build",
        itemKey: "spawn_items",
        entryRole: "entry",
        spawnedAgents: [{ role: "entry", templateName: "UnitTest" }],
        edges: [],
        exitWhen: "one_side_agrees",
        reportToTemplateName: "Build",
      },
      {
        id: "spawn-rule:TaskReview",
        name: "TaskReview",
        sourceTemplateName: "Build",
        itemKey: "spawn_items",
        entryRole: "entry",
        spawnedAgents: [{ role: "entry", templateName: "TaskReview" }],
        edges: [],
        exitWhen: "one_side_agrees",
        reportToTemplateName: "Build",
      },
      {
        id: "spawn-rule:CodeReview",
        name: "CodeReview",
        sourceTemplateName: "Build",
        itemKey: "spawn_items",
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
    [
      "entry#spawn-rule:UnitTest:spawn-rule:UnitTest-0001",
      "entry#spawn-rule:TaskReview:spawn-rule:TaskReview-0001",
      "entry#spawn-rule:CodeReview:spawn-rule:CodeReview-0001",
    ],
  );
  assert.equal(afterBuild.state.spawnBundles.length, 3);
});

test("最后一个叶子节点完成后，router 会直接判定 finished，而不是错误停在 waiting", () => {
  const topology: TopologyRecord = {
    projectId: "router-finish-leaf",
    nodes: ["BA", "Build", "QA"],
    edges: [
      { source: "BA", target: "Build", triggerOn: "association" },
      { source: "Build", target: "QA", triggerOn: "association" },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-finish-leaf",
    projectId: topology.projectId,
    topology,
  });

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

  const afterBuild = applyAgentResultToGraphState(afterBa.state, {
    agentName: "Build",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "pass",
    agentStatus: "completed",
    agentContextContent: "实现已完成",
    opinion: null,
    allowDirectFallbackWhenNoBatch: false,
    signalDone: false,
  });
  assert.equal(afterBuild.decision.type, "execute_batch");
  assert.deepEqual(afterBuild.decision.batch.jobs.map((job) => job.agentName), ["QA"]);

  const afterQa = applyAgentResultToGraphState(afterBuild.state, {
    agentName: "QA",
    status: "completed",
    reviewAgent: false,
    reviewDecision: "pass",
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

test("单一路径上游完成后，router 会继续派发下一个 association 下游，而不是错误 waiting", () => {
  const topology: TopologyRecord = {
    projectId: "router-simple-chain",
    nodes: ["BA", "Build", "QA"],
    edges: [
      { source: "BA", target: "Build", triggerOn: "association" },
      { source: "Build", target: "QA", triggerOn: "association" },
    ],
  };
  const state = createGraphTaskState({
    taskId: "task-simple-chain",
    projectId: topology.projectId,
    topology,
  });

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
});
