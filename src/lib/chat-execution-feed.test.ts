import { test } from "bun:test";
import assert from "node:assert/strict";

import {
  buildTopologyNodeRecords,
  createTopologyFlowRecord,
  type AgentFinalMessageRecord,
  type MessageRecord,
  type TopologyTrigger,
  type TopologyRecord,
  toUtcIsoTimestamp,
} from "@shared/types";
import { formatAgentDispatchContent } from "@shared/chat-message-format";
import {
  buildChatExecutionWindows,
  buildChatFeedItems,
} from "./chat-execution-feed";
import { mergeTaskChatMessages } from "./chat-messages";

type TestMessageBase = {
  id: string;
  sender: string;
  content: string;
  timestamp: ReturnType<typeof toUtcIsoTimestamp>;
};

type TestMessageInput =
  | (TestMessageBase & {
      kind: "agent-progress";
      activityKind: Extract<MessageRecord, { kind: "agent-progress" }>["activityKind"];
      label: string;
      detail: string;
      sessionId: string;
      runCount: number;
    })
  | (TestMessageBase & {
      kind: "agent-final";
      response:
        | { kind: "content" }
        | { kind: "raw"; rawResponse: string };
    } & (
      | { routingKind: "default" | "invalid" }
      | { routingKind: "triggered"; trigger: TopologyTrigger }
    ))
  | (TestMessageBase & {
      kind: "agent-final-with-run";
      runCount: number;
      response:
        | { kind: "content" }
        | { kind: "raw"; rawResponse: string };
    } & (
      | { routingKind: "default" | "invalid" }
      | { routingKind: "triggered"; trigger: TopologyTrigger }
    ))
  | (TestMessageBase & {
      kind: "agent-dispatch";
      targetAgentIds: string[];
    })
  | (TestMessageBase & {
      kind: "agent-dispatch-with-runs";
      targetAgentIds: string[];
      targetRunCounts: number[];
    })
  | (TestMessageBase & {
      kind: "user";
      targetAgentIds: string[];
    })
  | (TestMessageBase & {
      kind: "task-created" | "system-message";
    })
  | (TestMessageBase & {
      kind: "task-completed";
      status: Extract<MessageRecord, { kind: "task-completed" }>["status"];
    })
  | (TestMessageBase & {
      kind: "task-round-finished";
      finishReason: string;
    });

function createMessage(input: TestMessageInput): MessageRecord {
  switch (input.kind) {
    case "agent-progress":
      return {
        id: input.id,
        content: input.content,
        sender: input.sender,
        timestamp: input.timestamp,
        kind: "agent-progress",
        activityKind: input.activityKind,
        label: input.label,
        detail: input.detail,
        detailState: "not_applicable",
        sessionId: input.sessionId,
        runCount: input.runCount,
      };
    case "agent-final": {
      const base: Omit<AgentFinalMessageRecord, "routingKind" | "trigger"> = {
        id: input.id,
        content: input.content,
        sender: input.sender,
        timestamp: input.timestamp,
        kind: "agent-final" as const,
        runCount: 1,
        status: "completed" as const,
        rawResponse: input.response.kind === "raw" ? input.response.rawResponse : input.content,
        senderDisplayName: input.sender,
      };
      return input.routingKind === "triggered"
        ? {
            ...base,
            routingKind: "triggered" as const,
            trigger: input.trigger,
          } satisfies AgentFinalMessageRecord
        : input.routingKind === "invalid"
          ? {
              ...base,
              routingKind: "invalid",
            } satisfies AgentFinalMessageRecord
        : {
            ...base,
            routingKind: "default",
          } satisfies AgentFinalMessageRecord;
    }
    case "agent-final-with-run": {
      const base: Omit<AgentFinalMessageRecord, "routingKind" | "trigger"> = {
        id: input.id,
        content: input.content,
        sender: input.sender,
        timestamp: input.timestamp,
        kind: "agent-final" as const,
        runCount: input.runCount,
        status: "completed" as const,
        rawResponse: input.response.kind === "raw" ? input.response.rawResponse : input.content,
        senderDisplayName: input.sender,
      };
      return input.routingKind === "triggered"
        ? {
            ...base,
            routingKind: "triggered" as const,
            trigger: input.trigger,
          } satisfies AgentFinalMessageRecord
        : input.routingKind === "invalid"
          ? {
              ...base,
              routingKind: "invalid",
            } satisfies AgentFinalMessageRecord
        : {
            ...base,
            routingKind: "default",
          } satisfies AgentFinalMessageRecord;
    }
    case "agent-dispatch":
      return {
        id: input.id,
        content: input.content,
        sender: input.sender,
        timestamp: input.timestamp,
        kind: "agent-dispatch",
        targetAgentIds: input.targetAgentIds,
        targetRunCounts: input.targetAgentIds.map((_value, index) => index + 1),
        dispatchDisplayContent: input.content,
        senderDisplayName: input.sender,
      };
    case "agent-dispatch-with-runs":
      return {
        id: input.id,
        content: input.content,
        sender: input.sender,
        timestamp: input.timestamp,
        kind: "agent-dispatch",
        targetAgentIds: input.targetAgentIds,
        targetRunCounts: input.targetRunCounts,
        dispatchDisplayContent: input.content,
        senderDisplayName: input.sender,
      };
    case "user":
      return {
        id: input.id,
        content: input.content,
        sender: "user",
        timestamp: input.timestamp,
        kind: "user",
        scope: "task",
        taskTitle: "demo",
        targetAgentIds: input.targetAgentIds,
        targetRunCounts: input.targetAgentIds.map((_value, index) => index + 1),
      };
    case "task-created":
      return {
        id: input.id,
        content: input.content,
        sender: "system",
        timestamp: input.timestamp,
        kind: "task-created",
      };
    case "system-message":
      return {
        id: input.id,
        content: input.content,
        sender: "system",
        timestamp: input.timestamp,
        kind: "system-message",
      };
    case "task-completed":
      return {
        id: input.id,
        content: input.content,
        sender: "system",
        timestamp: input.timestamp,
        kind: "task-completed",
        status: input.status,
      };
    case "task-round-finished":
      return {
        id: input.id,
        content: input.content,
        sender: "system",
        timestamp: input.timestamp,
        kind: "task-round-finished",
        finishReason: input.finishReason,
      };
  }
}

const topology: TopologyRecord = {
  nodes: ["Build", "UnitTest", "TaskReview"],
  edges: [
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
      source: "TaskReview",
      target: "Build",
      trigger: "<continue>",
      messageMode: "last", maxTriggerRounds: 4,
    },
  ],
  flow: createTopologyFlowRecord({
    nodes: ["Build", "UnitTest", "TaskReview"],
    edges: [
      {
        source: "Build",
        target: "UnitTest",
        trigger: "<default>",
        messageMode: "last",
        maxTriggerRounds: 4,
      },
      {
        source: "Build",
        target: "TaskReview",
        trigger: "<default>",
        messageMode: "last",
        maxTriggerRounds: 4,
      },
      {
        source: "TaskReview",
        target: "Build",
        trigger: "<continue>",
        messageMode: "last",
        maxTriggerRounds: 4,
      },
    ],
  }),
  nodeRecords: buildTopologyNodeRecords({
    nodes: ["Build", "UnitTest", "TaskReview"],
    groupNodeIds: new Set(),
    templateNameByNodeId: new Map(),
    initialMessageRoutingByNodeId: new Map(),
    groupRuleIdByNodeId: new Map(),
    promptByNodeId: new Map(),
    writableNodeIds: new Set(),
  }),
};

const vulnerabilityTopology: TopologyRecord = {
  nodes: ["线索发现", "误报论证-1", "漏洞论证-1", "讨论总结-1"],
  edges: [
    {
      source: "线索发现",
      target: "误报论证-1",
      trigger: "<default>",
      messageMode: "last", maxTriggerRounds: 4,
    },
    {
      source: "误报论证-1",
      target: "漏洞论证-1",
      trigger: "<continue>",
      messageMode: "last", maxTriggerRounds: 4,
    },
    {
      source: "漏洞论证-1",
      target: "讨论总结-1",
      trigger: "<complete>",
      messageMode: "last", maxTriggerRounds: 4,
    },
  ],
  flow: createTopologyFlowRecord({
    nodes: ["线索发现", "误报论证-1", "漏洞论证-1", "讨论总结-1"],
    edges: [
      {
        source: "线索发现",
        target: "误报论证-1",
        trigger: "<default>",
        messageMode: "last",
        maxTriggerRounds: 4,
      },
      {
        source: "误报论证-1",
        target: "漏洞论证-1",
        trigger: "<continue>",
        messageMode: "last",
        maxTriggerRounds: 4,
      },
      {
        source: "漏洞论证-1",
        target: "讨论总结-1",
        trigger: "<complete>",
        messageMode: "last",
        maxTriggerRounds: 4,
      },
    ],
  }),
  nodeRecords: buildTopologyNodeRecords({
    nodes: ["线索发现", "误报论证-1", "漏洞论证-1", "讨论总结-1"],
    groupNodeIds: new Set(),
    templateNameByNodeId: new Map(),
    initialMessageRoutingByNodeId: new Map(),
    groupRuleIdByNodeId: new Map(),
    promptByNodeId: new Map(),
    writableNodeIds: new Set(),
  }),
};

test("buildChatExecutionWindows 会把用户 @ 的目标变成执行窗口", () => {
  const messages = [
    createMessage({
      id: "user-build",
      sender: "user",
      kind: "user",
      content: "@Build 请实现加法",
      targetAgentIds: ["Build"],
      timestamp: toUtcIsoTimestamp("2026-04-25T08:00:00.000Z"),
    }),
  ];

  const mergedMessages = mergeTaskChatMessages(messages);
  const executionWindows = buildChatExecutionWindows(messages, mergedMessages);

  assert.equal(executionWindows.length, 1);
  assert.equal(executionWindows[0]?.agentId, "Build");
  assert.equal(executionWindows[0]?.runCount, 1);
  assert.equal(executionWindows[0]?.anchorMessageId, mergedMessages[0]?.id);
});

test("buildChatExecutionWindows 会把 trigger 派发指向的目标变成执行窗口", () => {
  const messages = [
    createMessage({
      id: "review-final",
      sender: "TaskReview",
      kind: "agent-final",
      content: "请补充测试说明。",
      response: { kind: "content" },
      routingKind: "triggered",
      trigger: "<continue>",
      timestamp: toUtcIsoTimestamp("2026-04-25T08:00:10.000Z"),
    }),
    createMessage({
      id: "review-request",
      sender: "TaskReview",
      kind: "agent-dispatch",
      content: formatAgentDispatchContent("请补充测试说明。", [
        "Build",
      ]),
            targetAgentIds: ["Build"],
      timestamp: toUtcIsoTimestamp("2026-04-25T08:00:11.000Z"),
    }),
  ];

  const mergedMessages = mergeTaskChatMessages(messages);
  const executionWindows = buildChatExecutionWindows(messages, mergedMessages);

  assert.equal(executionWindows.length, 1);
  assert.equal(executionWindows[0]?.agentId, "Build");
  assert.equal(executionWindows[0]?.runCount, 1);
});

test("buildChatFeedItems 会为单条多目标派发生成多条执行气泡", () => {
  const messages = [
    createMessage({
      id: "build-dispatch",
      sender: "Build",
      kind: "agent-dispatch",
      content: "@UnitTest @TaskReview",
      targetAgentIds: ["UnitTest", "TaskReview"],
      timestamp: toUtcIsoTimestamp("2026-04-25T08:01:00.000Z"),
    }),
  ];

  const feedItems = buildChatFeedItems({
    messages,
    topology,
  });

  assert.deepEqual(
    feedItems.map((item) =>
      item.type === "message"
        ? { type: item.type, sender: item.message.sender }
        : { type: item.type, status: item.status, agentId: item.agentId },
    ),
    [
      { type: "message", sender: "Build" },
      { type: "execution", status: "running", agentId: "UnitTest" },
      { type: "execution", status: "running", agentId: "TaskReview" },
    ],
  );
});

test("buildChatFeedItems 会把 agent-progress 填进运行中执行气泡", () => {
  const messages = [
    createMessage({
      id: "dispatch-challenge",
      sender: "线索发现",
      kind: "agent-dispatch",
      content: "@误报论证-1",
      targetAgentIds: ["误报论证-1"],
      timestamp: toUtcIsoTimestamp("2026-04-30T10:00:00.000Z"),
    }),
    createMessage({
      id: "challenge-progress",
      sender: "误报论证-1",
      kind: "agent-progress",
      content: "正在审查当前 finding 的防护条件",
      activityKind: "thinking",
      label: "思考",
      detail: "正在审查当前 finding 的防护条件",
      sessionId: "session-challenge-1",
      runCount: 1,
      timestamp: toUtcIsoTimestamp("2026-04-30T10:00:01.000Z"),
    }),
  ];

  const feedItems = buildChatFeedItems({
    messages,
    topology: vulnerabilityTopology,
  });

  const runningExecution = feedItems.at(-1);
  assert.equal(runningExecution?.type, "execution");
  if (
    !runningExecution ||
    runningExecution.type !== "execution" ||
    runningExecution.status === "settled"
  ) {
    assert.fail("缺少运行中执行气泡");
  }
  assert.deepEqual(
    runningExecution.historyItems.map((item) => item.detail),
    ["正在审查当前 finding 的防护条件"],
  );
});

test("buildChatFeedItems 会在 final 出现后立即用普通消息替换动态执行气泡", () => {
  const messages = [
    createMessage({
      id: "dispatch-challenge",
      sender: "线索发现",
      kind: "agent-dispatch",
      content: "@误报论证-1",
      targetAgentIds: ["误报论证-1"],
      timestamp: toUtcIsoTimestamp("2026-04-30T10:00:00.000Z"),
    }),
    createMessage({
      id: "challenge-progress",
      sender: "误报论证-1",
      kind: "agent-progress",
      content: "正在检查证据链",
      activityKind: "thinking",
      label: "思考",
      detail: "正在检查证据链",
      sessionId: "session-challenge-1",
      runCount: 1,
      timestamp: toUtcIsoTimestamp("2026-04-30T10:00:01.000Z"),
    }),
    createMessage({
      id: "challenge-final",
      sender: "误报论证-1",
      kind: "agent-final",
      content: "当前证据不足以证明这里一定能越界写入。",
      routingKind: "triggered",
      trigger: "<continue>",
      response: {
        kind: "raw",
        rawResponse: "<continue> 当前证据不足以证明这里一定能越界写入。",
      },
      timestamp: toUtcIsoTimestamp("2026-04-30T10:00:02.000Z"),
    }),
    createMessage({
      id: "challenge-request",
      sender: "误报论证-1",
      kind: "agent-dispatch",
      content: formatAgentDispatchContent(
        "当前证据不足以证明这里一定能越界写入。",
        ["漏洞论证-1"],
      ),
            targetAgentIds: ["漏洞论证-1"],
      timestamp: toUtcIsoTimestamp("2026-04-30T10:00:03.000Z"),
    }),
    createMessage({
      id: "argument-progress",
      sender: "漏洞论证-1",
      kind: "agent-progress",
      content: "正在补充漏洞成立所需的代码证据",
      activityKind: "thinking",
      label: "思考",
      detail: "正在补充漏洞成立所需的代码证据",
      sessionId: "session-argument-1",
      runCount: 1,
      timestamp: toUtcIsoTimestamp("2026-04-30T10:00:04.000Z"),
    }),
  ];

  const feedItems = buildChatFeedItems({
    messages,
    topology: vulnerabilityTopology,
  });

  const normalized = feedItems.map((item) =>
    item.type === "message"
      ? {
          type: "message" as const,
          sender: item.message.sender,
          content: item.message.content,
        }
      : {
          type: "execution" as const,
          status: item.status,
          agentId: item.agentId,
        },
  );

  assert.deepEqual(normalized, [
    { type: "message", sender: "线索发现", content: "@误报论证-1" },
    {
      type: "execution",
      status: "settled",
      agentId: "误报论证-1",
    },
    { type: "execution", status: "running", agentId: "漏洞论证-1" },
  ]);

  const settledExecution = feedItems.find(
    (item) =>
      item.type === "execution" &&
      item.status === "settled" &&
      item.agentId === "误报论证-1",
  );
  if (
    !settledExecution ||
    settledExecution.type !== "execution" ||
    settledExecution.status !== "settled"
  ) {
    assert.fail("缺少误报论证-1 的已完成执行项");
  }
  assert.equal(
    settledExecution.message.content,
    "当前证据不足以证明这里一定能越界写入。\n\n@漏洞论证-1",
  );
});

test("buildChatFeedItems 会剥离重复 trigger，但保留 final 正文与回流目标", () => {
  const messages = [
    createMessage({
      id: "dispatch-challenge",
      sender: "线索发现",
      kind: "agent-dispatch",
      content: "@误报论证-1",
      targetAgentIds: ["误报论证-1"],
      timestamp: toUtcIsoTimestamp("2026-04-30T10:00:00.000Z"),
    }),
    createMessage({
      id: "challenge-final-repeated-trigger",
      sender: "误报论证-1",
      kind: "agent-final",
      content: "当前证据不足以证明这里一定能越界写入。",
      routingKind: "triggered",
      trigger: "<continue>",
      response: {
        kind: "raw",
        rawResponse: "<continue>\n当前证据不足以证明这里一定能越界写入。\n\n<continue>",
      },
      timestamp: toUtcIsoTimestamp("2026-04-30T10:00:02.000Z"),
    }),
    createMessage({
      id: "challenge-request-repeated-trigger",
      sender: "误报论证-1",
      kind: "agent-dispatch",
      content: formatAgentDispatchContent(
        "当前证据不足以证明这里一定能越界写入。",
        ["漏洞论证-1"],
      ),
            targetAgentIds: ["漏洞论证-1"],
      timestamp: toUtcIsoTimestamp("2026-04-30T10:00:03.000Z"),
    }),
  ];

  const feedItems = buildChatFeedItems({
    messages,
    topology: vulnerabilityTopology,
  });
  const settledExecution = feedItems.find(
    (item) =>
      item.type === "execution" &&
      item.status === "settled" &&
      item.agentId === "误报论证-1",
  );

  if (
    !settledExecution ||
    settledExecution.type !== "execution" ||
    settledExecution.status !== "settled"
  ) {
    assert.fail("缺少误报论证-1 的已完成执行项");
  }

  assert.equal(
    settledExecution.message.content,
    "当前证据不足以证明这里一定能越界写入。\n\n@漏洞论证-1",
  );
});

test("buildChatFeedItems 会保证 误报论证 final 先于 漏洞论证 progress 出现", () => {
  const messages = [
    createMessage({
      id: "dispatch-challenge",
      sender: "线索发现",
      kind: "agent-dispatch",
      content: "@误报论证-1",
      targetAgentIds: ["误报论证-1"],
      timestamp: toUtcIsoTimestamp("2026-04-30T10:00:00.000Z"),
    }),
    createMessage({
      id: "challenge-final",
      sender: "误报论证-1",
      kind: "agent-final",
      content: "误报论证最终结论",
      routingKind: "triggered",
      trigger: "<continue>",
      response: {
        kind: "raw",
        rawResponse: "<continue> 误报论证最终结论",
      },
      timestamp: toUtcIsoTimestamp("2026-04-30T10:00:02.000Z"),
    }),
    createMessage({
      id: "challenge-request",
      sender: "误报论证-1",
      kind: "agent-dispatch",
      content: formatAgentDispatchContent("误报论证最终结论", [
        "漏洞论证-1",
      ]),
            targetAgentIds: ["漏洞论证-1"],
      timestamp: toUtcIsoTimestamp("2026-04-30T10:00:03.000Z"),
    }),
    createMessage({
      id: "argument-progress",
      sender: "漏洞论证-1",
      kind: "agent-progress",
      content: "漏洞论证过程消息",
      activityKind: "thinking",
      label: "思考",
      detail: "漏洞论证过程消息",
      sessionId: "session-argument-1",
      runCount: 1,
      timestamp: toUtcIsoTimestamp("2026-04-30T10:00:04.000Z"),
    }),
  ];

  const feedItems = buildChatFeedItems({
    messages,
    topology: vulnerabilityTopology,
  });
  const text = feedItems
    .map((item) => {
      if (item.type === "message") {
        return item.message.content;
      }
      if (item.status === "settled") {
        return item.message.content;
      }
      return item.historyItems.map((history) => history.detail).join("\n");
    })
    .join("\n---\n");

  const challengeIndex = text.indexOf("误报论证最终结论");
  const argumentIndex = text.indexOf("漏洞论证过程消息");
  assert.equal(challengeIndex >= 0, true);
  assert.equal(argumentIndex > challengeIndex, true);
});

test("buildChatFeedItems 会在 challenge final 后让后继 argument 进入唯一运行中的动态面板", () => {
  const messages = [
    createMessage({
      id: "dispatch-challenge",
      sender: "线索发现",
      kind: "agent-dispatch",
      content: "@误报论证-1",
      targetAgentIds: ["误报论证-1"],
      timestamp: toUtcIsoTimestamp("2026-04-30T10:00:00.000Z"),
    }),
    createMessage({
      id: "challenge-progress",
      sender: "误报论证-1",
      kind: "agent-progress",
      content: "误报论证过程消息",
      activityKind: "thinking",
      label: "思考",
      detail: "误报论证过程消息",
      sessionId: "session-challenge-1",
      runCount: 1,
      timestamp: toUtcIsoTimestamp("2026-04-30T10:00:01.000Z"),
    }),
    createMessage({
      id: "challenge-final",
      sender: "误报论证-1",
      kind: "agent-final",
      content: "误报论证最终结论",
      routingKind: "triggered",
      trigger: "<continue>",
      response: {
        kind: "raw",
        rawResponse: "<continue> 误报论证最终结论",
      },
      timestamp: toUtcIsoTimestamp("2026-04-30T10:00:02.000Z"),
    }),
    createMessage({
      id: "challenge-request",
      sender: "误报论证-1",
      kind: "agent-dispatch",
      content: formatAgentDispatchContent("误报论证最终结论", [
        "漏洞论证-1",
      ]),
            targetAgentIds: ["漏洞论证-1"],
      timestamp: toUtcIsoTimestamp("2026-04-30T10:00:03.000Z"),
    }),
    createMessage({
      id: "argument-progress",
      sender: "漏洞论证-1",
      kind: "agent-progress",
      content: "漏洞论证过程消息",
      activityKind: "thinking",
      label: "思考",
      detail: "漏洞论证过程消息",
      sessionId: "session-argument-1",
      runCount: 1,
      timestamp: toUtcIsoTimestamp("2026-04-30T10:00:04.000Z"),
    }),
  ];

  const feedItems = buildChatFeedItems({
    messages,
    topology: vulnerabilityTopology,
  });

  const runningItems = feedItems.filter(
    (item) => item.type === "execution" && item.status === "running",
  );
  assert.equal(runningItems.length, 1);
  if (
    runningItems[0]?.type !== "execution" ||
    runningItems[0].status !== "running"
  ) {
    assert.fail("应只剩一个运行中动态面板");
  }
  assert.equal(runningItems[0].agentId, "漏洞论证-1");
  const settledItems = feedItems.filter(
    (item) => item.type === "execution" && item.status === "settled",
  );
  assert.equal(settledItems.length, 1);
  if (
    settledItems[0]?.type !== "execution" ||
    settledItems[0].status !== "settled"
  ) {
    assert.fail("误报论证应由 final 接管原执行窗口");
  }
  assert.equal(settledItems[0].agentId, "误报论证-1");
});

test("buildChatFeedItems 不会误删同一 anchor 下不同目标的并行动态面板", () => {
  const messages = [
    createMessage({
      id: "build-dispatch",
      sender: "Build",
      kind: "agent-dispatch",
      content: "@UnitTest @TaskReview",
      targetAgentIds: ["UnitTest", "TaskReview"],
      timestamp: toUtcIsoTimestamp("2026-04-25T08:01:00.000Z"),
    }),
    createMessage({
      id: "unit-progress",
      sender: "UnitTest",
      kind: "agent-progress",
      content: "UnitTest 正在执行",
      activityKind: "thinking",
      label: "思考",
      detail: "UnitTest 正在执行",
      sessionId: "session-unit",
      runCount: 1,
      timestamp: toUtcIsoTimestamp("2026-04-25T08:01:01.000Z"),
    }),
    createMessage({
      id: "review-progress",
      sender: "TaskReview",
      kind: "agent-progress",
      content: "TaskReview 正在执行",
      activityKind: "thinking",
      label: "思考",
      detail: "TaskReview 正在执行",
      sessionId: "session-review",
      runCount: 1,
      timestamp: toUtcIsoTimestamp("2026-04-25T08:01:02.000Z"),
    }),
  ];

  const feedItems = buildChatFeedItems({
    messages,
    topology,
  });

  const runningItems = feedItems.filter(
    (item) => item.type === "execution" && item.status === "running",
  );
  assert.equal(runningItems.length, 2);
  const runningAgentIds = runningItems
    .map((item) => item.agentId)
    .sort((left, right) => left.localeCompare(right));
  assert.deepEqual(runningAgentIds, ["TaskReview", "UnitTest"]);
});

test("buildChatExecutionWindows 会用 runCount 精确把 final 绑定到同一 agent 的对应执行窗口", () => {
  const messages = [
    createMessage({
      id: "dispatch-build-1",
      sender: "TaskReview",
      kind: "agent-dispatch-with-runs",
      content: formatAgentDispatchContent("请补充测试", ["Build"]),
            targetAgentIds: ["Build"],
      targetRunCounts: [1],
      timestamp: toUtcIsoTimestamp("2026-04-30T10:00:00.000Z"),
    }),
    createMessage({
      id: "dispatch-build-2",
      sender: "QA",
      kind: "agent-dispatch-with-runs",
      content: formatAgentDispatchContent("请补充日志", ["Build"]),
            targetAgentIds: ["Build"],
      targetRunCounts: [2],
      timestamp: toUtcIsoTimestamp("2026-04-30T10:00:01.000Z"),
    }),
    createMessage({
      id: "build-progress-2",
      sender: "Build",
      kind: "agent-progress",
      content: "Build 第二次执行中",
      activityKind: "thinking",
      label: "思考",
      detail: "Build 第二次执行中",
      sessionId: "session-build-2",
      runCount: 2,
      timestamp: toUtcIsoTimestamp("2026-04-30T10:00:02.000Z"),
    }),
    createMessage({
      id: "build-final-2",
      sender: "Build",
      kind: "agent-final-with-run",
      content: "Build 第二次执行完成",
      routingKind: "default",
      response: { kind: "content" },
      runCount: 2,
      timestamp: toUtcIsoTimestamp("2026-04-30T10:00:03.000Z"),
    }),
  ];

  const mergedMessages = mergeTaskChatMessages(messages);
  const executionWindows = buildChatExecutionWindows(messages, mergedMessages);

  assert.equal(executionWindows.length, 2);
  assert.deepEqual(
    executionWindows.map((window) => ({
      agentId: window.agentId,
      runCount: window.runCount,
      status: window.status,
    })),
    [
      { agentId: "Build", runCount: 1, status: "running" },
      { agentId: "Build", runCount: 2, status: "settled" },
    ],
  );
});
