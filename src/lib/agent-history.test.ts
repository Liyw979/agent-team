import test from "node:test";
import assert from "node:assert/strict";

import type { AgentRuntimeSnapshot, MessageRecord, TopologyRecord } from "@shared/types";
import { buildAgentHistoryItems } from "./agent-history";

const topology: TopologyRecord = {
  nodes: ["Build", "TaskReview"],
  edges: [
    { source: "Build", target: "TaskReview", triggerOn: "association" },
    { source: "TaskReview", target: "Build", triggerOn: "needs_revision" },
  ],
};

test("buildAgentHistoryItems 会返回单个 agent 的完整历史记录", () => {
  const messages: MessageRecord[] = [
    {
      id: "message-1",
      taskId: "task-1",
      sender: "Build",
      content: "初版已提交",
      timestamp: "2026-04-20T09:00:00.000Z",
      meta: {
        kind: "agent-final",
        finalMessage: "初版已提交",
      },
    },
    {
      id: "message-2",
      taskId: "task-1",
      sender: "Build",
      content: "第二版已提交",
      timestamp: "2026-04-20T09:03:00.000Z",
      meta: {
        kind: "agent-final",
        finalMessage: "第二版已提交",
      },
    },
  ];
  const runtimeSnapshot: AgentRuntimeSnapshot = {
    taskId: "task-1",
    agentId: "Build",
    sessionId: "session-build",
    status: "running",
    messageCount: 2,
    updatedAt: "2026-04-20T09:02:30.000Z",
    headline: "Build 正在继续整理结果",
    activeToolNames: ["read_file"],
    activities: [
      {
        id: "activity-1",
        kind: "thinking",
        label: "思考",
        detail: "正在核对实现边界",
        timestamp: "2026-04-20T09:01:00.000Z",
      },
      {
        id: "activity-2",
        kind: "tool",
        label: "read_file",
        detail: "参数: src/App.tsx",
        timestamp: "2026-04-20T09:02:00.000Z",
      },
    ],
  };

  assert.deepEqual(
    buildAgentHistoryItems({
      agentId: "Build",
      messages,
      topology,
      runtimeSnapshot,
    }).map((item) => ({
      label: item.label,
      detail: item.detail,
    })),
    [
      { label: "已完成", detail: "初版已提交" },
      { label: "思考", detail: "正在核对实现边界" },
      { label: "工具", detail: "read_file · 参数: src/App.tsx" },
      { label: "已完成", detail: "第二版已提交" },
    ],
  );
});

test("buildAgentHistoryItems 会把审查标签去掉并标记为审视不通过", () => {
  const messages: MessageRecord[] = [
    {
      id: "review-1",
      taskId: "task-1",
      sender: "TaskReview",
      content: "原始消息",
      timestamp: "2026-04-20T09:05:00.000Z",
      meta: {
        kind: "agent-final",
        reviewDecision: "needs_revision",
        finalMessage: "缺少测试。\n\n<needs_revision>请补充测试</needs_revision>",
      },
    },
  ];

  assert.deepEqual(
    buildAgentHistoryItems({
      agentId: "TaskReview",
      messages,
      topology,
      runtimeSnapshot: undefined,
    }).map((item) => ({
      label: item.label,
      detail: item.detail,
    })),
    [
      {
        label: "审视不通过",
        detail: "缺少测试。\n\n请补充测试",
      },
    ],
  );
});
