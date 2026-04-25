import test from "node:test";
import assert from "node:assert/strict";

import type {
  AgentRuntimeSnapshot,
  MessageRecord,
  TopologyRecord,
} from "@shared/types";
import { formatActionRequiredRequestContent } from "@shared/chat-message-format";
import { buildChatExecutionWindows, buildChatFeedItems } from "./chat-execution-feed";
import { mergeTaskChatMessages } from "./chat-messages";

function createMessage(overrides: Partial<MessageRecord> & { kind: MessageRecord["kind"] }): MessageRecord {
  const id = overrides.id ?? "message-id";
  const taskId = overrides.taskId ?? "task-id";
  const content = overrides.content ?? "";
  const sender = overrides.sender ?? "Build";
  const timestamp = overrides.timestamp ?? "2026-04-25T08:00:00.000Z";

  switch (overrides.kind) {
    case "agent-final":
      return {
        id,
        taskId,
        content,
        sender,
        timestamp,
        kind: "agent-final",
        status: overrides.status ?? "completed",
        decision: overrides.decision ?? "complete",
        decisionNote: overrides.decisionNote ?? "",
        rawResponse: overrides.rawResponse ?? content,
        ...(overrides.senderDisplayName ? { senderDisplayName: overrides.senderDisplayName } : {}),
      };
    case "agent-dispatch":
      return {
        id,
        taskId,
        content,
        sender,
        timestamp,
        kind: "agent-dispatch",
        targetAgentIds: overrides.targetAgentIds ?? [],
        dispatchDisplayContent: overrides.dispatchDisplayContent ?? content,
        ...(overrides.senderDisplayName ? { senderDisplayName: overrides.senderDisplayName } : {}),
      };
    case "continue-request":
      return {
        id,
        taskId,
        content,
        sender,
        timestamp,
        kind: "continue-request",
        followUpMessageId: overrides.followUpMessageId ?? "follow-up-message-id",
        targetAgentIds: overrides.targetAgentIds ?? [],
        ...(overrides.senderDisplayName ? { senderDisplayName: overrides.senderDisplayName } : {}),
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
  }
}

const topology: TopologyRecord = {
  nodes: ["Build", "UnitTest", "TaskReview"],
  edges: [
    { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
    { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
    { source: "TaskReview", target: "Build", triggerOn: "continue", messageMode: "last" },
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

  assert.deepEqual(
    executionWindows.map((window) => ({
      agentId: window.agentId,
      anchorMessageId: window.anchorMessageId,
      startedAt: window.startedAt,
    })),
    [
      {
        agentId: "Build",
        anchorMessageId: mergedMessages[0]?.id,
        startedAt: "2026-04-25T08:00:00.000Z",
      },
    ],
  );
});

test("buildChatExecutionWindows 会把 continue-request 指向的目标变成执行窗口", () => {
  const messages = [
    createMessage({
      id: "review-final",
      sender: "TaskReview",
      kind: "agent-final",
      content: "请补充测试说明。",
      decision: "continue",
      timestamp: "2026-04-25T08:00:10.000Z",
    }),
    createMessage({
      id: "review-request",
      sender: "TaskReview",
      kind: "continue-request",
      content: formatActionRequiredRequestContent("请补充测试说明。", ["Build"]),
      followUpMessageId: "review-final",
      targetAgentIds: ["Build"],
      timestamp: "2026-04-25T08:00:11.000Z",
    }),
  ];

  const mergedMessages = mergeTaskChatMessages(messages);
  const executionWindows = buildChatExecutionWindows(messages, mergedMessages);

  assert.equal(executionWindows.length, 1);
  assert.equal(executionWindows[0]?.agentId, "Build");
  assert.equal(executionWindows[0]?.anchorMessageId, mergedMessages[0]?.id);
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
    runtimeSnapshots: {},
  });

  assert.deepEqual(
    feedItems.map((item) =>
      item.type === "message"
        ? { type: item.type, sender: item.message.sender }
        : { type: item.type, state: item.state, agentId: item.agentId }),
    [
      { type: "message", sender: "Build" },
      { type: "execution", state: "running", agentId: "UnitTest" },
      { type: "execution", state: "running", agentId: "TaskReview" },
    ],
  );
});

test("buildChatFeedItems 会吸收已完成的 agent-final，不再额外保留第二条最终气泡", () => {
  const messages = [
    createMessage({
      id: "user-build",
      sender: "user",
      kind: "user",
      content: "@Build 请实现加法",
      targetAgentIds: ["Build"],
      timestamp: "2026-04-25T08:02:00.000Z",
    }),
    createMessage({
      id: "build-final",
      sender: "Build",
      kind: "agent-final",
      content: "已经完成实现。",
      timestamp: "2026-04-25T08:02:20.000Z",
    }),
  ];

  const feedItems = buildChatFeedItems({
    messages,
    topology,
    runtimeSnapshots: {},
  });

  assert.deepEqual(
    feedItems.map((item) =>
      item.type === "message"
        ? { type: item.type, sender: item.message.sender, content: item.message.content }
        : item.state === "completed"
          ? { type: item.type, state: item.state, agentId: item.agentId, content: item.message.content }
          : { type: item.type, state: item.state, agentId: item.agentId }),
    [
      { type: "message", sender: "user", content: "@Build 请实现加法" },
      { type: "execution", state: "completed", agentId: "Build", content: "已经完成实现。" },
    ],
  );
});

test("buildChatFeedItems 不会为没有可见 @ 派发的内部最终消息凭空生成执行气泡", () => {
  const messages = [
    createMessage({
      id: "build-final",
      sender: "Build",
      kind: "agent-final",
      content: "已经完成实现。",
      timestamp: "2026-04-25T08:03:00.000Z",
    }),
  ];

  const feedItems = buildChatFeedItems({
    messages,
    topology,
    runtimeSnapshots: {},
  });

  assert.deepEqual(
    feedItems.map((item) =>
      item.type === "message"
        ? { type: item.type, sender: item.message.sender }
        : { type: item.type, state: item.state, agentId: item.agentId }),
    [
      { type: "message", sender: "Build" },
    ],
  );
});

test("buildChatFeedItems 运行中只会携带本轮执行窗口内的历史记录", () => {
  const runtimeSnapshot: AgentRuntimeSnapshot = {
    taskId: "task-id",
    agentId: "Build",
    sessionId: "session-build",
    status: "running",
    runtimeStatus: "running",
    messageCount: 3,
    updatedAt: "2026-04-25T08:04:15.000Z",
    headline: "Build 正在处理",
    activeToolNames: ["read_file"],
    activities: [
      {
        id: "old-thinking",
        kind: "thinking",
        label: "思考",
        detail: "旧轮次",
        timestamp: "2026-04-25T08:03:00.000Z",
      },
      {
        id: "current-thinking",
        kind: "thinking",
        label: "思考",
        detail: "当前轮次",
        timestamp: "2026-04-25T08:04:10.000Z",
      },
    ],
  };
  const messages = [
    createMessage({
      id: "user-build",
      sender: "user",
      kind: "user",
      content: "@Build 请实现加法",
      targetAgentIds: ["Build"],
      timestamp: "2026-04-25T08:04:00.000Z",
    }),
  ];

  const feedItems = buildChatFeedItems({
    messages,
    topology,
    runtimeSnapshots: {
      Build: runtimeSnapshot,
    },
  });
  const runningExecution = feedItems.find(
    (item) => item.type === "execution" && item.state === "running" && item.agentId === "Build",
  );

  assert.equal(runningExecution?.type, "execution");
  if (!runningExecution || runningExecution.type !== "execution" || runningExecution.state !== "running") {
    assert.fail("缺少 Build 的运行态执行气泡");
  }
  assert.deepEqual(
    runningExecution.historyItems.map((item) => item.detail),
    ["当前轮次"],
  );
});
