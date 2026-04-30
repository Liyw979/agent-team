import assert from "node:assert/strict";
import test from "node:test";

import type {
  MessageRecord,
  TaskAgentRecord,
  TaskStatus,
  TopologyEdgeTrigger,
  TopologyRecord,
} from "@shared/types";

import {
  buildDownstreamForwardedContextFromMessages,
  buildUserHistoryContent,
  getInitialUserMessageContent,
} from "./message-forwarding";
import { resolveForwardingActiveAgentIdsFromState } from "./forwarding-active-agents";
import {
  resolveAgentStatusFromRouting,
  resolveActionRequiredRequestContinuationAction,
  shouldStopTaskForUnhandledActionRequiredRequest,
} from "./gating-rules";
import {
  getPersistedCompletionSeedAgentIds,
  resolveStandaloneTaskStatusAfterAgentRun,
  shouldFinishTaskFromPersistedState,
} from "./task-lifecycle-rules";
import { buildTaskCompletionMessageContent } from "./task-completion-message";

const TEST_TASK_ID = "task-1";
const TEST_TIMESTAMP = "2026-04-16T00:00:00.000Z";

function createTopologyForTest(input: {
  nodes: string[];
  edges: Array<{
    source: string;
    target: string;
    trigger: TopologyEdgeTrigger;
    messageMode: "last" | "none" | "last-all";
  }>;
}): TopologyRecord {
  const nodeIds = new Set<string>();
  for (const agentId of input.nodes) {
    nodeIds.add(agentId);
  }
  for (const edge of input.edges) {
    nodeIds.add(edge.source);
    nodeIds.add(edge.target);
  }

  return {
    nodes: [...nodeIds],
    edges: input.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      trigger: edge.trigger,
      messageMode: edge.messageMode,
    })),
  };
}

function createUserMessage(input: {
  content: string;
  timestamp: string;
  targetAgentIds: string[];
}): MessageRecord {
  return {
    id: `user:${input.content}`,
    taskId: TEST_TASK_ID,
    sender: "user",
    content: input.content,
    timestamp: input.timestamp,
    kind: "user",
    scope: "task",
    taskTitle: "demo",
    targetAgentIds: input.targetAgentIds,
    targetRunCounts: input.targetAgentIds.map(() => 1),
  };
}

function createAgentFinalMessage(input: {
  sender: string;
  content: string;
  timestamp: string;
  routingKind: "default" | "invalid";
}): MessageRecord {
  return {
    id: `${input.sender}:${input.content}`,
    taskId: TEST_TASK_ID,
    sender: input.sender,
    content: input.content,
    timestamp: input.timestamp,
    kind: "agent-final",
    runCount: 1,
    status: "completed",
    routingKind: input.routingKind,
    responseNote: "",
    rawResponse: input.content,
  };
}

function createAgentDispatchMessage(input: {
  sender: string;
  content: string;
  timestamp: string;
  targetAgentIds: string[];
}): MessageRecord {
  return {
    id: `${input.sender}:${input.content}`,
    taskId: TEST_TASK_ID,
    sender: input.sender,
    content: input.content,
    timestamp: input.timestamp,
    kind: "agent-dispatch",
    targetAgentIds: input.targetAgentIds,
    targetRunCounts: input.targetAgentIds.map(() => 1),
    dispatchDisplayContent: input.content,
  };
}

function createActionRequiredRequestMessage(input: {
  sender: string;
  content: string;
  timestamp: string;
  targetAgentIds: string[];
  followUpMessageId: string;
}): MessageRecord {
  return {
    id: `${input.sender}:${input.content}`,
    taskId: TEST_TASK_ID,
    sender: input.sender,
    content: input.content,
    timestamp: input.timestamp,
    kind: "action-required-request",
    followUpMessageId: input.followUpMessageId,
    targetAgentIds: input.targetAgentIds,
    targetRunCounts: input.targetAgentIds.map(() => 1),
  };
}

function createAgent(input: {
  id: string;
  status: TaskAgentRecord["status"];
  runCount: number;
}): TaskAgentRecord {
  return {
    taskId: TEST_TASK_ID,
    id: input.id,
    opencodeSessionId: `session:${input.id}`,
    opencodeAttachBaseUrl: "http://127.0.0.1:43127",
    status: input.status,
    runCount: input.runCount,
  };
}

test("下游结构化 prompt 的 Initial Task 继续使用首条用户任务，而不是最新追问", () => {
  const messages = [
    createUserMessage({
      content: "@Build 初始任务：实现加法工具",
      timestamp: TEST_TIMESTAMP,
      targetAgentIds: ["Build"],
    }),
    createUserMessage({
      content: "@Build 追问：顺便补一份使用说明",
      timestamp: TEST_TIMESTAMP,
      targetAgentIds: ["Build"],
    }),
  ];

  const forwarded = buildDownstreamForwardedContextFromMessages(
    messages,
    "Build 已完成实现，等待下游继续处理。",
    {
      includeInitialTask: true,
      messageMode: "last",
    },
  );

  assert.equal(forwarded.userMessage, "初始任务：实现加法工具");
  assert.equal(forwarded.agentMessage, "Build 已完成实现，等待下游继续处理。");
});

test("边配置为 none 时，下游只收到原始标签正文，不再携带上游最后一条正文", () => {
  const messages = [
    createUserMessage({
      content: "@Build 初始任务：实现加法工具",
      timestamp: TEST_TIMESTAMP,
      targetAgentIds: ["Build"],
    }),
    createAgentFinalMessage({
      sender: "Build",
      content: "我已经写完加法工具，并补了测试。",
      timestamp: TEST_TIMESTAMP,
      routingKind: "default",
    }),
  ];

  const forwarded = buildDownstreamForwardedContextFromMessages(
    messages,
    "我已经写完加法工具，并补了测试。",
    {
      messageMode: "none",
      includeInitialTask: true,
    },
  );

  assert.equal(forwarded.userMessage, "初始任务：实现加法工具");
  assert.equal(forwarded.agentMessage, "[no-forwarded-message]");
});

test("边配置为 last-all 时，只转发当前激活 agent 的最后消息", () => {
  const messages = [
    createUserMessage({
      content: "@Build 初始任务：实现加法工具",
      timestamp: TEST_TIMESTAMP,
      targetAgentIds: ["Build"],
    }),
    createAgentFinalMessage({
      sender: "agent-1",
      content: "agent-1 的历史消息",
      timestamp: TEST_TIMESTAMP,
      routingKind: "default",
    }),
    createAgentFinalMessage({
      sender: "bgent-1",
      content: "bgent-1 的历史消息",
      timestamp: TEST_TIMESTAMP,
      routingKind: "default",
    }),
    createAgentFinalMessage({
      sender: "agent-2",
      content: "agent-2 的历史消息",
      timestamp: TEST_TIMESTAMP,
      routingKind: "default",
    }),
    createAgentFinalMessage({
      sender: "bgent-2",
      content: "bgent-2 的历史消息",
      timestamp: TEST_TIMESTAMP,
      routingKind: "default",
    }),
    createAgentFinalMessage({
      sender: "agent-3",
      content: "agent-3 的上一条消息",
      timestamp: TEST_TIMESTAMP,
      routingKind: "default",
    }),
    createAgentFinalMessage({
      sender: "bgent-3",
      content: "bgent-3 的上一条消息",
      timestamp: TEST_TIMESTAMP,
      routingKind: "default",
    }),
    createAgentFinalMessage({
      sender: "agent-3",
      content: "agent-3 的最后一条消息",
      timestamp: TEST_TIMESTAMP,
      routingKind: "default",
    }),
    createAgentFinalMessage({
      sender: "bgent-3",
      content: "bgent-3 的最后一条消息",
      timestamp: TEST_TIMESTAMP,
      routingKind: "default",
    }),
  ];

  const forwarded = buildDownstreamForwardedContextFromMessages(
    messages,
    "bgent-3 的最后一条消息",
    {
      messageMode: "last-all",
      includeInitialTask: true,
      activeAgentIds: ["agent-3", "bgent-3"],
    },
  );

  assert.equal(forwarded.userMessage, "初始任务：实现加法工具");
  assert.equal(
    forwarded.agentMessage,
    [
      "[agent-3] agent-3 的最后一条消息",
      "[bgent-3] bgent-3 的最后一条消息",
    ].join("\n\n"),
  );
});

test("spawn 组里的 last-all 参与者会包含当前 finding 的来源 agent", () => {
  const activeAgentIds = resolveForwardingActiveAgentIdsFromState(
    {
      runtimeNodes: [
        {
          id: "漏洞挑战-3",
          kind: "agent",
          templateName: "漏洞挑战",
          displayName: "漏洞挑战-3",
          sourceNodeId: "线索发现",
          groupId: "spawn-rule:疑点辩论:finding-003",
          role: "漏洞挑战",
        },
        {
          id: "漏洞论证-3",
          kind: "agent",
          templateName: "漏洞论证",
          displayName: "漏洞论证-3",
          sourceNodeId: "线索发现",
          groupId: "spawn-rule:疑点辩论:finding-003",
          role: "漏洞论证",
        },
        {
          id: "讨论总结-3",
          kind: "agent",
          templateName: "讨论总结",
          displayName: "讨论总结-3",
          sourceNodeId: "线索发现",
          groupId: "spawn-rule:疑点辩论:finding-003",
          role: "讨论总结",
        },
      ],
    },
    "漏洞论证-3",
    "讨论总结-3",
  );

  assert.deepEqual(activeAgentIds, [
    "线索发现",
    "漏洞挑战-3",
    "漏洞论证-3",
    "讨论总结-3",
  ]);
});

test("spawn 组里的 last-all 转发会包含来源 agent 与同组 agent 的最后消息", () => {
  const messages = [
    createUserMessage({
      content: "@线索发现 请持续挖掘当前代码中的可疑漏洞点。",
      timestamp: TEST_TIMESTAMP,
      targetAgentIds: ["线索发现"],
    }),
    createAgentFinalMessage({
      sender: "线索发现",
      content: "线索发现发现了 safe4 的可疑点。",
      timestamp: TEST_TIMESTAMP,
      routingKind: "default",
    }),
    createAgentFinalMessage({
      sender: "漏洞挑战-3",
      content: "漏洞挑战-3 认为证据还不够支撑中危结论。",
      timestamp: TEST_TIMESTAMP,
      routingKind: "default",
    }),
    createAgentFinalMessage({
      sender: "漏洞论证-3",
      content: "漏洞论证-3 补充了接口可达性与异常触发路径。",
      timestamp: TEST_TIMESTAMP,
      routingKind: "default",
    }),
  ];
  const activeAgentIds = resolveForwardingActiveAgentIdsFromState(
    {
      runtimeNodes: [
        {
          id: "漏洞挑战-3",
          kind: "agent",
          templateName: "漏洞挑战",
          displayName: "漏洞挑战-3",
          sourceNodeId: "线索发现",
          groupId: "spawn-rule:疑点辩论:finding-003",
          role: "漏洞挑战",
        },
        {
          id: "漏洞论证-3",
          kind: "agent",
          templateName: "漏洞论证",
          displayName: "漏洞论证-3",
          sourceNodeId: "线索发现",
          groupId: "spawn-rule:疑点辩论:finding-003",
          role: "漏洞论证",
        },
        {
          id: "讨论总结-3",
          kind: "agent",
          templateName: "讨论总结",
          displayName: "讨论总结-3",
          sourceNodeId: "线索发现",
          groupId: "spawn-rule:疑点辩论:finding-003",
          role: "讨论总结",
        },
      ],
    },
    "漏洞论证-3",
    "讨论总结-3",
  );

  const forwarded = buildDownstreamForwardedContextFromMessages(
    messages,
    "漏洞论证-3 补充了接口可达性与异常触发路径。",
    {
      messageMode: "last-all",
      includeInitialTask: true,
      activeAgentIds,
    },
  );

  assert.equal(forwarded.userMessage, "请持续挖掘当前代码中的可疑漏洞点。");
  assert.equal(
    forwarded.agentMessage,
    [
      "[线索发现] 线索发现发现了 safe4 的可疑点。",
      "[漏洞挑战-3] 漏洞挑战-3 认为证据还不够支撑中危结论。",
      "[漏洞论证-3] 漏洞论证-3 补充了接口可达性与异常触发路径。",
    ].join("\n\n"),
  );
});

test("群聊消息保留寻址 @Agent，但下游转发读取时会去掉该寻址标记", () => {
  const storedUserContent = buildUserHistoryContent(
    "在当前项目的一个临时文件中实现一个加法工具，调用后传入a和b，返回c @BA",
    "BA",
  );
  const messages = [
    createUserMessage({
      content: storedUserContent,
      timestamp: TEST_TIMESTAMP,
      targetAgentIds: ["BA"],
    }),
  ];

  const forwardedUserContent = getInitialUserMessageContent(messages);

  assert.equal(messages[0]?.content.includes("@BA"), true);
  assert.equal(forwardedUserContent.includes("@BA"), false);
  assert.equal(forwardedUserContent.includes("返回c"), true);
});

test("单目标消息也只通过 targetAgentIds 数组表达目标", () => {
  const messages = [
    createUserMessage({
      content: "@Build 初始任务：实现加法工具",
      timestamp: TEST_TIMESTAMP,
      targetAgentIds: ["Build"],
    }),
    createActionRequiredRequestMessage({
      sender: "TaskReview",
      content: "请补充实现依据。\n\n@Build",
      timestamp: TEST_TIMESTAMP,
      followUpMessageId: "follow-up-task-review",
      targetAgentIds: ["Build"],
    }),
  ];

  assert.equal(
    getInitialUserMessageContent(messages),
    "初始任务：实现加法工具",
  );
  assert.deepEqual(
    getPersistedCompletionSeedAgentIds({
      topology: createTopologyForTest({
        nodes: ["Build", "TaskReview"],
        edges: [
          {
            source: "TaskReview",
            target: "Build",
            trigger: "<continue>",
            messageMode: "last",
          },
        ],
      }),
      agents: [
        createAgent({ id: "Build", status: "idle", runCount: 0 }),
        createAgent({ id: "TaskReview", status: "completed", runCount: 1 }),
      ],
      messages,
    }),
    ["TaskReview", "Build"],
  );
});

test("旧运行数据里悬空 idle Agent 不会阻止持久化补偿逻辑判定任务结束", () => {
  const topology = createTopologyForTest({
    nodes: [
      "BA",
      "Build",
      "CodeReview",
      "IntegrationTest",
      "TaskReview",
      "UnitTest",
    ],
    edges: [
      {
        source: "BA",
        target: "Build",
        trigger: "<default>",
        messageMode: "last",
      },
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
        source: "Build",
        target: "CodeReview",
        trigger: "<default>",
        messageMode: "last",
      },
    ],
  });
  const agents = [
    createAgent({ id: "BA", status: "completed", runCount: 1 }),
    createAgent({ id: "Build", status: "completed", runCount: 1 }),
    createAgent({ id: "UnitTest", status: "completed", runCount: 1 }),
    createAgent({ id: "TaskReview", status: "completed", runCount: 1 }),
    createAgent({ id: "CodeReview", status: "completed", runCount: 1 }),
    createAgent({ id: "IntegrationTest", status: "idle", runCount: 0 }),
  ];
  const messages = [
    createAgentFinalMessage({
      sender: "Build",
      content: "所有参与的 Agent 都已完成。",
      timestamp: TEST_TIMESTAMP,
      routingKind: "default",
    }),
  ];

  const shouldFinish = shouldFinishTaskFromPersistedState({
    taskStatus: "running",
    topology,
    agents,
    messages,
  });

  assert.equal(shouldFinish, true);
});

test("最新一条仍是用户 @Agent 追问时，持久化补偿逻辑不会提前把任务判 finished", () => {
  const topology = createTopologyForTest({
    nodes: ["UnitTest"],
    edges: [],
  });
  const agents = [
    createAgent({ id: "UnitTest", status: "completed", runCount: 1 }),
  ];
  const messages = [
    createUserMessage({
      content: "@UnitTest 你的指责呢",
      timestamp: TEST_TIMESTAMP,
      targetAgentIds: ["UnitTest"],
    }),
  ];

  const shouldFinish = shouldFinishTaskFromPersistedState({
    taskStatus: "running" as TaskStatus,
    topology,
    agents,
    messages,
  });

  assert.equal(shouldFinish, false);
});

test("spawn 运行时实例刚被 dispatch 但尚未完成时，持久化补偿逻辑不会提前把任务判 finished", () => {
  const topology = createTopologyForTest({
    nodes: ["线索发现", "疑点辩论"],
    edges: [
      {
        source: "线索发现",
        target: "疑点辩论",
        trigger: "<default>",
        messageMode: "last",
      },
    ],
  });
  const runtimeAgentId = "漏洞论证-1";
  const agents = [
    createAgent({ id: "线索发现", status: "completed", runCount: 1 }),
    createAgent({ id: runtimeAgentId, status: "idle", runCount: 0 }),
  ];
  const messages = [
    createAgentFinalMessage({
      sender: "线索发现",
      content: "线索发现发现了一个可疑点。",
      timestamp: TEST_TIMESTAMP,
      routingKind: "default",
    }),
    createAgentDispatchMessage({
      sender: "线索发现",
      content: `@${runtimeAgentId}`,
      timestamp: "2026-04-16T00:00:01.000Z",
      targetAgentIds: [runtimeAgentId],
    }),
  ];

  const shouldFinish = shouldFinishTaskFromPersistedState({
    taskStatus: "running",
    topology,
    agents,
    messages,
  });

  assert.equal(shouldFinish, false);
});

test("spawn 运行时实例已写入 dispatch 消息但尚未落库为 task agent 时，持久化补偿逻辑不会提前把任务判 finished", () => {
  const topology = createTopologyForTest({
    nodes: ["线索发现", "疑点辩论"],
    edges: [
      {
        source: "线索发现",
        target: "疑点辩论",
        trigger: "<default>",
        messageMode: "last",
      },
    ],
  });
  const runtimeAgentId = "漏洞论证-1";
  const agents = [
    createAgent({ id: "线索发现", status: "completed", runCount: 1 }),
  ];
  const messages = [
    createAgentFinalMessage({
      sender: "线索发现",
      content: "线索发现发现了一个可疑点。",
      timestamp: TEST_TIMESTAMP,
      routingKind: "default",
    }),
    createAgentDispatchMessage({
      sender: "线索发现",
      content: `@${runtimeAgentId}`,
      timestamp: "2026-04-16T00:00:01.000Z",
      targetAgentIds: [runtimeAgentId],
    }),
  ];

  const shouldFinish = shouldFinishTaskFromPersistedState({
    taskStatus: "running",
    topology,
    agents,
    messages,
  });

  assert.equal(shouldFinish, false);
});

test("decisionAgent 仍处于 action_required 状态时，持久化补偿逻辑不会把中途流程误判为 finished", () => {
  const topology = createTopologyForTest({
    nodes: ["Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      {
        source: "Build",
        target: "CodeReview",
        trigger: "<default>",
        messageMode: "last",
      },
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
        source: "CodeReview",
        target: "Build",
        trigger: "<continue>",
        messageMode: "last",
      },
    ],
  });
  const agents = [
    createAgent({ id: "Build", status: "completed", runCount: 2 }),
    createAgent({ id: "CodeReview", status: "action_required", runCount: 1 }),
    createAgent({ id: "UnitTest", status: "completed", runCount: 1 }),
    createAgent({ id: "TaskReview", status: "completed", runCount: 1 }),
  ];
  const messages = [
    createAgentFinalMessage({
      sender: "Build",
      content: "Build 首轮实现完成。",
      timestamp: "2026-04-24T15:36:15.000Z",
      routingKind: "default",
    }),
    createAgentDispatchMessage({
      sender: "Build",
      content: "@CodeReview @UnitTest @TaskReview",
      targetAgentIds: ["CodeReview", "UnitTest", "TaskReview"],
      timestamp: "2026-04-24T15:36:16.000Z",
    }),
    createActionRequiredRequestMessage({
      sender: "CodeReview",
      content: "还需要继续修改。\n\n@Build",
      followUpMessageId: "follow-up-code-review",
      targetAgentIds: ["Build"],
      timestamp: "2026-04-24T15:36:29.000Z",
    }),
    createAgentFinalMessage({
      sender: "UnitTest",
      content: "测试通过。",
      timestamp: "2026-04-24T15:37:20.000Z",
      routingKind: "default",
    }),
    createAgentFinalMessage({
      sender: "TaskReview",
      content: "可以验收。",
      timestamp: "2026-04-24T15:37:21.000Z",
      routingKind: "default",
    }),
  ];

  const shouldFinish = shouldFinishTaskFromPersistedState({
    taskStatus: "running",
    topology,
    agents,
    messages,
  });

  assert.equal(shouldFinish, false);
});

test("最新一条是 agent-dispatch 时，持久化补偿逻辑不会把重新派发中的任务误判为 finished", () => {
  const topology = createTopologyForTest({
    nodes: ["Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      {
        source: "Build",
        target: "CodeReview",
        trigger: "<default>",
        messageMode: "last",
      },
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
        source: "CodeReview",
        target: "Build",
        trigger: "<continue>",
        messageMode: "last",
      },
      {
        source: "UnitTest",
        target: "Build",
        trigger: "<continue>",
        messageMode: "last",
      },
      {
        source: "TaskReview",
        target: "Build",
        trigger: "<continue>",
        messageMode: "last",
      },
    ],
  });
  const agents = [
    createAgent({ id: "Build", status: "completed", runCount: 3 }),
    createAgent({ id: "CodeReview", status: "completed", runCount: 1 }),
    createAgent({ id: "UnitTest", status: "completed", runCount: 2 }),
    createAgent({ id: "TaskReview", status: "completed", runCount: 1 }),
  ];
  const messages = [
    createAgentFinalMessage({
      sender: "Build",
      content: "Build 已根据 UnitTest 意见修复完成。",
      timestamp: "2026-04-24T15:37:17.000Z",
      routingKind: "default",
    }),
    createAgentDispatchMessage({
      sender: "Build",
      content: "@CodeReview @TaskReview",
      targetAgentIds: ["CodeReview", "TaskReview"],
      timestamp: "2026-04-24T15:37:20.000Z",
    }),
  ];

  const shouldFinish = shouldFinishTaskFromPersistedState({
    taskStatus: "running",
    topology,
    agents,
    messages,
  });

  assert.equal(shouldFinish, false);
});

test("没有消息和运行痕迹时，持久化补偿逻辑只会把 Build 当默认入口 seed", () => {
  const topology = createTopologyForTest({
    nodes: ["BA", "Build", "TaskReview"],
    edges: [
      {
        source: "Build",
        target: "TaskReview",
        trigger: "<default>",
        messageMode: "last",
      },
    ],
  });
  const seedAgentIds = getPersistedCompletionSeedAgentIds({
    topology,
    agents: [
      createAgent({ id: "BA", status: "idle", runCount: 0 }),
      createAgent({ id: "Build", status: "idle", runCount: 0 }),
      createAgent({ id: "TaskReview", status: "idle", runCount: 0 }),
    ],
    messages: [],
  });

  assert.deepEqual(seedAgentIds, ["Build"]);
});

test("过期 decisionAgent 回复不应被当成有效回流继续触发修复", () => {
  const action = resolveActionRequiredRequestContinuationAction({
    continuation: null,
  });

  assert.equal(action, "ignore");
});

test("decisionAgent 已经形成有效回流动作时，不应直接结束 Task", () => {
  const shouldStopTask = shouldStopTaskForUnhandledActionRequiredRequest({
    completeTaskOnFinish: true,
    continuationAction: "trigger_repair_decision",
  });

  assert.equal(shouldStopTask, false);
});

test("decisionAgent 给出需要修复时应标记为 action_required 而不是 failed", () => {
  const status = resolveAgentStatusFromRouting({
    routingKind: "labeled",
    decisionAgent: true,
    enteredActionRequired: true,
  });

  assert.equal(status, "action_required");
});

test("decisionAgent 缺少强制标签时应标记为 failed", () => {
  const status = resolveAgentStatusFromRouting({
    routingKind: "invalid",
    decisionAgent: true,
    enteredActionRequired: false,
  });

  assert.equal(status, "failed");
});

test("非拓扑驱动的单次执行后，仍有未完成 Agent 时任务进入 finished", () => {
  const status = resolveStandaloneTaskStatusAfterAgentRun({
    latestAgentStatus: "completed",
    agentStatuses: [
      createAgent({ id: "Build", status: "completed", runCount: 1 }),
      createAgent({ id: "QA", status: "idle", runCount: 0 }),
    ],
  });

  assert.equal(status, "finished");
});

test("非拓扑驱动的单次执行后，全部 Agent 已完成时任务进入 finished", () => {
  const status = resolveStandaloneTaskStatusAfterAgentRun({
    latestAgentStatus: "completed",
    agentStatuses: [
      createAgent({ id: "Build", status: "completed", runCount: 1 }),
      createAgent({ id: "QA", status: "completed", runCount: 1 }),
    ],
  });

  assert.equal(status, "finished");
});

test("非拓扑驱动的单次执行失败时任务直接进入 failed", () => {
  const status = resolveStandaloneTaskStatusAfterAgentRun({
    latestAgentStatus: "failed",
    agentStatuses: [
      createAgent({ id: "Build", status: "failed", runCount: 1 }),
      createAgent({ id: "QA", status: "idle", runCount: 0 }),
    ],
  });

  assert.equal(status, "failed");
});

test("任务失败完成消息优先展示明确失败原因", () => {
  const content = buildTaskCompletionMessageContent({
    status: "failed",
    taskTitle: "演示任务",
    failureReason: "UnitTest -> Build 已连续交流 4 次，任务已结束",
  });

  assert.equal(content, "UnitTest -> Build 已连续交流 4 次，任务已结束");
});
