import test from "node:test";
import assert from "node:assert/strict";

import type { AgentRuntimeSnapshot, MessageRecord, TopologyRecord } from "@shared/types";
import { buildAgentHistoryItems } from "./agent-history";

function createAgentFinalMessage(input: {
  id: string;
  sender: string;
  content: string;
  timestamp: string;
  reviewDecision?: "complete" | "continue" | "invalid";
  status?: "completed" | "error";
}): MessageRecord {
  return {
    id: input.id,
    taskId: "task-1",
    sender: input.sender,
    content: input.content,
    timestamp: input.timestamp,
    kind: "agent-final",
    reviewDecision: input.reviewDecision ?? "complete",
    reviewOpinion: "",
    rawResponse: input.content,
    status: input.status ?? "completed",
  };
}

function createTaskCompletedMessage(input: {
  id: string;
  content: string;
  timestamp: string;
  status: "finished" | "failed";
}): MessageRecord {
  return {
    id: input.id,
    taskId: "task-1",
    sender: "system",
    content: input.content,
    timestamp: input.timestamp,
    kind: "task-completed",
    status: input.status,
  };
}

const topology: TopologyRecord = {
  nodes: ["Build", "TaskReview"],
  edges: [
    { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
    { source: "TaskReview", target: "Build", triggerOn: "continue", messageMode: "last" },
  ],
};

test("buildAgentHistoryItems 会返回单个 agent 的完整历史记录", () => {
  const messages: MessageRecord[] = [
    createAgentFinalMessage({
      id: "message-1",
      sender: "Build",
      content: "初版已提交",
      timestamp: "2026-04-20T09:00:00.000Z",
    }),
    createAgentFinalMessage({
      id: "message-2",
      sender: "Build",
      content: "第二版已提交",
      timestamp: "2026-04-20T09:03:00.000Z",
    }),
  ];
  const runtimeSnapshot: AgentRuntimeSnapshot = {
    taskId: "task-1",
    agentId: "Build",
    sessionId: "session-build",
    status: "running",
    runtimeStatus: "running",
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

test("buildAgentHistoryItems 会把审查标签去掉并标记为继续处理", () => {
  const messages: MessageRecord[] = [
    createAgentFinalMessage({
      id: "review-1",
      sender: "TaskReview",
      content: "缺少测试。\n\n请补充测试",
      timestamp: "2026-04-20T09:05:00.000Z",
      reviewDecision: "continue",
    }),
  ];

  assert.deepEqual(
    buildAgentHistoryItems({
      agentId: "TaskReview",
      messages,
      topology,
    }).map((item) => ({
      label: item.label,
      previewDetail: item.previewDetail,
      detail: item.detail,
    })),
    [
      {
        label: "继续处理",
        previewDetail: "缺少测试。\n请补充测试",
        detail: "缺少测试。\n\n请补充测试",
      },
    ],
  );
});

test("buildAgentHistoryItems 会移除历史消息中的多余空行，避免卡片里出现大块空白", () => {
  const messages: MessageRecord[] = [
    createAgentFinalMessage({
      id: "message-blank-lines",
      sender: "Build",
      content: "实际验证结果已经有了，且可以复核：\n\n```text\nprint('ok')\n```",
      timestamp: "2026-04-20T09:06:00.000Z",
    }),
  ];

  assert.deepEqual(
    buildAgentHistoryItems({
      agentId: "Build",
      messages,
      topology,
    }).map((item) => ({
      previewDetail: item.previewDetail,
      detail: item.detail,
    })),
    [
      {
        previewDetail: "实际验证结果已经有了，且可以复核：\n```text\nprint('ok')\n```",
        detail: "实际验证结果已经有了，且可以复核：\n\n```text\nprint('ok')\n```",
      },
    ],
  );
});

test("buildAgentHistoryItems 会把超限失败的 reviewer 标记为继续处理，最后一次", () => {
  const messages: MessageRecord[] = [
    createAgentFinalMessage({
      id: "review-final",
      sender: "TaskReview",
      content: "当前 reviewer 未提供额外正文。",
      timestamp: "2026-04-20T09:05:00.000Z",
      status: "error",
    }),
    createTaskCompletedMessage({
      id: "task-failed",
      content: "TaskReview -> Build 已连续交流 4 次，任务已结束",
      timestamp: "2026-04-20T09:05:01.000Z",
      status: "failed",
    }),
  ];

  assert.deepEqual(
    buildAgentHistoryItems({
      agentId: "TaskReview",
      messages,
      topology,
    }).map((item) => ({
      label: item.label,
      detail: item.detail,
    })),
    [
      {
        label: "继续处理，最后一次",
        detail: "当前 reviewer 未提供额外正文。",
      },
    ],
  );
});

test("buildAgentHistoryItems 不会把同一条最终回复同时展示成审视结果和普通消息", () => {
  const messages: MessageRecord[] = [
    createAgentFinalMessage({
      id: "review-final",
      sender: "TaskReview",
      content: "这次我认可最终交付结论。",
      timestamp: "2026-04-20T14:34:44.000Z",
    }),
  ];

  const runtimeSnapshot: AgentRuntimeSnapshot = {
    taskId: "task-1",
    agentId: "TaskReview",
    sessionId: "session-review",
    status: "completed",
    runtimeStatus: "completed",
    messageCount: 1,
    updatedAt: "2026-04-20T14:34:44.000Z",
    headline: "TaskReview 已完成",
    activeToolNames: [],
    activities: [
      {
        id: "activity-review-message",
        kind: "message",
        label: "消息",
        detail: "这次我认可最终交付结论。",
        timestamp: "2026-04-20T14:34:44.000Z",
      },
    ],
  };

  assert.deepEqual(
    buildAgentHistoryItems({
      agentId: "TaskReview",
      messages,
      topology,
      runtimeSnapshot,
    }).map((item) => ({
      label: item.label,
      detail: item.detail,
    })),
    [
      {
        label: "已完成判定",
        detail: "这次我认可最终交付结论。",
      },
    ],
  );
});

test("buildAgentHistoryItems 不会把同一条最终回复里的 thinking 再展示到审视结果后面", () => {
  const messages: MessageRecord[] = [
    createAgentFinalMessage({
      id: "review-final-with-thinking",
      sender: "TaskReview",
      content: "这次我认可最终交付结论。",
      timestamp: "2026-04-20T14:34:44.000Z",
      reviewDecision: "complete",
    }),
  ];

  const runtimeSnapshot: AgentRuntimeSnapshot = {
    taskId: "task-1",
    agentId: "TaskReview",
    sessionId: "session-review",
    status: "completed",
    runtimeStatus: "completed",
    messageCount: 1,
    updatedAt: "2026-04-20T14:34:44.000Z",
    headline: "TaskReview 已完成",
    activeToolNames: [],
    activities: [
      {
        id: "review-final-with-thinking:0:1:thinking",
        kind: "thinking",
        label: "思考",
        detail: "正在确认最终结论是否足够严谨",
        timestamp: "2026-04-20T14:34:44.000Z",
      },
      {
        id: "review-final-with-thinking:0:2:message",
        kind: "message",
        label: "消息",
        detail: "这次我认可最终交付结论。",
        timestamp: "2026-04-20T14:34:44.000Z",
      },
    ],
  };

  assert.deepEqual(
    buildAgentHistoryItems({
      agentId: "TaskReview",
      messages,
      topology,
      runtimeSnapshot,
    }).map((item) => ({
      label: item.label,
      detail: item.detail,
    })),
    [
      {
        label: "已完成判定",
        detail: "这次我认可最终交付结论。",
      },
    ],
  );
});
