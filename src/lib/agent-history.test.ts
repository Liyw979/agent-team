import test from "node:test";
import assert from "node:assert/strict";

import type { AgentRuntimeSnapshot, MessageRecord, TopologyRecord } from "@shared/types";
import { renderAgentHistoryDetailToStaticHtml } from "./agent-history-markdown";
import { buildAgentExecutionHistoryItems, buildAgentHistoryItems } from "./agent-history";

function createAgentFinalMessage(input: {
  id: string;
  sender: string;
  content: string;
  timestamp: string;
  status?: "completed" | "error";
} & (
  | {
      routingKind: "default" | "invalid";
      trigger?: never;
    }
  | {
      routingKind: "labeled";
      trigger: string;
    }
)): MessageRecord {
  const base = {
    id: input.id,
    taskId: "task-1",
    sender: input.sender,
    content: input.content,
    timestamp: input.timestamp,
    kind: "agent-final" as const,
    responseNote: "",
    rawResponse: input.content,
    status: input.status ?? "completed",
  };
  return input.routingKind === "labeled"
    ? {
        ...base,
        routingKind: "labeled",
        trigger: input.trigger,
      }
    : {
        ...base,
        routingKind: input.routingKind,
      };
}

function createTaskCompletedMessage(input: {
  id: string;
  content: string;
  timestamp: string;
  status: "failed";
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
    { source: "Build", target: "TaskReview", trigger: "<default>", messageMode: "last" },
    { source: "TaskReview", target: "Build", trigger: "<continue>", messageMode: "last" },
  ],
};

test("buildAgentHistoryItems 会返回单个 agent 的完整历史记录", () => {
  const messages: MessageRecord[] = [
    createAgentFinalMessage({
      id: "message-1",
      sender: "Build",
      content: "初版已提交",
      timestamp: "2026-04-20T09:00:00.000Z",
      routingKind: "default",
    }),
    createAgentFinalMessage({
      id: "message-2",
      sender: "Build",
      content: "第二版已提交",
      timestamp: "2026-04-20T09:03:00.000Z",
      routingKind: "default",
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

test("buildAgentExecutionHistoryItems 会把连续工具调用合并成一条历史记录", () => {
  const runtimeSnapshot: AgentRuntimeSnapshot = {
    taskId: "task-1",
    agentId: "Build",
    sessionId: "session-build",
    status: "running",
    runtimeStatus: "running",
    messageCount: 1,
    updatedAt: "2026-04-20T09:02:30.000Z",
    headline: "Build 正在排查问题",
    activeToolNames: ["read", "grep"],
    activities: [
      {
        id: "activity-thinking",
        kind: "thinking",
        label: "思考",
        detail: "先定位和权限相关的控制器",
        timestamp: "2026-04-20T09:01:00.000Z",
      },
      {
        id: "activity-tool-1",
        kind: "tool",
        label: "read",
        detail: "参数: src/main/java/com/si/demo/common/config/security/WebSecurityConfig.java",
        timestamp: "2026-04-20T09:02:00.000Z",
      },
      {
        id: "activity-tool-2",
        kind: "tool",
        label: "read",
        detail: "参数: src/main/java/com/si/demo/common/util/dict/DictCache.java",
        timestamp: "2026-04-20T09:02:01.000Z",
      },
      {
        id: "activity-tool-3",
        kind: "tool",
        label: "grep",
        detail: "参数: pattern=@PreAuthorize, path=src/main/java/com/si/demo",
        timestamp: "2026-04-20T09:02:02.000Z",
      },
    ],
  };

  assert.deepEqual(
    buildAgentExecutionHistoryItems({
      agentId: "Build",
      messages: [],
      topology,
      runtimeSnapshot,
      startedAt: "2026-04-20T09:00:00.000Z",
    }).map((item) => ({
      label: item.label,
      detail: item.detail,
      tone: item.tone,
    })),
    [
      {
        label: "思考",
        detail: "先定位和权限相关的控制器",
        tone: "runtime-thinking",
      },
      {
        label: "工具（3）",
        detail: [
          "- read · 参数: src/main/java/com/si/demo/common/config/security/WebSecurityConfig.java",
          "- read · 参数: src/main/java/com/si/demo/common/util/dict/DictCache.java",
          "- grep · 参数: pattern=@PreAuthorize, path=src/main/java/com/si/demo",
        ].join("\n"),
        tone: "runtime-tool",
      },
    ],
  );
});

test("buildAgentExecutionHistoryItems 不会跨越思考记录合并工具调用", () => {
  const runtimeSnapshot: AgentRuntimeSnapshot = {
    taskId: "task-1",
    agentId: "Build",
    sessionId: "session-build",
    status: "running",
    runtimeStatus: "running",
    messageCount: 1,
    updatedAt: "2026-04-20T09:02:30.000Z",
    headline: "Build 正在排查问题",
    activeToolNames: ["read", "grep"],
    activities: [
      {
        id: "activity-tool-1",
        kind: "tool",
        label: "read",
        detail: "参数: src/runtime/opencode-client.ts",
        timestamp: "2026-04-20T09:02:00.000Z",
      },
      {
        id: "activity-thinking",
        kind: "thinking",
        label: "思考",
        detail: "需要对比去重和展示层的边界",
        timestamp: "2026-04-20T09:02:01.000Z",
      },
      {
        id: "activity-tool-2",
        kind: "tool",
        label: "grep",
        detail: "参数: pattern=buildAgentExecutionHistoryItems, path=src",
        timestamp: "2026-04-20T09:02:02.000Z",
      },
    ],
  };

  assert.deepEqual(
    buildAgentExecutionHistoryItems({
      agentId: "Build",
      messages: [],
      topology,
      runtimeSnapshot,
      startedAt: "2026-04-20T09:00:00.000Z",
    }).map((item) => item.label),
    ["工具", "思考", "工具"],
  );
});

test("buildAgentHistoryItems 会把判定标签去掉并按当前状态展示结果标签", () => {
  const messages: MessageRecord[] = [
    createAgentFinalMessage({
      id: "decision-1",
      sender: "TaskReview",
      content: "缺少测试。\n\n请补充测试",
      timestamp: "2026-04-20T09:05:00.000Z",
      routingKind: "labeled",
      trigger: "<continue>",
    }),
  ];

  assert.deepEqual(
    buildAgentHistoryItems({
      agentId: "TaskReview",
      messages,
      topology,
    }).map((item) => ({
      label: item.label,
      detailSnippet: item.detailSnippet,
      detail: item.detail,
    })),
    [
      {
        label: "已完成判定",
        detailSnippet: "缺少测试。\n请补充测试",
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
      routingKind: "default",
    }),
  ];

  assert.deepEqual(
    buildAgentHistoryItems({
      agentId: "Build",
      messages,
      topology,
    }).map((item) => ({
      detailSnippet: item.detailSnippet,
      detail: item.detail,
    })),
    [
      {
        detailSnippet: "实际验证结果已经有了，且可以复核：\n```text\nprint('ok')\n```",
        detail: "实际验证结果已经有了，且可以复核：\n\n```text\nprint('ok')\n```",
      },
    ],
  );
});

test("buildAgentHistoryItems 会把超限失败的 decisionAgent 标记为继续处理，最后一次", () => {
  const messages: MessageRecord[] = [
    createAgentFinalMessage({
      id: "decision-final",
      sender: "TaskReview",
      content: "当前 decisionAgent 未提供额外正文。",
      timestamp: "2026-04-20T09:05:00.000Z",
      status: "error",
      routingKind: "default",
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
        detail: "当前 decisionAgent 未提供额外正文。",
      },
    ],
  );
});

test("buildAgentHistoryItems 不会把同一条最终回复同时展示成判定结果和普通消息", () => {
  const messages: MessageRecord[] = [
    createAgentFinalMessage({
      id: "decision-final",
      sender: "TaskReview",
      content: "这次我认可最终交付结论。",
      timestamp: "2026-04-20T14:34:44.000Z",
      routingKind: "default",
    }),
  ];

  const runtimeSnapshot: AgentRuntimeSnapshot = {
    taskId: "task-1",
    agentId: "TaskReview",
    sessionId: "session-decision",
    status: "completed",
    runtimeStatus: "completed",
    messageCount: 1,
    updatedAt: "2026-04-20T14:34:44.000Z",
    headline: "TaskReview 已完成",
    activeToolNames: [],
    activities: [
      {
        id: "activity-decision-message",
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

test("buildAgentHistoryItems 会保留同一条最终回复里的 thinking，并只去重最终正文", () => {
  const messages: MessageRecord[] = [
    createAgentFinalMessage({
      id: "decision-final-with-thinking",
      sender: "TaskReview",
      content: "这次我认可最终交付结论。",
      timestamp: "2026-04-20T14:34:44.000Z",
      routingKind: "labeled",
      trigger: "<complete>",
    }),
  ];

  const runtimeSnapshot: AgentRuntimeSnapshot = {
    taskId: "task-1",
    agentId: "TaskReview",
    sessionId: "session-decision",
    status: "completed",
    runtimeStatus: "completed",
    messageCount: 1,
    updatedAt: "2026-04-20T14:34:44.000Z",
    headline: "TaskReview 已完成",
    activeToolNames: [],
    activities: [
      {
        id: "decision-final-with-thinking:0:1:thinking",
        kind: "thinking",
        label: "思考",
        detail: "正在确认最终结论是否足够严谨",
        timestamp: "2026-04-20T14:34:44.000Z",
      },
      {
        id: "decision-final-with-thinking:0:2:message",
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
        label: "思考",
        detail: "正在确认最终结论是否足够严谨",
      },
      {
        label: "已完成判定",
        detail: "这次我认可最终交付结论。",
      },
    ],
  );
});

test("buildAgentHistoryItems 会按当前 agent 的 trigger 集合去掉 runtime 消息里的判定标签，并保留 markdown 加粗", () => {
  const messages: MessageRecord[] = [];
  const runtimeSnapshot: AgentRuntimeSnapshot = {
    taskId: "task-1",
    agentId: "TaskReview",
    sessionId: "session-decision",
    status: "running",
    runtimeStatus: "running",
    messageCount: 1,
    updatedAt: "2026-04-20T14:34:44.000Z",
    headline: "TaskReview 正在继续判定",
    activeToolNames: [],
    activities: [
      {
        id: "decision-message",
        kind: "message",
        label: "消息",
        detail: "<continue> 我直接挑战这轮的结论： **这里应该加粗**",
        timestamp: "2026-04-20T14:34:44.000Z",
      },
    ],
  };

  const [historyItem] = buildAgentHistoryItems({
    agentId: "TaskReview",
    messages,
    topology,
    runtimeSnapshot,
  });
  const html = renderAgentHistoryDetailToStaticHtml(historyItem?.detailSnippet ?? "");

  assert.deepEqual(
    historyItem && {
      label: historyItem.label,
      detailSnippet: historyItem.detailSnippet,
      detail: historyItem.detail,
    },
    {
      label: "消息",
      detailSnippet: "我直接挑战这轮的结论： **这里应该加粗**",
      detail: "我直接挑战这轮的结论： **这里应该加粗**",
    },
  );
  assert.match(html, /<strong data-chat-markdown-role="strong">这里应该加粗<\/strong>/);
  assert.doesNotMatch(html, /&lt;continue&gt;/);
});

test("buildAgentHistoryItems 不会误删普通 agent 正文里以 <default> 开头的内容", () => {
  const messages: MessageRecord[] = [];
  const runtimeSnapshot: AgentRuntimeSnapshot = {
    taskId: "task-1",
    agentId: "Build",
    sessionId: "session-build",
    status: "running",
    runtimeStatus: "running",
    messageCount: 1,
    updatedAt: "2026-04-20T14:40:00.000Z",
    headline: "Build 正在整理说明",
    activeToolNames: [],
    activities: [
      {
        id: "build-message",
        kind: "message",
        label: "消息",
        detail: "<default> 这是正文，不是判定标签",
        timestamp: "2026-04-20T14:40:00.000Z",
      },
    ],
  };

  const [historyItem] = buildAgentHistoryItems({
    agentId: "Build",
    messages,
    topology,
    runtimeSnapshot,
  });

  assert.deepEqual(
    historyItem && {
      label: historyItem.label,
      detailSnippet: historyItem.detailSnippet,
      detail: historyItem.detail,
    },
    {
      label: "消息",
      detailSnippet: "<default> 这是正文，不是判定标签",
      detail: "<default> 这是正文，不是判定标签",
    },
  );
});

test("buildAgentExecutionHistoryItems 只返回本轮执行窗口内的 runtime 历史与对应最终消息", () => {
  const messages: MessageRecord[] = [
    createAgentFinalMessage({
      id: "message-old",
      sender: "Build",
      content: "旧轮次结果",
      timestamp: "2026-04-20T08:59:00.000Z",
      routingKind: "default",
    }),
    createAgentFinalMessage({
      id: "message-current",
      sender: "Build",
      content: "当前轮次结果",
      timestamp: "2026-04-20T09:03:00.000Z",
      routingKind: "default",
    }),
  ];
  const runtimeSnapshot: AgentRuntimeSnapshot = {
    taskId: "task-1",
    agentId: "Build",
    sessionId: "session-build",
    status: "completed",
    runtimeStatus: "completed",
    messageCount: 4,
    updatedAt: "2026-04-20T09:03:00.000Z",
    headline: "Build 已完成",
    activeToolNames: [],
    activities: [
      {
        id: "old-thinking",
        kind: "thinking",
        label: "思考",
        detail: "旧轮次思考",
        timestamp: "2026-04-20T08:58:30.000Z",
      },
      {
        id: "current-thinking",
        kind: "thinking",
        label: "思考",
        detail: "当前轮次思考",
        timestamp: "2026-04-20T09:01:00.000Z",
      },
      {
        id: "message-current:0:1:message",
        kind: "message",
        label: "消息",
        detail: "当前轮次结果",
        timestamp: "2026-04-20T09:03:00.000Z",
      },
    ],
  };

  assert.deepEqual(
    buildAgentExecutionHistoryItems({
      agentId: "Build",
      messages,
      topology,
      runtimeSnapshot,
      startedAt: "2026-04-20T09:00:00.000Z",
      finalMessageId: "message-current",
      completedAt: "2026-04-20T09:03:00.000Z",
    }).map((item) => ({
      label: item.label,
      detail: item.detail,
    })),
    [
      {
        label: "思考",
        detail: "当前轮次思考",
      },
      {
        label: "已完成",
        detail: "当前轮次结果",
      },
    ],
  );
});
