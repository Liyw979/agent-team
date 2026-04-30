import test from "node:test";
import assert from "node:assert/strict";

import type { MessageRecord, TopologyRecord } from "@shared/types";
import { formatActionRequiredRequestContent } from "@shared/chat-message-format";
import {
  buildChatExecutionWindows,
  buildChatFeedItems,
} from "./chat-execution-feed";
import { mergeTaskChatMessages } from "./chat-messages";

function createMessage(
  overrides: Partial<MessageRecord> & {
    kind: MessageRecord["kind"];
    routingKind?: "default" | "labeled" | "invalid";
  },
): MessageRecord {
  const id = overrides.id ?? "message-id";
  const taskId = overrides.taskId ?? "task-id";
  const content = overrides.content ?? "";
  const sender = overrides.sender ?? "Build";
  const timestamp = overrides.timestamp ?? "2026-04-25T08:00:00.000Z";

  switch (overrides.kind) {
    case "agent-progress":
      return {
        id,
        taskId,
        content,
        sender,
        timestamp,
        kind: "agent-progress",
        activityKind: overrides.activityKind ?? "message",
        label: overrides.label ?? content,
        detail: overrides.detail ?? content,
        detailState: "not_applicable",
        sessionId: overrides.sessionId ?? "session-id",
        runCount: overrides.runCount ?? 1,
      };
    case "agent-final": {
      const routingKind = overrides.routingKind ?? "default";
      const base = {
        id,
        taskId,
        content,
        sender,
        timestamp,
        kind: "agent-final" as const,
        runCount: overrides.runCount ?? 1,
        status: overrides.status ?? "completed",
        responseNote: overrides.responseNote ?? "",
        rawResponse: overrides.rawResponse ?? content,
      };
      return routingKind === "labeled"
        ? {
            ...base,
            routingKind: "labeled" as const,
            trigger: overrides.trigger ?? "<trigger>",
          }
        : {
            ...base,
            routingKind,
          };
    }
    case "agent-dispatch":
      return {
        id,
        taskId,
        content,
        sender,
        timestamp,
        kind: "agent-dispatch",
        targetAgentIds: overrides.targetAgentIds ?? [],
        targetRunCounts:
          overrides.targetRunCounts ??
          (overrides.targetAgentIds ?? []).map((_value, index) => index + 1),
        dispatchDisplayContent: overrides.dispatchDisplayContent ?? content,
      };
    case "action-required-request":
      return {
        id,
        taskId,
        content,
        sender,
        timestamp,
        kind: "action-required-request",
        followUpMessageId:
          overrides.followUpMessageId ?? "follow-up-message-id",
        targetAgentIds: overrides.targetAgentIds ?? [],
        targetRunCounts:
          overrides.targetRunCounts ??
          (overrides.targetAgentIds ?? []).map((_value, index) => index + 1),
      };
    case "user":
      return {
        id,
        taskId,
        content,
        sender: "user",
        timestamp,
        kind: "user",
        scope: "task",
        taskTitle: "demo",
        targetAgentIds: overrides.targetAgentIds ?? [],
        targetRunCounts:
          overrides.targetRunCounts ??
          (overrides.targetAgentIds ?? []).map((_value, index) => index + 1),
      };
    case "task-created":
      return {
        id,
        taskId,
        content,
        sender: "system",
        timestamp,
        kind: "task-created",
      };
    case "system-message":
      return {
        id,
        taskId,
        content,
        sender: "system",
        timestamp,
        kind: "system-message",
      };
    case "task-completed":
      return {
        id,
        taskId,
        content,
        sender: "system",
        timestamp,
        kind: "task-completed",
        status: "failed",
      };
    case "task-round-finished":
      return {
        id,
        taskId,
        content,
        sender: "system",
        timestamp,
        kind: "task-round-finished",
        finishReason: overrides.finishReason ?? "round_finished",
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
      messageMode: "last",
    },
    {
      source: "Build",
      target: "TaskReview",
      trigger: "<default>",
      messageMode: "last",
    },
    {
      source: "TaskReview",
      target: "Build",
      trigger: "<continue>",
      messageMode: "last",
    },
  ],
};

const vulnerabilityTopology: TopologyRecord = {
  nodes: ["线索发现", "漏洞挑战-1", "漏洞论证-1", "讨论总结-1"],
  edges: [
    {
      source: "线索发现",
      target: "漏洞挑战-1",
      trigger: "<default>",
      messageMode: "last-all",
    },
    {
      source: "漏洞挑战-1",
      target: "漏洞论证-1",
      trigger: "<continue>",
      messageMode: "last",
    },
    {
      source: "漏洞论证-1",
      target: "讨论总结-1",
      trigger: "<complete>",
      messageMode: "last-all",
    },
  ],
};

test("buildChatExecutionWindows 会把用户 @ 的目标变成执行窗口", () => {
  const messages = [
    createMessage({
      id: "user-build",
      sender: "user",
      kind: "user",
      content: "@Build 请实现加法",
      targetAgentIds: ["Build"],
      timestamp: "2026-04-25T08:00:00.000Z",
    }),
  ];

  const mergedMessages = mergeTaskChatMessages(messages);
  const executionWindows = buildChatExecutionWindows(messages, mergedMessages);

  assert.equal(executionWindows.length, 1);
  assert.equal(executionWindows[0]?.agentId, "Build");
  assert.equal(executionWindows[0]?.runCount, 1);
  assert.equal(executionWindows[0]?.anchorMessageId, mergedMessages[0]?.id);
});

test("buildChatExecutionWindows 会把 action-required-request 指向的目标变成执行窗口", () => {
  const messages = [
    createMessage({
      id: "review-final",
      sender: "TaskReview",
      kind: "agent-final",
      content: "请补充测试说明。",
      routingKind: "labeled",
      trigger: "<continue>",
      timestamp: "2026-04-25T08:00:10.000Z",
    }),
    createMessage({
      id: "review-request",
      sender: "TaskReview",
      kind: "action-required-request",
      content: formatActionRequiredRequestContent("请补充测试说明。", [
        "Build",
      ]),
      followUpMessageId: "review-final",
      targetAgentIds: ["Build"],
      timestamp: "2026-04-25T08:00:11.000Z",
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
      timestamp: "2026-04-25T08:01:00.000Z",
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
      content: "@漏洞挑战-1",
      targetAgentIds: ["漏洞挑战-1"],
      timestamp: "2026-04-30T10:00:00.000Z",
    }),
    createMessage({
      id: "challenge-progress",
      sender: "漏洞挑战-1",
      kind: "agent-progress",
      content: "正在审查当前 finding 的防护条件",
      activityKind: "thinking",
      label: "思考",
      detail: "正在审查当前 finding 的防护条件",
      sessionId: "session-challenge-1",
      runCount: 1,
      timestamp: "2026-04-30T10:00:01.000Z",
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
      content: "@漏洞挑战-1",
      targetAgentIds: ["漏洞挑战-1"],
      timestamp: "2026-04-30T10:00:00.000Z",
    }),
    createMessage({
      id: "challenge-progress",
      sender: "漏洞挑战-1",
      kind: "agent-progress",
      content: "正在检查证据链",
      activityKind: "thinking",
      label: "思考",
      detail: "正在检查证据链",
      sessionId: "session-challenge-1",
      runCount: 1,
      timestamp: "2026-04-30T10:00:01.000Z",
    }),
    createMessage({
      id: "challenge-final",
      sender: "漏洞挑战-1",
      kind: "agent-final",
      content: "当前证据不足以证明这里一定能越界写入。",
      routingKind: "labeled",
      trigger: "<continue>",
      responseNote: "当前证据不足以证明这里一定能越界写入。",
      rawResponse: "<continue> 当前证据不足以证明这里一定能越界写入。",
      timestamp: "2026-04-30T10:00:02.000Z",
    }),
    createMessage({
      id: "challenge-request",
      sender: "漏洞挑战-1",
      kind: "action-required-request",
      content: formatActionRequiredRequestContent(
        "当前证据不足以证明这里一定能越界写入。",
        ["漏洞论证-1"],
      ),
      followUpMessageId: "challenge-final",
      targetAgentIds: ["漏洞论证-1"],
      timestamp: "2026-04-30T10:00:03.000Z",
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
      timestamp: "2026-04-30T10:00:04.000Z",
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
    { type: "message", sender: "线索发现", content: "@漏洞挑战-1" },
    {
      type: "execution",
      status: "settled",
      agentId: "漏洞挑战-1",
    },
    { type: "execution", status: "running", agentId: "漏洞论证-1" },
  ]);

  const settledExecution = feedItems.find(
    (item) =>
      item.type === "execution" &&
      item.status === "settled" &&
      item.agentId === "漏洞挑战-1",
  );
  if (
    !settledExecution ||
    settledExecution.type !== "execution" ||
    settledExecution.status !== "settled"
  ) {
    assert.fail("缺少漏洞挑战-1 的已完成执行项");
  }
  assert.equal(
    settledExecution.message.content,
    "当前证据不足以证明这里一定能越界写入。\n\n@漏洞论证-1",
  );
});

test("buildChatFeedItems 会保证 漏洞挑战 final 先于 漏洞论证 progress 出现", () => {
  const messages = [
    createMessage({
      id: "dispatch-challenge",
      sender: "线索发现",
      kind: "agent-dispatch",
      content: "@漏洞挑战-1",
      targetAgentIds: ["漏洞挑战-1"],
      timestamp: "2026-04-30T10:00:00.000Z",
    }),
    createMessage({
      id: "challenge-final",
      sender: "漏洞挑战-1",
      kind: "agent-final",
      content: "漏洞挑战最终结论",
      routingKind: "labeled",
      trigger: "<continue>",
      responseNote: "漏洞挑战最终结论",
      rawResponse: "<continue> 漏洞挑战最终结论",
      timestamp: "2026-04-30T10:00:02.000Z",
    }),
    createMessage({
      id: "challenge-request",
      sender: "漏洞挑战-1",
      kind: "action-required-request",
      content: formatActionRequiredRequestContent("漏洞挑战最终结论", [
        "漏洞论证-1",
      ]),
      followUpMessageId: "challenge-final",
      targetAgentIds: ["漏洞论证-1"],
      timestamp: "2026-04-30T10:00:03.000Z",
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
      timestamp: "2026-04-30T10:00:04.000Z",
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

  const challengeIndex = text.indexOf("漏洞挑战最终结论");
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
      content: "@漏洞挑战-1",
      targetAgentIds: ["漏洞挑战-1"],
      timestamp: "2026-04-30T10:00:00.000Z",
    }),
    createMessage({
      id: "challenge-progress",
      sender: "漏洞挑战-1",
      kind: "agent-progress",
      content: "漏洞挑战过程消息",
      activityKind: "thinking",
      label: "思考",
      detail: "漏洞挑战过程消息",
      sessionId: "session-challenge-1",
      runCount: 1,
      timestamp: "2026-04-30T10:00:01.000Z",
    }),
    createMessage({
      id: "challenge-final",
      sender: "漏洞挑战-1",
      kind: "agent-final",
      content: "漏洞挑战最终结论",
      routingKind: "labeled",
      trigger: "<continue>",
      responseNote: "漏洞挑战最终结论",
      rawResponse: "<continue> 漏洞挑战最终结论",
      timestamp: "2026-04-30T10:00:02.000Z",
    }),
    createMessage({
      id: "challenge-request",
      sender: "漏洞挑战-1",
      kind: "action-required-request",
      content: formatActionRequiredRequestContent("漏洞挑战最终结论", [
        "漏洞论证-1",
      ]),
      followUpMessageId: "challenge-final",
      targetAgentIds: ["漏洞论证-1"],
      timestamp: "2026-04-30T10:00:03.000Z",
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
      timestamp: "2026-04-30T10:00:04.000Z",
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
    assert.fail("漏洞挑战应由 final 接管原执行窗口");
  }
  assert.equal(settledItems[0].agentId, "漏洞挑战-1");
});

test("buildChatFeedItems 不会误删同一 anchor 下不同目标的并行动态面板", () => {
  const messages = [
    createMessage({
      id: "build-dispatch",
      sender: "Build",
      kind: "agent-dispatch",
      content: "@UnitTest @TaskReview",
      targetAgentIds: ["UnitTest", "TaskReview"],
      timestamp: "2026-04-25T08:01:00.000Z",
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
      timestamp: "2026-04-25T08:01:01.000Z",
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
      timestamp: "2026-04-25T08:01:02.000Z",
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
      kind: "action-required-request",
      content: formatActionRequiredRequestContent("请补充测试", ["Build"]),
      followUpMessageId: "review-final-1",
      targetAgentIds: ["Build"],
      targetRunCounts: [1],
      timestamp: "2026-04-30T10:00:00.000Z",
    }),
    createMessage({
      id: "dispatch-build-2",
      sender: "QA",
      kind: "action-required-request",
      content: formatActionRequiredRequestContent("请补充日志", ["Build"]),
      followUpMessageId: "qa-final-1",
      targetAgentIds: ["Build"],
      targetRunCounts: [2],
      timestamp: "2026-04-30T10:00:01.000Z",
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
      timestamp: "2026-04-30T10:00:02.000Z",
    }),
    createMessage({
      id: "build-final-2",
      sender: "Build",
      kind: "agent-final",
      content: "Build 第二次执行完成",
      routingKind: "default",
      runCount: 2,
      timestamp: "2026-04-30T10:00:03.000Z",
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
