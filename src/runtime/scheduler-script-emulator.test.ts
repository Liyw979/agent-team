import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import type { TopologyRecord } from "@shared/types";

import {
  buildDispatchOmissionVariants,
  buildUnexpectedNextSenderMessage,
  buildUnexpectedScriptEndMessage,
  buildMissingDispatchTargetsMessage,
  buildDispatchTargetMismatchMessage,
  canScriptEndAfterLastLine,
  canImplicitlyFinishScript,
  collectRequiredConsumerMessages,
  collectRequiredDispatchAssertions,
  dispatchAssertionTargetsCovered,
  getAllowedPendingSendersFromFinishedDecision,
  isImplicitEmptyDispatchAssertionLine,
  matchesExpectedTransition,
  preferCompleteReviewCandidatesForPendingNextSender,
  runSchedulerScriptDrived,
  shouldRequireSourceDispatchAssertion,
} from "./scheduler-script-emulator";
import { parseSchedulerScriptLine } from "./scheduler-script-dsl";
import { createGraphTaskState, type GraphRoutingDecision } from "./gating-router";
import { compileTeamDsl } from "./team-dsl";
import { createTopology } from "./topology-test-dsl";

function readBuiltinTopology(fileName: string) {
  return JSON.parse(
    fs.readFileSync(path.resolve("config", "team-topologies", fileName), "utf8"),
  ) as Parameters<typeof compileTeamDsl>[0];
}

function parseMessageLine(line: string) {
  const parsed = parseSchedulerScriptLine(line);
  assert.equal(parsed.kind, "message");
  return parsed;
}

function createRepresentativeScript() {
  return [
    "user: @BA 请先完成实现，再经过 CodeReview，多轮修复结束后再进入其他审查。",
    "BA: 需求已澄清，交给 Build 继续实现。 @Build",
    "Build: Build 首轮实现完成， @CodeReview @UnitTest @TaskReview",
    "CodeReview: CodeReview 首轮未通过。 @Build",
    "UnitTest: UnitTest 已收到首轮 Build 结果。",
    "TaskReview: TaskReview 已收到首轮 Build 结果。",
    "Build: Build 已根据 CodeReview 意见修复完成。 @CodeReview",
    "CodeReview: 已确认通过，可以进入后续审查。",
    "Build: @UnitTest @TaskReview",
    "UnitTest: UnitTest 已收到最终 Build 结果。",
    "TaskReview: TaskReview 已收到最终 Build 结果。",
  ];
}

test("scheduler script emulator 模块不再单独导出 runSchedulerScriptTrace", async () => {
  const moduleExports = await import("./scheduler-script-emulator");

  assert.equal("runSchedulerScriptTrace" in moduleExports, false);
});

test("scheduler script emulator 模块不再单独导出 parseSchedulerScriptLine", async () => {
  const moduleExports = await import("./scheduler-script-emulator");

  assert.equal("parseSchedulerScriptLine" in moduleExports, false);
});

test("scheduler script drived 支持漏洞团队 2 个 finding 且每个 finding 各有两轮正反讨论后结束", async () => {
  const topology = compileTeamDsl(readBuiltinTopology("vulnerability-team.topology.json")).topology;

  const script = [
    "user: @线索发现 请持续挖掘当前代码中的可疑漏洞点，直到没有新 finding 为止。",
    "线索发现: 发现第 1 个可疑点：上传文件名可能被直接拼进目标路径。 @漏洞挑战-1",
    "漏洞挑战-1: 当前材料还缺少从入口到落盘点的完整调用链。 @漏洞论证-1",
    "漏洞论证-1: 第一轮补证：上传入口会把原始文件名透传到保存逻辑。 @漏洞挑战-1",
    "漏洞挑战-1: 第二轮质疑：还缺少目标路径是否真正受控的证据。 @漏洞论证-1",
    "漏洞论证-1: 第二轮补证：存储层直接执行 path.join(uploadRoot, filename)，未见对 .. 或分隔符的拦截。 @讨论总结-1",
    "讨论总结-1: 当前这条更像真实漏洞。 @线索发现",
    "线索发现: 发现第 2 个可疑点：内部调试接口似乎缺少鉴权。 @漏洞挑战-2",
    "漏洞挑战-2: 当前材料更像误报，缺少生产环境可达性证据。 @漏洞论证-2",
    "漏洞论证-2: 第一轮补证：调试路由默认注册，且局部未见鉴权中间件。 @漏洞挑战-2",
    "漏洞挑战-2: 第二轮质疑：仍然缺少环境开关实际放行的证据。 @漏洞论证-2",
    "漏洞论证-2: 第二轮补证后，当前仍无法证明生产环境可利用，只能进入总结。 @讨论总结-2",
    "讨论总结-2: 当前这条更像误报。 @线索发现",
    "线索发现: 当前项目里没有新的可疑点，结束本轮流程。",
  ];

  await runSchedulerScriptDrived({
    topology,
    script,
  });
});

test("scheduler script emulator 纯函数会从真实核心轨迹里收集必须显式出现的 dispatch 断言", async () => {
  const topology: TopologyRecord = {
    nodes: ["BA", "Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      { source: "BA", target: "Build", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "CodeReview", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
      { source: "CodeReview", target: "Build", triggerOn: "continue", messageMode: "last" },
    ],
  };

  const trace = await runSchedulerScriptDrived({
    topology,
    script: createRepresentativeScript(),
  });
  const dispatchAssertions = collectRequiredDispatchAssertions(trace);

  assert.deepEqual(
    dispatchAssertions.map((item) => ({
      lineIndex: item.lineIndex,
      senderId: item.senderId,
      targets: item.targets,
      kind: item.kind,
    })),
    [
      { lineIndex: 1, senderId: "BA", targets: ["Build"], kind: "inline_dispatch" },
      { lineIndex: 2, senderId: "Build", targets: ["CodeReview", "UnitTest", "TaskReview"], kind: "inline_dispatch" },
      { lineIndex: 3, senderId: "CodeReview", targets: ["Build"], kind: "inline_dispatch" },
      { lineIndex: 6, senderId: "Build", targets: ["CodeReview"], kind: "inline_dispatch" },
      { lineIndex: 8, senderId: "Build", targets: ["UnitTest", "TaskReview"], kind: "dispatch_assertion" },
    ],
  );
});

test("scheduler script emulator 纯函数会从真实核心轨迹里收集每批调度实际消费到的消息", async () => {
  const topology: TopologyRecord = {
    nodes: ["BA", "Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      { source: "BA", target: "Build", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "CodeReview", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
      { source: "CodeReview", target: "Build", triggerOn: "continue", messageMode: "last" },
    ],
  };

  const trace = await runSchedulerScriptDrived({
    topology,
    script: createRepresentativeScript(),
  });
  const consumedMessages = collectRequiredConsumerMessages(trace);

  assert.deepEqual(
    consumedMessages
      .filter((item) => item.dispatchLineIndex === 8)
      .map((item) => ({
        dispatchLineIndex: item.dispatchLineIndex,
        consumerLineIndex: item.consumerLineIndex,
        consumerAgentId: item.consumerAgentId,
      })),
    [
      { dispatchLineIndex: 8, consumerLineIndex: 9, consumerAgentId: "UnitTest" },
      { dispatchLineIndex: 8, consumerLineIndex: 10, consumerAgentId: "TaskReview" },
    ],
  );
});

test("scheduler script emulator 纯函数会基于真实核心轨迹自动派生缺失 target、dispatch 行和 consumer 行", async () => {
  const topology: TopologyRecord = {
    nodes: ["BA", "Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      { source: "BA", target: "Build", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "CodeReview", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
      { source: "CodeReview", target: "Build", triggerOn: "continue", messageMode: "last" },
    ],
  };

  const script = createRepresentativeScript();
  const trace = await runSchedulerScriptDrived({
    topology,
    script,
  });
  const variants = buildDispatchOmissionVariants({
    script,
    trace,
  });

  assert.ok(
    variants.some((variant) =>
      variant.kind === "missing_target"
      && variant.sourceLineIndex === 1
      && variant.removedTarget === "Build"
    ),
  );
  assert.ok(
    variants.some((variant) =>
      variant.kind === "missing_target"
      && variant.sourceLineIndex === 2
      && variant.removedTarget === "CodeReview"
    ),
  );
  assert.ok(
    variants.some((variant) =>
      variant.kind === "missing_consumer_line"
      && variant.sourceLineIndex === 0
      && variant.removedMessageLineIndex === 1
    ),
  );
  assert.ok(
    variants.some((variant) =>
      variant.kind === "missing_dispatch_line"
      && variant.sourceLineIndex === 8
    ),
  );
  assert.ok(
    variants.some((variant) =>
      variant.kind === "missing_consumer_line"
      && variant.sourceLineIndex === 8
      && variant.removedMessageLineIndex === 9
    ),
  );
  assert.ok(
    variants.some((variant) =>
      variant.kind === "missing_consumer_line"
      && variant.sourceLineIndex === 8
      && variant.removedMessageLineIndex === 10
    ),
  );
  assert.ok(
    variants.some((variant) =>
      variant.kind === "truncate_after_line"
      && variant.sourceLineIndex === 8
      && variant.script.length === 9
    ),
  );
});

test("scheduler script emulator 自动派生的 missing_consumer_line 会抓住 source 抢跑下一轮", async () => {
  const topology = createTopology({
    downstream: {
      A: { B: "transfer" },
      B: { A: "continue" },
    },
  });
  const script = [
    "user: @A start",
    "A: first @B",
    "B: feedback @A",
    "A: second @B",
    "B: done",
  ];
  const trace = await runSchedulerScriptDrived({
    topology,
    script,
  });
  const variants = buildDispatchOmissionVariants({
    script,
    trace,
  });
  const variant = variants.find((item) =>
    item.kind === "missing_consumer_line"
    && item.sourceLineIndex === 1
    && item.removedMessageLineIndex === 2
  );

  assert.ok(variant, "必须派生出删掉第 1 轮消费者消息的负例");
  await assert.rejects(
    runSchedulerScriptDrived({
      topology,
      script: variant.script,
    }),
    /下一条回应 Agent 不匹配|当前步骤模拟值为 \[B\]/u,
  );
});

test("scheduler script emulator 在 review 决策无法唯一推断时直接失败", async () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "Judge"],
    edges: [
      { source: "Build", target: "Judge", triggerOn: "transfer", messageMode: "last" },
      { source: "Judge", target: "Build", triggerOn: "continue", messageMode: "last" },
      { source: "Judge", target: "Build", triggerOn: "complete", messageMode: "last" },
    ],
  };

  const script = [
    "user: @Build 请完成这个需求。",
    "Build: 首轮实现完成。 @Judge",
    "Judge: 当前还需要继续判断。 @Build",
  ];

  await assert.rejects(
    runSchedulerScriptDrived({
      topology,
      script,
    }),
    /无法唯一推断|唯一推断/u,
  );
});

test("scheduler script emulator 纯函数解析会把紧贴句号的 @target 识别为显式目标", () => {
  const parsed = parseSchedulerScriptLine(
    "UnitTest: UnitTest 已收到首轮 Build 结果。@build",
  );

  assert.equal(parsed.kind, "message");
  assert.equal(parsed.body, "UnitTest 已收到首轮 Build 结果。");
  assert.deepEqual(parsed.targets, ["build"]);
});

test("scheduler script emulator 纯函数会从 finished 原因里读取允许继续发言的 sender", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [],
  };
  const state = createGraphTaskState({
    taskId: "scheduler-script-emulator-pending-senders",
    topology,
  });
  state.activeHandoffBatchBySource = {
    Build: {
      dispatchKind: "handoff",
      sourceAgentId: "Build",
      sourceContent: "Build 第 1 轮结果",
      targets: ["CodeReview", "UnitTest", "TaskReview"],
      pendingTargets: ["UnitTest", "TaskReview"],
      respondedTargets: ["CodeReview"],
      sourceRevision: 1,
      failedTargets: ["CodeReview"],
    },
  };

  const allowedSenders = getAllowedPendingSendersFromFinishedDecision(state, {
    type: "finished",
    finishReason: "wait_pending_reviewers",
  });

  assert.deepEqual(allowedSenders, ["UnitTest", "TaskReview"]);
});

test("scheduler script emulator 纯函数会在核心 finished 但仍待 reviewer 回复时优先把静默 reviewer 视为 complete", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "TaskReview", "CodeReview"],
    edges: [],
  };
  const completeState = createGraphTaskState({
    taskId: "scheduler-script-emulator-prefer-complete",
    topology,
  });
  completeState.activeHandoffBatchBySource = {
    Build: {
      dispatchKind: "handoff",
      sourceAgentId: "Build",
      sourceContent: "Build 第 1 轮结果",
      targets: ["TaskReview", "CodeReview"],
      pendingTargets: ["CodeReview"],
      respondedTargets: ["TaskReview"],
      sourceRevision: 1,
      failedTargets: [],
    },
  };
  const continueState = createGraphTaskState({
    taskId: "scheduler-script-emulator-prefer-complete-continue",
    topology,
  });
  continueState.activeHandoffBatchBySource = {
    Build: {
      dispatchKind: "handoff",
      sourceAgentId: "Build",
      sourceContent: "Build 第 1 轮结果",
      targets: ["TaskReview", "CodeReview"],
      pendingTargets: ["CodeReview"],
      respondedTargets: ["TaskReview"],
      sourceRevision: 1,
      failedTargets: ["TaskReview"],
    },
  };

  const preferred = preferCompleteReviewCandidatesForPendingNextSender({
    candidates: [
      {
        result: {
          agentId: "TaskReview",
          status: "completed" as const,
          reviewAgent: true,
          reviewDecision: "continue" as const,
          agentStatus: "completed" as const,
          agentContextContent: "TaskReview",
          opinion: null,
          allowDirectFallbackWhenNoBatch: false,
          signalDone: false,
        },
        state: continueState,
        decision: {
          type: "finished" as const,
          finishReason: "wait_pending_reviewers",
        },
      },
      {
        result: {
          agentId: "TaskReview",
          status: "completed" as const,
          reviewAgent: true,
          reviewDecision: "complete" as const,
          agentStatus: "completed" as const,
          agentContextContent: "TaskReview",
          opinion: null,
          allowDirectFallbackWhenNoBatch: false,
          signalDone: false,
        },
        state: completeState,
        decision: {
          type: "finished" as const,
          finishReason: "wait_pending_reviewers",
        },
      },
    ],
    nextSenderId: "CodeReview",
  });

  assert.equal(preferred.length, 1);
  assert.equal(preferred[0]?.result.reviewDecision, "complete");
});

test("scheduler script emulator 纯函数在下一条是显式 dispatch 行时允许 reviewer 先保留更大的真实批次", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      { source: "Build", target: "CodeReview", triggerOn: "transfer", messageMode: "last" },
      { source: "CodeReview", target: "UnitTest", triggerOn: "complete", messageMode: "last" },
      { source: "CodeReview", target: "TaskReview", triggerOn: "complete", messageMode: "last" },
    ],
  };
  const state = createGraphTaskState({
    taskId: "scheduler-script-emulator-test",
    topology,
  });
  const decision: GraphRoutingDecision = {
    type: "execute_batch",
    batch: {
      sourceAgentId: "CodeReview",
      triggerTargets: ["UnitTest", "TaskReview"],
      jobs: [
        {
          agentId: "UnitTest",
          sourceAgentId: "CodeReview",
          kind: "complete",
        },
        {
          agentId: "TaskReview",
          sourceAgentId: "CodeReview",
          kind: "complete",
        },
      ],
    },
  };

  const matched = matchesExpectedTransition({
    line: parseMessageLine("CodeReview: 已确认通过，可以进入后续审查。"),
    nextLine: parseMessageLine("Build: @UnitTest"),
    state,
    decision,
    senderId: "CodeReview",
    reviewDecision: "complete",
    reviewAgent: true,
  });

  assert.equal(matched, true);
});

test("scheduler script emulator 纯函数允许 reviewer 的 execute_batch 先匹配到下一条普通消息 source sender", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      { source: "Build", target: "CodeReview", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
      { source: "CodeReview", target: "Build", triggerOn: "continue", messageMode: "last" },
    ],
  };
  const state = createGraphTaskState({
    taskId: "scheduler-script-emulator-review-next-sender",
    topology,
  });
  const decision: GraphRoutingDecision = {
    type: "execute_batch",
    batch: {
      sourceAgentId: "Build",
      triggerTargets: ["UnitTest", "TaskReview"],
      jobs: [
        {
          agentId: "UnitTest",
          sourceAgentId: "Build",
          kind: "transfer",
        },
        {
          agentId: "TaskReview",
          sourceAgentId: "Build",
          kind: "transfer",
        },
      ],
    },
  };

  const matched = matchesExpectedTransition({
    line: parseMessageLine("CodeReview: 已确认通过，可以进入后续审查。"),
    nextLine: parseMessageLine("Build:"),
    state,
    decision,
    senderId: "CodeReview",
    reviewDecision: "complete",
    reviewAgent: true,
  });

  assert.equal(matched, true);
});

test("scheduler script emulator 纯函数只在下一条显式 dispatch 目标真的是当前批次子集时才放行", () => {
  assert.equal(
    dispatchAssertionTargetsCovered(["UnitTest", "TaskReview"], ["UnitTest"]),
    true,
  );
  assert.equal(
    dispatchAssertionTargetsCovered(["Build"], ["UnitTest"]),
    false,
  );
});

test("scheduler script emulator 纯函数会生成包含脚本目标与实际目标的调度目标不匹配文案", () => {
  const message = buildDispatchTargetMismatchMessage({
    rawLine: "Build: @UnitTest",
    expectedTargets: ["UnitTest"],
    actualTargets: ["UnitTest", "TaskReview"],
  });

  assert.equal(
    message,
    "Build: @UnitTest 的调度目标不匹配。脚本写的是 [UnitTest]，实际是 [UnitTest, TaskReview]",
  );
});

test("scheduler script emulator 纯函数会生成更直接的遗漏调度目标文案", () => {
  const message = buildMissingDispatchTargetsMessage({
    rawLine: "CodeReview: 首轮未通过。",
    scriptTargets: [],
    simulatedTargets: ["Build", "UnitTest", "TaskReview"],
  });

  assert.equal(
    message,
    "CodeReview: 首轮未通过。 脚本包含 []，当前步骤模拟值为 [Build UnitTest TaskReview]",
  );
});

test("scheduler script emulator 纯函数会把下一条回应 agent 不匹配写得更直接", () => {
  const message = buildUnexpectedNextSenderMessage({
    rawLine: "UnitTest: 第 1 轮单测未通过 @Implementer",
    actualSenderId: "UnitTest",
    simulatedTargets: ["Implementer"],
  });

  assert.equal(
    message,
    "UnitTest: 第 1 轮单测未通过 @Implementer 的下一条回应 Agent 不匹配，当前步骤模拟值为 [Implementer]，脚本实际写的是 UnitTest",
  );
});

test("scheduler script emulator 纯函数会把空的 source 行识别为缺失的 dispatch 断言", () => {
  const matched = isImplicitEmptyDispatchAssertionLine({
    line: parseMessageLine("Build:"),
    senderId: "Build",
    decision: {
      type: "execute_batch",
      batch: {
        sourceAgentId: "Build",
        triggerTargets: ["UnitTest", "TaskReview"],
        jobs: [
          {
            agentId: "UnitTest",
            sourceAgentId: "Build",
            kind: "transfer",
          },
          {
            agentId: "TaskReview",
            sourceAgentId: "Build",
            kind: "transfer",
          },
        ],
      },
    },
  });

  assert.equal(matched, true);
});

test("scheduler script emulator 纯函数只允许脚本在 finished 时自然结束", () => {
  assert.equal(
    canImplicitlyFinishScript({
      type: "finished",
      finishReason: "all_agents_completed",
    }),
    true,
  );
  assert.equal(
    canImplicitlyFinishScript({
      type: "finished",
      finishReason: "wait_pending_reviewers",
    }),
    true,
  );
  assert.equal(
    canImplicitlyFinishScript({
      type: "execute_batch",
      batch: {
        sourceAgentId: "Build",
        triggerTargets: ["UnitTest", "TaskReview"],
        jobs: [
          { agentId: "UnitTest", sourceAgentId: "Build", kind: "transfer" },
          { agentId: "TaskReview", sourceAgentId: "Build", kind: "transfer" },
        ],
      },
    }),
    false,
  );
});

test("scheduler script emulator 纯函数不允许最后一条显式 dispatch 断言直接作为脚本终点", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "UnitTest", "TaskReview"],
    edges: [],
  };

  assert.equal(
    canScriptEndAfterLastLine({
      state: createGraphTaskState({
        taskId: "scheduler-script-end-execute-batch",
        topology,
      }),
      lastLine: parseSchedulerScriptLine("Build: @UnitTest @TaskReview"),
      decision: {
        type: "execute_batch",
        batch: {
          sourceAgentId: "Build",
          triggerTargets: ["UnitTest", "TaskReview"],
          jobs: [
            { agentId: "UnitTest", sourceAgentId: "Build", kind: "transfer" },
            { agentId: "TaskReview", sourceAgentId: "Build", kind: "transfer" },
          ],
        },
      },
    }),
    false,
  );
  assert.equal(
    canScriptEndAfterLastLine({
      state: (() => {
        const state = createGraphTaskState({
          taskId: "scheduler-script-end-no-runnable-agents",
          topology,
        });
        state.activeHandoffBatchBySource = {
          Build: {
            dispatchKind: "handoff",
            sourceAgentId: "Build",
            sourceContent: "Build 最终结果",
            targets: ["UnitTest", "TaskReview"],
            pendingTargets: ["UnitTest"],
            respondedTargets: ["TaskReview"],
            sourceRevision: 1,
            failedTargets: [],
          },
        };
        return state;
      })(),
      lastLine: parseSchedulerScriptLine("TaskReview: 通过"),
      decision: {
        type: "finished",
        finishReason: "no_runnable_agents",
      },
    }),
    false,
  );
});

test("scheduler script emulator 纯函数会在脚本提前结束时带出核心里仍未消费完的目标", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "UnitTest", "TaskReview"],
    edges: [],
  };
  const state = createGraphTaskState({
    taskId: "scheduler-script-emulator-unexpected-end",
    topology,
  });
  state.activeHandoffBatchBySource = {
    Build: {
      dispatchKind: "handoff",
      sourceAgentId: "Build",
      sourceContent: "Build 最终结果",
      targets: ["UnitTest", "TaskReview"],
      pendingTargets: ["UnitTest"],
      respondedTargets: ["TaskReview"],
      sourceRevision: 1,
      failedTargets: [],
    },
  };

  assert.equal(
    buildUnexpectedScriptEndMessage({
      state,
      decision: {
        type: "finished",
        finishReason: "no_runnable_agents",
      },
    }),
    "脚本提前结束，当前仍在等待 [UnitTest]，调度状态为 finished -> no_runnable_agents",
  );
});

test("scheduler script emulator 纯函数会要求 reviewer 触发出的外层 execute_batch 必须先由 source 行显式断言", () => {
  assert.equal(
    shouldRequireSourceDispatchAssertion({
      currentSenderId: "CodeReview",
      decision: {
        type: "execute_batch",
        batch: {
          sourceAgentId: "Build",
          triggerTargets: ["UnitTest", "TaskReview"],
          jobs: [
            { agentId: "UnitTest", sourceAgentId: "Build", kind: "transfer" },
            { agentId: "TaskReview", sourceAgentId: "Build", kind: "transfer" },
          ],
        },
      },
      nextSenderId: "UnitTest",
    }),
    true,
  );
  assert.equal(
    shouldRequireSourceDispatchAssertion({
      currentSenderId: "Build",
      decision: {
        type: "execute_batch",
        batch: {
          sourceAgentId: "Build",
          triggerTargets: ["UnitTest", "TaskReview"],
          jobs: [
            { agentId: "UnitTest", sourceAgentId: "Build", kind: "transfer" },
            { agentId: "TaskReview", sourceAgentId: "Build", kind: "transfer" },
          ],
        },
      },
      nextSenderId: "UnitTest",
    }),
    false,
  );
  assert.equal(
    shouldRequireSourceDispatchAssertion({
      currentSenderId: "CodeReview",
      decision: {
        type: "execute_batch",
        batch: {
          sourceAgentId: "TaskReview",
          triggerTargets: ["Build"],
          jobs: [
            { agentId: "Build", sourceAgentId: "TaskReview", kind: "continue_request" },
          ],
        },
      },
      nextSenderId: "Build",
    }),
    false,
  );
});

test("scheduler script emulator 不会根据正文关键词替拓扑上的 review 歧义拍板", async () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "Judge"],
    edges: [
      { source: "Build", target: "Judge", triggerOn: "transfer", messageMode: "last" },
      { source: "Judge", target: "Build", triggerOn: "continue", messageMode: "last" },
      { source: "Judge", target: "Build", triggerOn: "complete", messageMode: "last" },
    ],
  };

  const script = [
    "user: @Build 请完成这个需求。",
    "Build: 首轮实现完成。 @Judge",
    "Judge: 当前结果已经通过。 @Build",
  ];

  await assert.rejects(
    runSchedulerScriptDrived({
      topology,
      script,
    }),
    /无法唯一推断|唯一推断/u,
  );
});

test("scheduler script emulator 在漏洞团队里把第二个 finding 错写成上一轮实例时直接失败", async () => {
  const topology = compileTeamDsl(readBuiltinTopology("vulnerability-team.topology.json")).topology;

  const script = [
    "user: @线索发现 请持续挖掘当前代码中的可疑漏洞点，直到没有新 finding 为止。",
    "线索发现: 发现第 1 个可疑点：上传文件名可能被直接拼进目标路径。 @漏洞挑战-1",
    "漏洞挑战-1: 当前材料还缺少从入口到落盘点的完整调用链。 @漏洞论证-1",
    "漏洞论证-1: 第一轮补证：上传入口会把原始文件名透传到保存逻辑。 @漏洞挑战-1",
    "漏洞挑战-1: 第二轮质疑：还缺少目标路径是否真正受控的证据。 @漏洞论证-1",
    "漏洞论证-1: 第二轮补证：存储层直接执行 path.join(uploadRoot, filename)，未见对 .. 或分隔符的拦截。 @讨论总结-1",
    "讨论总结-1: 当前这条更像真实漏洞。 @线索发现",
    "线索发现: 发现第 2 个可疑点：内部调试接口似乎缺少鉴权。 @漏洞挑战-1",
  ];

  await assert.rejects(
    runSchedulerScriptDrived({
      topology,
      script,
    }),
    /漏洞挑战-2|目标|调度/u,
  );
});

test("scheduler script emulator 要求 execute_batch 必须显式写在当前 agent 行内", async () => {
  const topology: TopologyRecord = {
    nodes: ["BA", "Build"],
    edges: [
      { source: "BA", target: "Build", triggerOn: "transfer", messageMode: "last" },
    ],
  };

  const script = [
    "user: @BA 请先澄清需求。",
    "BA: 需求已澄清，可以交给 Build。",
    "Build: 开始实现。",
  ];

  await assert.rejects(
    runSchedulerScriptDrived({
      topology,
      script,
    }),
    /脚本包含 \[Build\]|当前步骤模拟值为 \[Build\]|execute_batch|调度目标/u,
  );
});

test("scheduler script emulator 不允许 dispatch source 在 batch 未被消费前重复发送普通消息", async () => {
  const topology = createTopology({
    downstream: {
      A: { B: "transfer" },
    },
  });

  const script = [
    "user: @A start",
    "A: first @B",
    "A: second @B",
    "B: ack",
  ];

  await assert.rejects(
    runSchedulerScriptDrived({
      topology,
      script,
    }),
    /下一条回应 Agent 不匹配|当前步骤模拟值为 \[B\]|脚本包含 \[B\]/u,
  );
});

test("scheduler script emulator 不再支持非法短别名", async () => {
  const topology = compileTeamDsl(readBuiltinTopology("vulnerability-team.topology.json")).topology;

  const script = [
    "user: @线索发现 请持续挖掘当前代码中的可疑漏洞点。",
    "线索发现: 发现第 1 个可疑点：上传文件名可能被直接拼进目标路径。 @漏洞挑战-alias1",
  ];

  await assert.rejects(
    runSchedulerScriptDrived({
      topology,
      script,
    }),
    /不存在的 Agent|漏洞挑战-alias1/u,
  );
});

test("scheduler script emulator 要求 reviewer 的 continue 行即使处于等待态也必须显式写出 @targets", async () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      { source: "Build", target: "CodeReview", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
      { source: "CodeReview", target: "Build", triggerOn: "continue", messageMode: "last" },
    ],
  };

  const script = [
    "user: @Build 请完成这个需求。",
    "Build: 首轮实现完成。 @CodeReview @UnitTest @TaskReview",
    "CodeReview: 首轮未通过。",
    "UnitTest: 已收到首轮 Build 结果。",
    "TaskReview: 已收到首轮 Build 结果。",
    "Build: 已根据 CodeReview 意见修复完成。 @CodeReview",
  ];

  await assert.rejects(
    runSchedulerScriptDrived({
      topology,
      script,
    }),
    /@Build|没有显式给出 @Build/u,
  );
});

test("scheduler script emulator 支持 reviewer 在 finished 前就把 deferred continue target 写在当前行", async () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      { source: "Build", target: "CodeReview", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
      { source: "CodeReview", target: "Build", triggerOn: "continue", messageMode: "last" },
    ],
  };

  const script = [
    "user: @Build 请完成这个需求。",
    "Build: 首轮实现完成。 @CodeReview @UnitTest @TaskReview",
    "CodeReview: 首轮未通过。 @Build",
    "UnitTest: 已收到首轮 Build 结果。",
    "TaskReview: 已收到首轮 Build 结果。",
    "Build: 已根据 CodeReview 意见修复完成。 @CodeReview",
  ];

  await assert.rejects(
    runSchedulerScriptDrived({
      topology,
      script,
    }),
    /脚本提前结束|当前还缺少 \[CodeReview\]|CodeReview/u,
  );
});

test("scheduler script emulator 会拒绝非 reviewer 的 UnitTest 显式回流到 Build", async () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      { source: "Build", target: "CodeReview", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
      { source: "CodeReview", target: "Build", triggerOn: "continue", messageMode: "last" },
    ],
  };

  const script = [
    "user: @Build 请完成这个需求。",
    "Build: 首轮实现完成。 @CodeReview @UnitTest @TaskReview",
    "CodeReview: 首轮未通过。 @Build",
    "UnitTest: UnitTest 已收到首轮 Build 结果。 @Build",
    "TaskReview: 已收到首轮 Build 结果。",
    "Build: 已根据 CodeReview 意见修复完成。 @CodeReview",
  ];

  await assert.rejects(
    runSchedulerScriptDrived({
      topology,
      script,
    }),
    /调度目标不匹配|脚本写的是 \[Build\]/u,
  );
});

test("scheduler script emulator 会拒绝非 reviewer 的 TaskReview 显式回流到 Build", async () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      { source: "Build", target: "CodeReview", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
      { source: "CodeReview", target: "Build", triggerOn: "continue", messageMode: "last" },
    ],
  };

  const script = [
    "user: @Build 请完成这个需求。",
    "Build: 首轮实现完成。 @CodeReview @UnitTest @TaskReview",
    "CodeReview: 首轮未通过。 @Build",
    "UnitTest: UnitTest 已收到首轮 Build 结果。",
    "TaskReview: TaskReview 已收到首轮 Build 结果。 @Build",
    "Build: 已根据 CodeReview 意见修复完成。 @CodeReview",
  ];

  await assert.rejects(
    runSchedulerScriptDrived({
      topology,
      script,
    }),
    /不是由当前行直接触发|不应显式声明/u,
  );
});

test("scheduler script emulator 对拼错的显式目标会直接报节点不存在", async () => {
  const topology: TopologyRecord = {
    nodes: ["BA", "Build"],
    edges: [
      { source: "BA", target: "Build", triggerOn: "transfer", messageMode: "last" },
    ],
  };

  const script = [
    "user: @BA 请先澄清需求。",
    "BA: 需求已澄清，交给 Build 继续实现。 @Buil",
  ];

  await assert.rejects(
    runSchedulerScriptDrived({
      topology,
      script,
    }),
    /不存在的 Agent/u,
  );
});

test("scheduler script emulator 在显式目标与真实调度不一致时直接报调度目标不匹配", async () => {
  const topology: TopologyRecord = {
    nodes: ["BA", "Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      { source: "BA", target: "Build", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "CodeReview", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
      { source: "CodeReview", target: "Build", triggerOn: "continue", messageMode: "last" },
    ],
  };

  const script = [
    "user: @BA 请先完成实现，再经过 CodeReview，多轮修复结束后再进入其他审查。",
    "BA: 需求已澄清，交给 Build 继续实现。 @Build",
    "Build: Build 首轮实现完成，交给 CodeReview 审查。 @UnitTest @TaskReview",
  ];

  await assert.rejects(
    runSchedulerScriptDrived({
      topology,
      script,
    }),
    (error: unknown) => {
      assert.match(String(error), /调度目标不匹配/u);
      assert.match(String(error), /脚本写的是 \[UnitTest, TaskReview\]/u);
      assert.match(String(error), /实际是 \[CodeReview, UnitTest, TaskReview\]/u);
      assert.doesNotMatch(String(error), /匹配数量为 0|无法唯一推断/u);
      return true;
    },
  );
});

test("scheduler script emulator 会把 reviewer 之后遗漏的后续派发归因到当前 Build 行", async () => {
  const topology: TopologyRecord = {
    nodes: ["BA", "Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      { source: "BA", target: "Build", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "CodeReview", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
      { source: "CodeReview", target: "Build", triggerOn: "continue", messageMode: "last" },
    ],
  };

  const script = [
    "user: @BA 请先完成实现，再经过 CodeReview，多轮修复结束后再进入其他审查。",
    "BA: 需求已澄清，交给 Build 继续实现。 @Build",
    "Build: Build 首轮实现完成， @CodeReview @UnitTest @TaskReview",
    "CodeReview: CodeReview 首轮未通过。 @Build",
    "UnitTest: UnitTest 已收到首轮 Build 结果。",
    "TaskReview: TaskReview 已收到首轮 Build 结果。",
    "Build: Build 已根据 CodeReview 意见修复完成。 @CodeReview",
    "CodeReview: 已确认通过，可以进入后续审查。",
    "Build:",
    "UnitTest: UnitTest 已收到最终 Build 结果。",
    "TaskReview: TaskReview 已收到最终 Build 结果。",
  ];

  await assert.rejects(
    runSchedulerScriptDrived({
      topology,
      script,
    }),
    (error: unknown) => {
      assert.match(String(error), /^AssertionError \[ERR_ASSERTION\]: Build: 脚本包含 \[\]，当前步骤模拟值为 \[UnitTest TaskReview\]/u);
      assert.doesNotMatch(String(error), /CodeReview: 已确认通过/u);
      return true;
    },
  );
});

test("scheduler script emulator 会拒绝漏掉 reviewer 之后的 Build 派发行", async () => {
  const topology: TopologyRecord = {
    nodes: ["BA", "Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      { source: "BA", target: "Build", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "CodeReview", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
      { source: "CodeReview", target: "Build", triggerOn: "continue", messageMode: "last" },
    ],
  };

  const script = [
    "user: @BA 请先完成实现，再经过 CodeReview，多轮修复结束后再进入其他审查。",
    "BA: 需求已澄清，交给 Build 继续实现。 @Build",
    "Build: Build 首轮实现完成， @CodeReview @UnitTest @TaskReview",
    "CodeReview: CodeReview 首轮未通过。 @Build",
    "UnitTest: UnitTest 已收到首轮 Build 结果。",
    "TaskReview: TaskReview 已收到首轮 Build 结果。",
    "Build: Build 已根据 CodeReview 意见修复完成。 @CodeReview",
    "CodeReview: 已确认通过，可以进入后续审查。",
    "UnitTest: UnitTest 已收到最终 Build 结果。",
    "TaskReview: TaskReview 已收到最终 Build 结果。",
  ];

  await assert.rejects(
    runSchedulerScriptDrived({ topology, script }),
    /Build|UnitTest|TaskReview/u,
  );
});

test("scheduler script emulator 会拒绝漏掉最终 UnitTest 回复", async () => {
  const topology: TopologyRecord = {
    nodes: ["BA", "Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      { source: "BA", target: "Build", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "CodeReview", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
      { source: "CodeReview", target: "Build", triggerOn: "continue", messageMode: "last" },
    ],
  };

  const script = [
    "user: @BA 请先完成实现，再经过 CodeReview，多轮修复结束后再进入其他审查。",
    "BA: 需求已澄清，交给 Build 继续实现。 @Build",
    "Build: Build 首轮实现完成， @CodeReview @UnitTest @TaskReview",
    "CodeReview: CodeReview 首轮未通过。 @Build",
    "UnitTest: UnitTest 已收到首轮 Build 结果。",
    "TaskReview: TaskReview 已收到首轮 Build 结果。",
    "Build: Build 已根据 CodeReview 意见修复完成。 @CodeReview",
    "CodeReview: 已确认通过，可以进入后续审查。",
    "Build: @UnitTest @TaskReview",
    "TaskReview: TaskReview 已收到最终 Build 结果。",
  ];

  await assert.rejects(
    runSchedulerScriptDrived({ topology, script }),
    /当前仍在等待 \[UnitTest\]|UnitTest/u,
  );
});

test("scheduler script emulator 会拒绝漏掉最终 TaskReview 回复", async () => {
  const topology: TopologyRecord = {
    nodes: ["BA", "Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      { source: "BA", target: "Build", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "CodeReview", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
      { source: "CodeReview", target: "Build", triggerOn: "continue", messageMode: "last" },
    ],
  };

  const script = [
    "user: @BA 请先完成实现，再经过 CodeReview，多轮修复结束后再进入其他审查。",
    "BA: 需求已澄清，交给 Build 继续实现。 @Build",
    "Build: Build 首轮实现完成， @CodeReview @UnitTest @TaskReview",
    "CodeReview: CodeReview 首轮未通过。 @Build",
    "UnitTest: UnitTest 已收到首轮 Build 结果。",
    "TaskReview: TaskReview 已收到首轮 Build 结果。",
    "Build: Build 已根据 CodeReview 意见修复完成。 @CodeReview",
    "CodeReview: 已确认通过，可以进入后续审查。",
    "Build: @UnitTest @TaskReview",
    "UnitTest: UnitTest 已收到最终 Build 结果。",
  ];

  await assert.rejects(
    runSchedulerScriptDrived({ topology, script }),
    /当前仍在等待 \[TaskReview\]|TaskReview/u,
  );
});

test("scheduler script emulator 会拒绝漏掉最后一批全部消费者", async () => {
  const topology: TopologyRecord = {
    nodes: ["Implementer", "UnitTest", "TaskReview", "CodeReview"],
    edges: [
      { source: "Implementer", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
      { source: "Implementer", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
      { source: "Implementer", target: "CodeReview", triggerOn: "transfer", messageMode: "last" },
      { source: "UnitTest", target: "Implementer", triggerOn: "continue", messageMode: "last" },
    ],
  };

  const script = [
    "user: @Implementer 请完成这个需求",
    "Implementer: 第 1 轮实现完成 @UnitTest @TaskReview @CodeReview",
    "UnitTest: 第 1 轮单测未通过 @Implementer",
    "TaskReview: 认可",
    "CodeReview: 认可",
    "Implementer: 已修复第 1 轮问题 @UnitTest",
    "UnitTest: 第 2 轮单测未通过 @Implementer",
    "Implementer: 已修复第 2 轮问题 @UnitTest",
    "UnitTest: 认可",
    "Implementer: @TaskReview @CodeReview",
  ];

  await assert.rejects(
    runSchedulerScriptDrived({ topology, script }),
    /脚本提前结束|当前还缺少|TaskReview|CodeReview|execute_batch/u,
  );
});
