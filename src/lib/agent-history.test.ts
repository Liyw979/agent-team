import test from "node:test";
import assert from "node:assert/strict";

import type {
  MessageRecord,
  TopologyNodeRecord,
  TopologyRecord,
} from "@shared/types";
import { renderAgentHistoryDetailToStaticHtml } from "./agent-history-markdown";
import {
  buildAgentExecutionHistoryItems,
  buildAgentHistoryItems,
} from "./agent-history";

function createAgentFinalMessage(
  input: {
    id: string;
    sender: string;
    content: string;
    timestamp: string;
    runCount?: number;
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
  ),
): MessageRecord {
  const base = {
    id: input.id,
    taskId: "task-1",
    sender: input.sender,
    content: input.content,
    timestamp: input.timestamp,
    kind: "agent-final" as const,
    runCount: input.runCount ?? 1,
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

function createAgentProgressMessage(input: {
  id: string;
  sender: string;
  content: string;
  timestamp: string;
  activityKind?: "thinking" | "tool" | "step" | "message";
  label?: string;
  detail?: string;
  sessionId?: string;
  runCount?: number;
}): MessageRecord {
  return {
    id: input.id,
    taskId: "task-1",
    sender: input.sender,
    content: input.content,
    timestamp: input.timestamp,
    kind: "agent-progress",
    activityKind: input.activityKind ?? "message",
    label: input.label ?? input.content,
    detail: input.detail ?? input.content,
    detailState: "not_applicable",
    sessionId: input.sessionId ?? `session-${input.sender}`,
    runCount: input.runCount ?? 1,
  };
}

const topology: TopologyRecord = {
  nodes: ["Build", "TaskReview"],
  edges: [
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
  nodeRecords: [
    { id: "Build", kind: "agent", templateName: "Build" },
    { id: "TaskReview", kind: "agent", templateName: "TaskReview" },
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
    createAgentProgressMessage({
      id: "message-1-progress-thinking",
      sender: "Build",
      content: "正在核对实现边界",
      timestamp: "2026-04-20T09:01:00.000Z",
      activityKind: "thinking",
      label: "思考",
      detail: "正在核对实现边界",
    }),
    createAgentProgressMessage({
      id: "message-1-progress-tool",
      sender: "Build",
      content: "read_file · 参数: src/App.tsx",
      timestamp: "2026-04-20T09:02:00.000Z",
      activityKind: "tool",
      label: "read_file",
      detail: "参数: src/App.tsx",
    }),
    createAgentFinalMessage({
      id: "message-2",
      sender: "Build",
      content: "第二版已提交",
      timestamp: "2026-04-20T09:03:00.000Z",
      routingKind: "default",
    }),
  ];

  assert.deepEqual(
    buildAgentHistoryItems({
      agentId: "Build",
      messages,
      topology,
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
  const messages: MessageRecord[] = [
    createAgentProgressMessage({
      id: "build-thinking-1",
      sender: "Build",
      content: "先定位和权限相关的控制器",
      timestamp: "2026-04-20T09:00:01.000Z",
      activityKind: "thinking",
      label: "思考",
      detail: "先定位和权限相关的控制器",
    }),
    createAgentProgressMessage({
      id: "build-tool-1",
      sender: "Build",
      content: "read",
      timestamp: "2026-04-20T09:00:02.000Z",
      activityKind: "tool",
      label: "read",
      detail:
        "参数: src/main/java/com/si/demo/common/config/security/WebSecurityConfig.java",
    }),
    createAgentProgressMessage({
      id: "build-tool-2",
      sender: "Build",
      content: "read",
      timestamp: "2026-04-20T09:00:03.000Z",
      activityKind: "tool",
      label: "read",
      detail: "参数: src/main/java/com/si/demo/common/util/dict/DictCache.java",
    }),
    createAgentProgressMessage({
      id: "build-tool-3",
      sender: "Build",
      content: "grep",
      timestamp: "2026-04-20T09:00:04.000Z",
      activityKind: "tool",
      label: "grep",
      detail: "参数: pattern=@PreAuthorize, path=src/main/java/com/si/demo",
    }),
  ];

  assert.deepEqual(
    buildAgentExecutionHistoryItems({
      agentId: "Build",
      messages,
      topology,
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
  const messages: MessageRecord[] = [
    createAgentProgressMessage({
      id: "build-tool-before",
      sender: "Build",
      content: "read",
      timestamp: "2026-04-20T09:00:01.000Z",
      activityKind: "tool",
      label: "read",
      detail: "参数: first.java",
    }),
    createAgentProgressMessage({
      id: "build-thinking-middle",
      sender: "Build",
      content: "重新判断边界",
      timestamp: "2026-04-20T09:00:02.000Z",
      activityKind: "thinking",
      label: "思考",
      detail: "重新判断边界",
    }),
    createAgentProgressMessage({
      id: "build-tool-after",
      sender: "Build",
      content: "grep",
      timestamp: "2026-04-20T09:00:03.000Z",
      activityKind: "tool",
      label: "grep",
      detail: "参数: second.java",
    }),
  ];

  assert.deepEqual(
    buildAgentExecutionHistoryItems({
      agentId: "Build",
      messages,
      topology,
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
      content:
        "实际验证结果已经有了，且可以复核：\n\n```text\nprint('ok')\n```",
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
        detailSnippet:
          "实际验证结果已经有了，且可以复核：\n```text\nprint('ok')\n```",
        detail:
          "实际验证结果已经有了，且可以复核：\n\n```text\nprint('ok')\n```",
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
        label: "已完成判定",
        detail: "这次我认可最终交付结论。",
      },
    ],
  );
});

test("buildAgentHistoryItems 会保留同一条最终回复里的 thinking，并只去重最终正文", () => {
  const messages: MessageRecord[] = [
    createAgentProgressMessage({
      id: "decision-thinking",
      sender: "TaskReview",
      content: "正在确认最终结论是否足够严谨",
      timestamp: "2026-04-20T14:34:43.000Z",
      activityKind: "thinking",
      label: "思考",
      detail: "正在确认最终结论是否足够严谨",
    }),
    createAgentFinalMessage({
      id: "decision-final-with-thinking",
      sender: "TaskReview",
      content: "这次我认可最终交付结论。",
      timestamp: "2026-04-20T14:34:44.000Z",
      routingKind: "labeled",
      trigger: "<complete>",
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
  const messages: MessageRecord[] = [
    createAgentProgressMessage({
      id: "review-runtime-message",
      sender: "TaskReview",
      content: "<continue> 我直接挑战这轮的结论： **这里应该加粗**",
      timestamp: "2026-04-20T14:34:40.000Z",
      activityKind: "message",
      label: "消息",
      detail: "<continue> 我直接挑战这轮的结论： **这里应该加粗**",
    }),
  ];

  const [historyItem] = buildAgentHistoryItems({
    agentId: "TaskReview",
    messages,
    topology,
  });
  const html = renderAgentHistoryDetailToStaticHtml(
    historyItem?.detailSnippet ?? "",
  );

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
  assert.match(
    html,
    /<strong data-chat-markdown-role="strong">这里应该加粗<\/strong>/,
  );
  assert.doesNotMatch(html, /&lt;continue&gt;/);
});

test("buildAgentHistoryItems 会按 runtime agent 对应模板的 trigger 集合去掉判定标签", () => {
  const messages: MessageRecord[] = [
    createAgentProgressMessage({
      id: "challenge-runtime-message",
      sender: "漏洞挑战-1",
      content: "<continue> 需要继续补关键代码证据",
      timestamp: "2026-04-20T14:34:40.000Z",
      activityKind: "message",
      label: "消息",
      detail: "<continue> 需要继续补关键代码证据",
    }),
  ];
  const spawnTopology: TopologyRecord = {
    nodes: ["线索发现", "漏洞挑战", "漏洞论证", "讨论总结", "疑点辩论"],
    edges: [
      {
        source: "线索发现",
        target: "疑点辩论",
        trigger: "<continue>",
        messageMode: "last-all",
      },
    ],
    nodeRecords: [
      { id: "线索发现", kind: "agent", templateName: "线索发现" },
      {
        id: "疑点辩论",
        kind: "spawn",
        templateName: "疑点辩论",
        spawnRuleId: "spawn-rule:疑点辩论",
      },
      { id: "漏洞挑战", kind: "agent", templateName: "漏洞挑战" },
      { id: "漏洞论证", kind: "agent", templateName: "漏洞论证" },
      { id: "讨论总结", kind: "agent", templateName: "讨论总结" },
    ],
    spawnRules: [
      {
        id: "spawn-rule:疑点辩论",
        spawnNodeName: "疑点辩论",
        sourceTemplateName: "线索发现",
        entryRole: "漏洞挑战",
        spawnedAgents: [
          { role: "漏洞挑战", templateName: "漏洞挑战" },
          { role: "漏洞论证", templateName: "漏洞论证" },
          { role: "讨论总结", templateName: "讨论总结" },
        ],
        edges: [
          {
            sourceRole: "漏洞挑战",
            targetRole: "漏洞论证",
            trigger: "<continue>",
            messageMode: "last",
            maxTriggerRounds: 4,
          },
          {
            sourceRole: "漏洞论证",
            targetRole: "漏洞挑战",
            trigger: "<continue>",
            messageMode: "last",
            maxTriggerRounds: 4,
          },
          {
            sourceRole: "漏洞挑战",
            targetRole: "讨论总结",
            trigger: "<complete>",
            messageMode: "last-all",
          },
          {
            sourceRole: "漏洞论证",
            targetRole: "讨论总结",
            trigger: "<complete>",
            messageMode: "last-all",
          },
        ],
        exitWhen: "all_completed",
        reportToTemplateName: "线索发现",
        reportToTrigger: "<default>",
        reportToMessageMode: "none",
      },
    ],
  };

  const [historyItem] = buildAgentHistoryItems({
    agentId: "漏洞挑战-1",
    messages,
    topology: spawnTopology,
  });

  assert.deepEqual(
    historyItem && {
      label: historyItem.label,
      detail: historyItem.detail,
    },
    {
      label: "消息",
      detail: "需要继续补关键代码证据",
    },
  );
});

test("buildAgentHistoryItems 解析 runtime agent 模板时不会误命中同前缀模板", () => {
  const messages: MessageRecord[] = [
    createAgentProgressMessage({
      id: "ab-runtime-message",
      sender: "A-B-1",
      content: "<continue> 只应匹配 A-B 模板",
      timestamp: "2026-04-20T14:34:40.000Z",
      activityKind: "message",
      label: "消息",
      detail: "<continue> 只应匹配 A-B 模板",
    }),
  ];
  const ambiguousNodeRecords: TopologyNodeRecord[] = [
    { id: "A", kind: "agent", templateName: "A" },
    { id: "A-B", kind: "agent", templateName: "A-B" },
    { id: "Next", kind: "agent", templateName: "Next" },
  ];
  const ambiguousTopology: TopologyRecord = {
    nodes: ["A", "A-B", "Next"],
    edges: [
      {
        source: "A",
        target: "Next",
        trigger: "<complete>",
        messageMode: "last",
      },
      {
        source: "A-B",
        target: "Next",
        trigger: "<continue>",
        messageMode: "last",
      },
    ],
    nodeRecords: ambiguousNodeRecords,
  };

  const [historyItem] = buildAgentHistoryItems({
    agentId: "A-B-1",
    messages,
    topology: ambiguousTopology,
  });

  assert.deepEqual(
    historyItem && {
      label: historyItem.label,
      detail: historyItem.detail,
    },
    {
      label: "消息",
      detail: "只应匹配 A-B 模板",
    },
  );
});

test("buildAgentHistoryItems 遇到归属多个 spawn rule 的模板时不会猜测 trigger 集合", () => {
  const messages: MessageRecord[] = [
    createAgentProgressMessage({
      id: "ambiguous-runtime-message",
      sender: "复核-1",
      content: "<complete> 这条标签在归属歧义时不应被清理",
      timestamp: "2026-04-20T14:34:40.000Z",
      activityKind: "message",
      label: "消息",
      detail: "<complete> 这条标签在归属歧义时不应被清理",
    }),
  ];
  const ambiguousSpawnTopology: TopologyRecord = {
    nodes: ["入口甲", "入口乙", "工厂甲", "工厂乙", "复核"],
    edges: [
      {
        source: "入口甲",
        target: "工厂甲",
        trigger: "<continue>",
        messageMode: "last-all",
      },
      {
        source: "入口乙",
        target: "工厂乙",
        trigger: "<continue>",
        messageMode: "last-all",
      },
    ],
    nodeRecords: [
      { id: "入口甲", kind: "agent", templateName: "入口甲" },
      { id: "入口乙", kind: "agent", templateName: "入口乙" },
      {
        id: "工厂甲",
        kind: "spawn",
        templateName: "工厂甲",
        spawnRuleId: "spawn-rule:甲",
      },
      {
        id: "工厂乙",
        kind: "spawn",
        templateName: "工厂乙",
        spawnRuleId: "spawn-rule:乙",
      },
      { id: "复核", kind: "agent", templateName: "复核" },
    ],
    spawnRules: [
      {
        id: "spawn-rule:甲",
        spawnNodeName: "工厂甲",
        sourceTemplateName: "入口甲",
        entryRole: "复核",
        spawnedAgents: [{ role: "复核", templateName: "复核" }],
        edges: [
          {
            sourceRole: "复核",
            targetRole: "复核",
            trigger: "<complete>",
            messageMode: "last",
          },
        ],
        exitWhen: "all_completed",
        reportToTemplateName: "入口甲",
        reportToTrigger: "<default>",
        reportToMessageMode: "none",
      },
      {
        id: "spawn-rule:乙",
        spawnNodeName: "工厂乙",
        sourceTemplateName: "入口乙",
        entryRole: "复核",
        spawnedAgents: [{ role: "复核", templateName: "复核" }],
        edges: [
          {
            sourceRole: "复核",
            targetRole: "复核",
            trigger: "<continue>",
            messageMode: "last",
          },
        ],
        exitWhen: "all_completed",
        reportToTemplateName: "入口乙",
        reportToTrigger: "<default>",
        reportToMessageMode: "none",
      },
    ],
  };

  const [historyItem] = buildAgentHistoryItems({
    agentId: "复核-1",
    messages,
    topology: ambiguousSpawnTopology,
  });

  assert.equal(
    historyItem?.detail,
    "<complete> 这条标签在归属歧义时不应被清理",
  );
});

test("buildAgentHistoryItems 不会误删普通 agent 正文里以 <default> 开头的内容", () => {
  const messages: MessageRecord[] = [
    createAgentProgressMessage({
      id: "build-default-message",
      sender: "Build",
      content: "<default> 这是正文，不是判定标签",
      timestamp: "2026-04-20T14:34:40.000Z",
      activityKind: "message",
      label: "消息",
      detail: "<default> 这是正文，不是判定标签",
    }),
  ];

  const [historyItem] = buildAgentHistoryItems({
    agentId: "Build",
    messages,
    topology,
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
    createAgentProgressMessage({
      id: "message-current-progress",
      sender: "Build",
      content: "当前轮次思考",
      timestamp: "2026-04-20T09:01:00.000Z",
      activityKind: "thinking",
      label: "思考",
      detail: "当前轮次思考",
      runCount: 2,
    }),
    createAgentFinalMessage({
      id: "message-current",
      sender: "Build",
      content: "当前轮次结果",
      timestamp: "2026-04-20T09:03:00.000Z",
      runCount: 2,
      routingKind: "default",
    }),
  ];

  assert.deepEqual(
    buildAgentExecutionHistoryItems({
      agentId: "Build",
      messages,
      topology,
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
