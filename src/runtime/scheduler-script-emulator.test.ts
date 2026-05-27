import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  buildTopologyNodeRecords,
  createTopologyFlowRecord,
  type TopologyRecord,
} from "@shared/types";

import {
  buildDispatchOmissionVariants,
  buildUnexpectedNextSenderMessage,
  buildUnexpectedScriptEndMessage,
  buildMissingDispatchTargetsMessage,
  buildDispatchTargetMismatchMessage,
  canScriptEndAfterLastLine,
  collectRequiredConsumerMessages,
  collectRequiredDispatchAssertions,
  dispatchAssertionTargetsCovered,
  isImplicitEmptyDispatchAssertionLine,
  matchesExpectedTransition as matchesExpectedTransitionCore,
  preferWaitingDecisionCandidatesForPendingNextSender as preferPendingDecisionCandidatesForNextSender,
  runSchedulerScriptDrived,
  shouldRequireSourceDispatchAssertion,
} from "../../test-support/runtime/scheduler-script-emulator";
import {
  parseSchedulerScriptLine,
} from "../../test-support/runtime/scheduler-script-dsl";
import {
  type GraphDispatchBatch,
  type GraphRoutingDecision,
} from "./gating-router";
import { createEmptyGraphTaskState } from "./gating-state";
import { compileBuiltinTopology } from "../../test-support/runtime/builtin-topology-test-helpers";
import { createTopology } from "../../test-support/runtime/topology-test-dsl";

type MatchesExpectedTransitionCoreInput = Parameters<typeof matchesExpectedTransitionCore>[0];
type MatchesExpectedTransitionBaseInput =
  Omit<MatchesExpectedTransitionCoreInput, "routingKind" | "trigger">;
type TransferDispatchJob = Extract<GraphDispatchBatch["jobs"][number], { kind: "transfer" }>;
type TriggeredDispatchJob = Extract<GraphDispatchBatch["jobs"][number], { kind: "dispatch" }>;

function parseMessageLine(line: string) {
  const parsed = parseSchedulerScriptLine(line);
  if (parsed.kind !== "message") {
    assert.fail(`期望 message 脚本行，实际收到 ${parsed.kind}`);
  }
  return parsed;
}

function matchesExpectedTransition(
  input: MatchesExpectedTransitionBaseInput & (
    | { routingKind: "default" }
    | { routingKind: "invalid" }
    | { routingKind: "triggered"; trigger: string }
  ),
): boolean {
  if (input.routingKind === "triggered") {
    return matchesExpectedTransitionCore({
      ...input,
      routingKind: "triggered",
      trigger: input.trigger,
    });
  }
  if (input.routingKind === "invalid") {
    return matchesExpectedTransitionCore({
      ...input,
      routingKind: "invalid",
    });
  }
  return matchesExpectedTransitionCore({
    ...input,
    routingKind: "default",
  });
}

function renderTriggerBlock(trigger: string, content: string): string {
  return `${trigger}${content}</${trigger.slice(1, -1)}>`;
}

function withAgentNodeRecords(
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

function createTransferJob(agentId: string, sourceAgentId: string): TransferDispatchJob {
  return {
    agentId,
    sourceAgentId,
    sourceContent: "",
    displayContent: "",
    kind: "transfer",
  };
}

function createDispatchJob(agentId: string, sourceAgentId: string): TriggeredDispatchJob {
  return {
    agentId,
    sourceAgentId,
    sourceMessageId: "message-1",
    sourceContent: "",
    displayContent: "",
    kind: "dispatch",
  };
}

function createRepresentativeScript() {
  return [
    "user: @BA 请先完成实现，再经过 CodeReview，多轮修复结束后再进入其他判定。",
    "BA: 需求已澄清，交给 Build 继续实现。 @Build",
    "Build: Build 首轮实现完成， @CodeReview @UnitTest @TaskReview",
    "CodeReview: CodeReview 首轮未通过。 @Build",
    "Build: Build 已根据 CodeReview 意见修复完成。 @CodeReview",
    "CodeReview: 已确认通过，可以进入后续判定。\n\n<approved>继续后续判定</approved> @UnitTest @TaskReview",
    "UnitTest: UnitTest 已收到最终 Build 结果。",
    "TaskReview: TaskReview 已收到最终 Build 结果。",
  ];
}

function createRepresentativeTopology(): TopologyRecord {
  return withAgentNodeRecords({
    nodes: ["BA", "Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      {
        source: "BA",
        target: "Build",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "Build",
        target: "CodeReview",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "Build",
        target: "UnitTest",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "Build",
        target: "TaskReview",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "CodeReview",
        target: "Build",
        trigger: "<continue>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "CodeReview",
        target: "UnitTest",
        trigger: "<approved>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "CodeReview",
        target: "TaskReview",
        trigger: "<approved>",
        messageMode: "last", maxTriggerRounds: 4,
      },
    ],
  });
}

test("scheduler script drived 支持漏洞团队 2 个 finding 且每个 finding 各有两轮正反讨论后结束", async () => {
  const topology = compileBuiltinTopology("vulnerability.yaml").topology;

  const script = [
    "user: @线索发现 请持续挖掘当前代码中的可疑漏洞点，直到没有新 finding 为止。",
    "线索发现: 发现第 1 个可疑点：上传文件名可能被直接拼进目标路径。 @误报论证-1",
    "误报论证-1: 当前材料还缺少从入口到落盘点的完整调用链。 @漏洞论证-1",
    "漏洞论证-1: 第一轮补证：上传入口会把原始文件名透传到保存逻辑。 @误报论证-1",
    "误报论证-1: 第二轮质疑：还缺少目标路径是否真正受控的证据。 @漏洞论证-1",
    "漏洞论证-1: <agree>第二轮补证：存储层直接执行 path.join(uploadRoot, filename)，未见对 .. 或分隔符的拦截。</agree> @讨论总结-1",
    "讨论总结-1: 当前这条更像真实漏洞。 @线索发现",
    "线索发现: 发现第 2 个可疑点：内部调试接口似乎缺少鉴权。 @误报论证-2",
    "误报论证-2: 当前材料更像误报，缺少生产环境可达性证据。 @漏洞论证-2",
    "漏洞论证-2: 第一轮补证：调试路由默认注册，且局部未见鉴权中间件。 @误报论证-2",
    "误报论证-2: 第二轮质疑：仍然缺少环境开关实际放行的证据。 @漏洞论证-2",
    "漏洞论证-2: <agree>第二轮补证后，当前仍无法证明生产环境可利用，只能进入总结。</agree> @讨论总结-2",
    "讨论总结-2: 当前这条更像误报。 @线索发现",
    "线索发现: 已检查 HTTP/2 请求入口、管理后台导出接口，暂时没有新的可疑点；内部任务执行入口仍缺少更细代码证据。 @线索完备性评估",
    `线索完备性评估: ${renderTriggerBlock("<complete>", "当前高价值入口已经覆盖，可以结束本轮。")}`,
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("scheduler script drived 接受内置漏洞团队拓扑里单边触发直接进入讨论总结", async () => {
  const topology = compileBuiltinTopology("vulnerability.yaml").topology;

  const script = [
    "user: @线索发现 请持续挖掘当前代码中的可疑漏洞点，直到没有新 finding 为止。",
    "线索发现: 发现第 1 个可疑点：上传文件名可能被直接拼进目标路径。 @误报论证-1",
    "误报论证-1: <agree>当前材料已经足够，可以进入总结。</agree> @讨论总结-1",
    "讨论总结-1: 当前这条更像误报。 @线索发现",
    "线索发现: 已检查内部调试接口，当前没有新的可疑点。 @线索完备性评估",
    `线索完备性评估: ${renderTriggerBlock("<complete>", "当前高价值入口已经覆盖，可以结束本轮。")}`,
  ];

  await assert.doesNotReject(
    () => runSchedulerScriptDrived({ topology, script }),
  );
});

test("scheduler script emulator 纯函数会从真实核心轨迹里收集必须显式出现的 dispatch 断言", async () => {
  const topology = createRepresentativeTopology();

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
      {
        lineIndex: 1,
        senderId: "BA",
        targets: ["Build"],
        kind: "inline_dispatch",
      },
      {
        lineIndex: 2,
        senderId: "Build",
        targets: ["CodeReview", "UnitTest", "TaskReview"],
        kind: "inline_dispatch",
      },
      {
        lineIndex: 3,
        senderId: "CodeReview",
        targets: ["Build"],
        kind: "inline_dispatch",
      },
      {
        lineIndex: 4,
        senderId: "Build",
        targets: ["CodeReview"],
        kind: "inline_dispatch",
      },
      {
        lineIndex: 5,
        senderId: "CodeReview",
        targets: ["UnitTest", "TaskReview"],
        kind: "inline_dispatch",
      },
    ],
  );
});

test("scheduler script emulator 纯函数会从真实核心轨迹里收集每批调度实际消费到的消息", async () => {
  const topology = createRepresentativeTopology();

  const trace = await runSchedulerScriptDrived({
    topology,
    script: createRepresentativeScript(),
  });
  const consumedMessages = collectRequiredConsumerMessages(trace);

  assert.deepEqual(
    consumedMessages
      .filter((item) => item.dispatchLineIndex === 5)
      .map((item) => ({
        dispatchLineIndex: item.dispatchLineIndex,
        consumerLineIndex: item.consumerLineIndex,
        consumerAgentId: item.consumerAgentId,
      })),
    [
      {
        dispatchLineIndex: 5,
        consumerLineIndex: 6,
        consumerAgentId: "UnitTest",
      },
    ],
  );
});

test("scheduler script emulator 纯函数会基于真实核心轨迹自动派生缺失 target、dispatch 行和 consumer 行", async () => {
  const topology = createRepresentativeTopology();

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
    variants.some(
      (variant) =>
        variant.kind === "missing_target" &&
        variant.sourceLineIndex === 1 &&
        variant.removedTarget === "Build",
    ),
  );
  assert.ok(
    variants.some(
      (variant) =>
        variant.kind === "missing_target" &&
        [2, 4, 5].includes(variant.sourceLineIndex) &&
        variant.removedTarget === "CodeReview",
    ),
  );
  assert.ok(
    variants.some(
      (variant) =>
        variant.kind === "missing_consumer_line" &&
        variant.sourceLineIndex === 0 &&
        variant.removedMessageLineIndex === 1,
    ),
  );
  assert.equal(
    variants.some(
      (variant) =>
        variant.kind === "missing_consumer_line" &&
        variant.sourceLineIndex === 5 &&
        variant.removedMessageLineIndex === 6,
    ),
    false,
  );
  assert.ok(
    variants.some(
      (variant) =>
        variant.kind === "truncate_after_line" &&
        variant.sourceLineIndex === 5 &&
        variant.script.length === 6,
    ),
  );
});

test("scheduler script emulator 自动派生的 missing_consumer_line 会抓住 source 抢跑下一轮", async () => {
  const topology = createTopology({
    downstream: {
      A: {
        B: "<default>",
      },
      B: {
        A: {
          trigger: "<continue>",
          maxTriggerRounds: 4,
        },
        Archive: "<done>",
      },
    },
  });
  const script = [
    "user: @A start",
    "A: first @B",
    "B: feedback @A",
    "A: second @B",
    "B: 当前已经可以结束。\n\n<done>done</done> @Archive",
    "Archive: done",
  ];
  const trace = await runSchedulerScriptDrived({
    topology,
    script,
  });
  const variants = buildDispatchOmissionVariants({
    script,
    trace,
  });
  const variant = variants.find(
    (item) =>
      item.kind === "missing_consumer_line" &&
      item.sourceLineIndex === 1 &&
      item.removedMessageLineIndex === 2,
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

test("scheduler script emulator 在 decision 决策无法唯一推断时直接失败", async () => {
  const topology: TopologyRecord = withAgentNodeRecords({
    nodes: ["Build", "Judge"],
    edges: [
      {
        source: "Build",
        target: "Judge",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "Judge",
        target: "Build",
        trigger: "<continue>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "Judge",
        target: "Build",
        trigger: "<complete>",
        messageMode: "last", maxTriggerRounds: 4,
      },
    ],
  });

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

test("scheduler script emulator 纯函数在 finished 状态下不会再为下一条 sender 提供额外候选筛选", () => {
  const preferred = preferPendingDecisionCandidatesForNextSender({
    candidates: [
      {
        result: {
          agentId: "TaskReview",
          messageId: "message:TaskReview:<continue>",
          status: "completed" as const,
          decisionAgent: true,
          routingKind: "triggered" as const,
          trigger: "<continue>",
          agentStatus: "completed" as const,
          agentContextContent: "TaskReview",
          forwardedAgentMessage: "",
          signalDone: false,
        },
        state: createEmptyGraphTaskState({
          taskId: "scheduler-script-emulator-prefer-finished-1",
          topology: withAgentNodeRecords({ nodes: ["Build", "TaskReview"], edges: [] }),
        }),
        decision: {
          type: "finished" as const,
          finishReason: "no_runnable_agents",
        },
      },
      {
        result: {
          agentId: "TaskReview",
          messageId: "message:TaskReview:<complete>",
          status: "completed" as const,
          decisionAgent: true,
          routingKind: "triggered" as const,
          trigger: "<complete>",
          agentStatus: "completed" as const,
          agentContextContent: "TaskReview",
          forwardedAgentMessage: "",
          signalDone: false,
        },
        state: createEmptyGraphTaskState({
          taskId: "scheduler-script-emulator-prefer-finished-2",
          topology: withAgentNodeRecords({ nodes: ["Build", "TaskReview"], edges: [] }),
        }),
        decision: {
          type: "finished" as const,
          finishReason: "no_runnable_agents",
        },
      },
    ],
    nextSenderId: "CodeReview",
  });

  assert.equal(preferred.length, 2);
  assert.deepEqual(preferred.map((item) => item.result.trigger), ["<continue>", "<complete>"]);
});

test("scheduler script emulator 纯函数在下一条是显式 dispatch 行时允许 decisionAgent 先保留更大的真实批次", () => {
  const topology: TopologyRecord = withAgentNodeRecords({
    nodes: ["Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      {
        source: "Build",
        target: "CodeReview",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "CodeReview",
        target: "UnitTest",
        trigger: "<complete>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "CodeReview",
        target: "TaskReview",
        trigger: "<complete>",
        messageMode: "last", maxTriggerRounds: 4,
      },
    ],
  });
  const state = createEmptyGraphTaskState({
    taskId: "scheduler-script-emulator-test",
    topology,
  });
  const decision: GraphRoutingDecision = {
    type: "execute_batch",
    batch: {
      routingKind: "triggered",
      source: { kind: "agent", agentId: "CodeReview" },
      sourceContent: "",
      displayContent: "",
      trigger: "<complete>",
      triggerTargets: ["UnitTest", "TaskReview"],
      jobs: [
        createDispatchJob("UnitTest", "CodeReview"),
        createDispatchJob("TaskReview", "CodeReview"),
      ],
    },
  };

  const matched = matchesExpectedTransition({
    line: parseMessageLine(`CodeReview: ${renderTriggerBlock("<complete>", "已确认通过，可以进入后续判定。")}`),
    nextLine: parseMessageLine("Build: @UnitTest"),
    state,
    routingDecision: decision,
    senderId: "CodeReview",
    routingKind: "triggered",
    trigger: "<complete>",
    decisionAgent: true,
  });

  assert.equal(matched, true);
});

test("scheduler script emulator 纯函数允许 decisionAgent 的 execute_batch 先匹配到下一条普通消息 source sender", () => {
  const topology: TopologyRecord = withAgentNodeRecords({
    nodes: ["Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      {
        source: "Build",
        target: "CodeReview",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "Build",
        target: "UnitTest",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "Build",
        target: "TaskReview",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "CodeReview",
        target: "Build",
        trigger: "<continue>",
        messageMode: "last", maxTriggerRounds: 4,
      },
    ],
  });
  const state = createEmptyGraphTaskState({
    taskId: "scheduler-script-emulator-decision-next-sender",
    topology,
  });
  const decision: GraphRoutingDecision = {
    type: "execute_batch",
    batch: {
      routingKind: "default",
      source: { kind: "agent", agentId: "Build" },
      sourceContent: "",
      displayContent: "",
      triggerTargets: ["UnitTest", "TaskReview"],
      jobs: [
        createTransferJob("UnitTest", "Build"),
        createTransferJob("TaskReview", "Build"),
      ],
    },
  };

  const matched = matchesExpectedTransition({
    line: parseMessageLine(`CodeReview: ${renderTriggerBlock("<complete>", "已确认通过，可以进入后续判定。")}`),
    nextLine: parseMessageLine("Build:"),
    state,
    routingDecision: decision,
    senderId: "CodeReview",
    routingKind: "triggered",
    trigger: "<complete>",
    decisionAgent: true,
  });

  assert.equal(matched, true);
});

test("scheduler script emulator 纯函数不允许 execute_batch 在脚本可见目标之外还夹带隐藏的旧 runtime target", () => {
  const topology: TopologyRecord = withAgentNodeRecords({
    nodes: ["线索发现", "疑点辩论", "误报论证"],
    nodeRecords: [
      { id: "线索发现", kind: "agent", templateName: "线索发现", initialMessageRouting: { mode: "inherit" }, prompt: "", writable: false },
      { id: "疑点辩论", kind: "group", templateName: "疑点辩论", groupRuleId: "group-rule:疑点辩论", initialMessageRouting: { mode: "inherit" } },
      { id: "误报论证", kind: "agent", templateName: "误报论证", initialMessageRouting: { mode: "inherit" }, prompt: "", writable: false },
    ],
    edges: [
      { source: "线索发现", target: "疑点辩论", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
    ],
  });
  const state = createEmptyGraphTaskState({
    taskId: "scheduler-script-emulator-hidden-runtime-target",
    topology,
  });
  state.runtimeNodes = [
    {
      id: "误报论证-1",
      kind: "agent",
      templateName: "误报论证",
      displayName: "误报论证-1",
      sourceNodeId: "疑点辩论",
      groupId: "group-old",
      role: "误报论证",
    },
    {
      id: "误报论证-2",
      kind: "agent",
      templateName: "误报论证",
      displayName: "误报论证-2",
      sourceNodeId: "疑点辩论",
      groupId: "group-new",
      role: "误报论证",
    },
  ];
  state.groupActivations = [
    {
      id: "activation-old",
      groupNodeName: "疑点辩论",
      groupRuleId: "group-rule:疑点辩论",
      sourceContent: "旧 finding",
      bundleGroupIds: ["group-old"],
      completedBundleGroupIds: ["group-old"],
      dispatched: true,
    },
    {
      id: "activation-new",
      groupNodeName: "疑点辩论",
      groupRuleId: "group-rule:疑点辩论",
      sourceContent: "新 finding",
      bundleGroupIds: ["group-new"],
      completedBundleGroupIds: [],
      dispatched: false,
    },
  ];
  const decision: GraphRoutingDecision = {
    type: "execute_batch",
    batch: {
      routingKind: "triggered",
      source: { kind: "agent", agentId: "线索发现" },
      sourceContent: "",
      displayContent: "",
      trigger: "<continue>",
      triggerTargets: ["误报论证-2", "误报论证-1"],
      jobs: [
        createDispatchJob("误报论证-2", "线索发现"),
        createDispatchJob("误报论证-1", "线索发现"),
      ],
    },
  };

  const matched = matchesExpectedTransition({
    line: parseMessageLine("线索发现: 发现第 2 个可疑点。 @误报论证-2"),
    nextLine: parseMessageLine("误报论证-2: 当前材料仍需补证。"),
    state,
    routingDecision: decision,
    senderId: "线索发现",
    routingKind: "triggered",
    trigger: "<continue>",
    decisionAgent: true,
  });

  assert.equal(matched, false);
});

test("scheduler script emulator 纯函数只在下一条显式 dispatch 目标真的是当前批次子集时才放行", () => {
  assert.equal(
    dispatchAssertionTargetsCovered(["UnitTest", "TaskReview"], ["UnitTest"]),
    true,
  );
  assert.equal(dispatchAssertionTargetsCovered(["Build"], ["UnitTest"]), false);
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
        routingKind: "default",
        source: { kind: "agent", agentId: "Build" },
        sourceContent: "",
        displayContent: "",
        triggerTargets: ["UnitTest", "TaskReview"],
        jobs: [
          createTransferJob("UnitTest", "Build"),
          createTransferJob("TaskReview", "Build"),
        ],
      },
    },
  });

  assert.equal(matched, true);
});

test("scheduler script emulator 纯函数不允许最后一条显式 dispatch 断言直接作为脚本终点", () => {
  assert.equal(
    canScriptEndAfterLastLine({
      type: "execute_batch",
      batch: {
        routingKind: "default",
        source: { kind: "agent", agentId: "Build" },
        sourceContent: "",
        displayContent: "",
        triggerTargets: ["UnitTest", "TaskReview"],
        jobs: [
          createTransferJob("UnitTest", "Build"),
          createTransferJob("TaskReview", "Build"),
        ],
      },
    }),
    false,
  );
  assert.equal(
    canScriptEndAfterLastLine({
      type: "finished",
      finishReason: "no_runnable_agents",
    }),
    true,
  );
});

test("scheduler script emulator 纯函数会在脚本提前结束时带出未完成的 execute_batch 目标", () => {
  const topology: TopologyRecord = withAgentNodeRecords({
    nodes: ["Build", "UnitTest", "TaskReview"],
    edges: [],
  });
  const state = createEmptyGraphTaskState({
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
      sourceRound: 1,
      failedTargets: [],
    },
  };

  assert.equal(
    buildUnexpectedScriptEndMessage({
      state,
      decision: {
        type: "execute_batch",
        batch: {
          routingKind: "default",
          source: { kind: "agent", agentId: "Build" },
          sourceContent: "",
          displayContent: "",
          triggerTargets: ["UnitTest"],
          jobs: [
            createTransferJob("UnitTest", "Build"),
          ],
        },
      },
    }),
    "脚本提前结束，当前还缺少 [UnitTest] 这批调度断言，调度状态为 execute_batch -> [UnitTest]",
  );
});

test("scheduler script emulator 纯函数会要求 decisionAgent 触发出的外层 execute_batch 必须先由 source 行显式断言", () => {
  assert.equal(
    shouldRequireSourceDispatchAssertion({
      currentSenderId: "CodeReview",
      decision: {
        type: "execute_batch",
        batch: {
          routingKind: "default",
          source: { kind: "agent", agentId: "Build" },
          sourceContent: "",
          displayContent: "",
          triggerTargets: ["UnitTest", "TaskReview"],
          jobs: [
            createTransferJob("UnitTest", "Build"),
            createTransferJob("TaskReview", "Build"),
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
          routingKind: "default",
          source: { kind: "agent", agentId: "Build" },
          sourceContent: "",
          displayContent: "",
          triggerTargets: ["UnitTest", "TaskReview"],
          jobs: [
            createTransferJob("UnitTest", "Build"),
            createTransferJob("TaskReview", "Build"),
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
          routingKind: "triggered",
          source: { kind: "agent", agentId: "TaskReview" },
          sourceContent: "",
          displayContent: "",
          trigger: "<continue>",
          triggerTargets: ["Build"],
          jobs: [createDispatchJob("Build", "TaskReview")],
        },
      },
      nextSenderId: "Build",
    }),
    true,
  );
});

test("scheduler script emulator 不会根据正文关键词替拓扑上的 decision 歧义拍板", async () => {
  const topology: TopologyRecord = withAgentNodeRecords({
    nodes: ["Build", "Judge"],
    edges: [
      {
        source: "Build",
        target: "Judge",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "Judge",
        target: "Build",
        trigger: "<continue>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "Judge",
        target: "Build",
        trigger: "<complete>",
        messageMode: "last", maxTriggerRounds: 4,
      },
    ],
  });

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
  const topology = compileBuiltinTopology("vulnerability.yaml").topology;

  const script = [
    "user: @线索发现 请持续挖掘当前代码中的可疑漏洞点，直到没有新 finding 为止。",
    "线索发现: 发现第 1 个可疑点：上传文件名可能被直接拼进目标路径。 @误报论证-1",
    "误报论证-1: 当前材料还缺少从入口到落盘点的完整调用链。 @漏洞论证-1",
    "漏洞论证-1: 第一轮补证：上传入口会把原始文件名透传到保存逻辑。 @误报论证-1",
    "误报论证-1: 第二轮质疑：还缺少目标路径是否真正受控的证据。 @漏洞论证-1",
    "漏洞论证-1: <agree>第二轮补证：存储层直接执行 path.join(uploadRoot, filename)，未见对 .. 或分隔符的拦截。</agree> @讨论总结-1",
    "讨论总结-1: 当前这条更像真实漏洞。 @线索发现",
    "线索发现: 发现第 2 个可疑点：内部调试接口似乎缺少鉴权。 @误报论证-1",
  ];

  await assert.rejects(
    runSchedulerScriptDrived({
      topology,
      script,
    }),
    /误报论证-2|目标|调度/u,
  );
});

test("scheduler script emulator 要求 execute_batch 必须显式写在当前 agent 行内", async () => {
  const topology: TopologyRecord = withAgentNodeRecords({
    nodes: ["BA", "Build"],
    edges: [
      {
        source: "BA",
        target: "Build",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
    ],
  });

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
      A: { B: "<default>" },
    },
  });

  const script = ["user: @A start", "A: first @B", "A: second @B", "B: ack"];

  await assert.rejects(
    runSchedulerScriptDrived({
      topology,
      script,
    }),
    /下一条回应 Agent 不匹配|当前步骤模拟值为 \[B\]|脚本包含 \[B\]/u,
  );
});

test("scheduler script emulator 不再支持非法短别名", async () => {
  const topology = compileBuiltinTopology("vulnerability.yaml").topology;

  const script = [
    "user: @线索发现 请持续挖掘当前代码中的可疑漏洞点。",
    "线索发现: 发现第 1 个可疑点：上传文件名可能被直接拼进目标路径。 @误报论证-alias1",
  ];

  await assert.rejects(
    runSchedulerScriptDrived({
      topology,
      script,
    }),
    /不存在的 Agent|误报论证-alias1/u,
  );
});

test("scheduler script emulator 要求 decisionAgent 的 trigger label 行即使处于等待态也必须显式写出 @targets", async () => {
  const topology: TopologyRecord = withAgentNodeRecords({
    nodes: ["Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      {
        source: "Build",
        target: "CodeReview",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "Build",
        target: "UnitTest",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "Build",
        target: "TaskReview",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "CodeReview",
        target: "Build",
        trigger: "<continue>",
        messageMode: "last", maxTriggerRounds: 4,
      },
    ],
  });

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
    /@Build|没有显式给出 @Build|脚本包含 \[\]|当前步骤模拟值为 \[Build\]/u,
  );
});

test("scheduler script emulator 支持 decisionAgent 在 finished 前就把 deferred trigger target 写在当前行", async () => {
  const topology: TopologyRecord = withAgentNodeRecords({
    nodes: ["Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      {
        source: "Build",
        target: "CodeReview",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "Build",
        target: "UnitTest",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "Build",
        target: "TaskReview",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "CodeReview",
        target: "Build",
        trigger: "<continue>",
        messageMode: "last", maxTriggerRounds: 4,
      },
    ],
  });

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
    /脚本提前结束|当前还缺少 \[CodeReview\]|CodeReview|下一条回应 Agent 不匹配/u,
  );
});

test("scheduler script emulator 会拒绝非 decisionAgent 的 UnitTest 显式回流到 Build", async () => {
  const topology: TopologyRecord = withAgentNodeRecords({
    nodes: ["Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      {
        source: "Build",
        target: "CodeReview",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "Build",
        target: "UnitTest",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "Build",
        target: "TaskReview",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "CodeReview",
        target: "Build",
        trigger: "<continue>",
        messageMode: "last", maxTriggerRounds: 4,
      },
    ],
  });

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
    /调度目标不匹配|脚本写的是 \[Build\]|下一条回应 Agent 不匹配/u,
  );
});

test("scheduler script emulator 会拒绝非 decisionAgent 的 TaskReview 显式回流到 Build", async () => {
  const topology: TopologyRecord = withAgentNodeRecords({
    nodes: ["Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      {
        source: "Build",
        target: "CodeReview",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "Build",
        target: "UnitTest",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "Build",
        target: "TaskReview",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "CodeReview",
        target: "Build",
        trigger: "<continue>",
        messageMode: "last", maxTriggerRounds: 4,
      },
    ],
  });

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
    /不是由当前行直接触发|不应显式声明|下一条回应 Agent 不匹配|调度目标不匹配/u,
  );
});

test("scheduler script emulator 对拼错的显式目标会直接报节点不存在", async () => {
  const topology: TopologyRecord = withAgentNodeRecords({
    nodes: ["BA", "Build"],
    edges: [
      {
        source: "BA",
        target: "Build",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
    ],
  });

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
  const topology = createRepresentativeTopology();

  const script = [
    "user: @BA 请先完成实现，再经过 CodeReview，多轮修复结束后再进入其他判定。",
    "BA: 需求已澄清，交给 Build 继续实现。 @Build",
    "Build: Build 首轮实现完成，交给 CodeReview 判定。 @UnitTest @TaskReview",
  ];

  await assert.rejects(
    runSchedulerScriptDrived({
      topology,
      script,
    }),
    (error: unknown) => {
      assert.match(String(error), /调度目标不匹配/u);
      assert.match(String(error), /脚本写的是 \[UnitTest, TaskReview\]/u);
      assert.match(
        String(error),
        /实际是 \[CodeReview, UnitTest, TaskReview\]/u,
      );
      assert.doesNotMatch(String(error), /匹配数量为 0|无法唯一推断/u);
      return true;
    },
  );
});

test("scheduler script emulator 会把 decisionAgent 之后遗漏的后续派发归因到当前 Build 行", async () => {
  const topology = createRepresentativeTopology();

  const script = [
    "user: @BA 请先完成实现，再经过 CodeReview，多轮修复结束后再进入其他判定。",
    "BA: 需求已澄清，交给 Build 继续实现。 @Build",
    "Build: Build 首轮实现完成， @CodeReview @UnitTest @TaskReview",
    "CodeReview: CodeReview 首轮未通过。 @Build",
    "UnitTest: UnitTest 已收到首轮 Build 结果。",
    "TaskReview: TaskReview 已收到首轮 Build 结果。",
    "Build: Build 已根据 CodeReview 意见修复完成。 @CodeReview",
    `CodeReview: ${renderTriggerBlock("<complete>", "已确认通过，可以进入后续判定。")}`,
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
      assert.match(
        String(error),
        /下一条回应 Agent 不匹配|当前步骤模拟值为 \[Build\]|脚本包含 \[\]/u,
      );
      assert.doesNotMatch(String(error), /CodeReview: 已确认通过/u);
      return true;
    },
  );
});

test("scheduler script emulator 支持 decisionAgent 之后直接按 trigger 派发的目标继续", async () => {
  const topology = createRepresentativeTopology();

  const script = [
    "user: @BA 请先完成实现，再经过 CodeReview，多轮修复结束后再进入其他判定。",
    "BA: 需求已澄清，交给 Build 继续实现。 @Build",
    "Build: Build 首轮实现完成， @CodeReview @UnitTest @TaskReview",
    "CodeReview: CodeReview 首轮未通过。 @Build",
    "UnitTest: UnitTest 已收到首轮 Build 结果。",
    "TaskReview: TaskReview 已收到首轮 Build 结果。",
    "Build: Build 已根据 CodeReview 意见修复完成。 @CodeReview",
    `CodeReview: ${renderTriggerBlock("<complete>", "已确认通过，可以进入后续判定。")}`,
    "UnitTest: UnitTest 已收到最终 Build 结果。",
    "TaskReview: TaskReview 已收到最终 Build 结果。",
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("scheduler script emulator 会拒绝漏掉最终 UnitTest 回复", async () => {
  const topology = createRepresentativeTopology();

  const script = [
    "user: @BA 请先完成实现，再经过 CodeReview，多轮修复结束后再进入其他判定。",
    "BA: 需求已澄清，交给 Build 继续实现。 @Build",
    "Build: Build 首轮实现完成， @CodeReview @UnitTest @TaskReview",
    "CodeReview: CodeReview 首轮未通过。 @Build",
    "UnitTest: UnitTest 已收到首轮 Build 结果。",
    "TaskReview: TaskReview 已收到首轮 Build 结果。",
    "Build: Build 已根据 CodeReview 意见修复完成。 @CodeReview",
    `CodeReview: ${renderTriggerBlock("<complete>", "已确认通过，可以进入后续判定。")}`,
    "Build: @UnitTest @TaskReview",
    "TaskReview: TaskReview 已收到最终 Build 结果。",
  ];

  await assert.rejects(
    runSchedulerScriptDrived({ topology, script }),
    /UnitTest|下一条回应 Agent 不匹配|无法继续推进/u,
  );
});

test("scheduler script emulator 会拒绝漏掉最终 TaskReview 回复", async () => {
  const topology = createRepresentativeTopology();

  const script = [
    "user: @BA 请先完成实现，再经过 CodeReview，多轮修复结束后再进入其他判定。",
    "BA: 需求已澄清，交给 Build 继续实现。 @Build",
    "Build: Build 首轮实现完成， @CodeReview @UnitTest @TaskReview",
    "CodeReview: CodeReview 首轮未通过。 @Build",
    "UnitTest: UnitTest 已收到首轮 Build 结果。",
    "TaskReview: TaskReview 已收到首轮 Build 结果。",
    "Build: Build 已根据 CodeReview 意见修复完成。 @CodeReview",
    `CodeReview: ${renderTriggerBlock("<complete>", "已确认通过，可以进入后续判定。")}`,
    "Build: @UnitTest @TaskReview",
    "UnitTest: UnitTest 已收到最终 Build 结果。",
  ];

  await assert.rejects(
    runSchedulerScriptDrived({ topology, script }),
    /TaskReview|下一条回应 Agent 不匹配|无法继续推进/u,
  );
});

test("scheduler script emulator 会拒绝漏掉最后一批全部消费者", async () => {
  const topology: TopologyRecord = withAgentNodeRecords({
    nodes: ["Implementer", "UnitTest", "TaskReview", "CodeReview"],
    edges: [
      {
        source: "Implementer",
        target: "UnitTest",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "Implementer",
        target: "TaskReview",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "Implementer",
        target: "CodeReview",
        trigger: "<default>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "UnitTest",
        target: "Implementer",
        trigger: "<continue>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "UnitTest",
        target: "__end__",
        trigger: "<complete>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "TaskReview",
        target: "__end__",
        trigger: "<complete>",
        messageMode: "last", maxTriggerRounds: 4,
      },
      {
        source: "CodeReview",
        target: "__end__",
        trigger: "<complete>",
        messageMode: "last", maxTriggerRounds: 4,
      },
    ],
  });

  const script = [
    "user: @Implementer 请完成这个需求",
    "Implementer: 第 1 轮实现完成 @UnitTest @TaskReview @CodeReview",
    "UnitTest: 第 1 轮单测未通过 @Implementer",
    `TaskReview: ${renderTriggerBlock("<complete>", "认可")}`,
    `CodeReview: ${renderTriggerBlock("<complete>", "认可")}`,
    "Implementer: 已修复第 1 轮问题 @UnitTest",
    "UnitTest: 第 2 轮单测未通过 @Implementer",
    "Implementer: 已修复第 2 轮问题 @UnitTest",
    `UnitTest: ${renderTriggerBlock("<complete>", "认可")}`,
    "Implementer: @TaskReview @CodeReview",
  ];

  await assert.rejects(
    runSchedulerScriptDrived({ topology, script }),
    /脚本提前结束|当前还缺少|TaskReview|CodeReview|execute_batch/u,
  );
});
