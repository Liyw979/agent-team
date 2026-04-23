import assert from "node:assert/strict";
import test from "node:test";

import type {
  MessageRecord,
  TaskAgentRecord,
  TaskStatus,
  TopologyEdgeTrigger,
  TopologyRecord,
} from "@shared/types";

type TestMessageInput = {
  id?: string;
  taskId?: string;
  sender: string;
  content: string;
  timestamp?: string;
  kind?: MessageRecord["kind"];
  targetAgentIds?: string[];
  agentFinalStatus?: "completed" | "error";
  taskCompletedStatus?: "finished" | "failed";
  reviewDecision?: "complete" | "continue" | "invalid";
  senderDisplayName?: string;
};

import {
  buildDownstreamForwardedContextFromMessages,
  buildUserHistoryContent,
  getInitialUserMessageContent,
} from "./message-forwarding";
import {
  resolveAgentStatusFromReview,
  resolveActionRequiredRequestContinuationAction,
  shouldStopTaskForUnhandledActionRequiredRequest,
} from "./gating-rules";
import {
  getPersistedCompletionSeedAgentIds,
  resolveStandaloneTaskStatusAfterAgentRun,
  shouldFinishTaskFromPersistedState,
} from "./task-lifecycle-rules";
import { buildTaskCompletionMessageContent } from "./task-completion-message";

function createTopologyForTest(input: {
  nodes: string[];
  edges: Array<{ source: string; target: string; triggerOn: TopologyEdgeTrigger; messageMode?: "last" | "none" | "all" }>;
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
      triggerOn: edge.triggerOn,
      messageMode: edge.messageMode ?? "last",
    })),
  };
}

function createMessage(input: TestMessageInput): MessageRecord {
  const id = input.id ?? `${input.sender}:${input.content}`;
  const taskId = input.taskId ?? "task-1";
  const timestamp = input.timestamp ?? "2026-04-16T00:00:00.000Z";
  const kind = input.kind ?? (input.sender === "user" ? "user" : "system-message");

  switch (kind) {
    case "user":
      return {
        id,
        taskId,
        sender: "user",
        content: input.content,
        timestamp,
        kind: "user",
        scope: "task",
        taskTitle: "demo",
        targetAgentIds: input.targetAgentIds ?? [],
      };
    case "agent-final": {
      const message: MessageRecord = {
        id,
        taskId,
        sender: input.sender,
        content: input.content,
        timestamp,
        kind: "agent-final",
        status: input.agentFinalStatus ?? "completed",
        reviewDecision: input.reviewDecision ?? "complete",
        reviewOpinion: "",
        rawResponse: input.content,
        ...(input.senderDisplayName ? { senderDisplayName: input.senderDisplayName } : {}),
      };
      return message;
    }
    case "agent-dispatch": {
      const message: MessageRecord = {
        id,
        taskId,
        sender: input.sender,
        content: input.content,
        timestamp,
        kind: "agent-dispatch",
        targetAgentIds: input.targetAgentIds ?? [],
        dispatchDisplayContent: input.content,
        ...(input.senderDisplayName ? { senderDisplayName: input.senderDisplayName } : {}),
      };
      return message;
    }
    case "continue-request": {
      const message: MessageRecord = {
        id,
        taskId,
        sender: input.sender,
        content: input.content,
        timestamp,
        kind: "continue-request",
        targetAgentIds: input.targetAgentIds ?? [],
        ...(input.senderDisplayName ? { senderDisplayName: input.senderDisplayName } : {}),
      };
      return message;
    }
    case "task-completed":
      return {
        id,
        taskId,
        sender: "system",
        content: input.content,
        timestamp,
        kind: "task-completed",
        status: input.taskCompletedStatus ?? "finished",
      };
    case "task-created":
      return {
        id,
        taskId,
        sender: "system",
        content: input.content,
        timestamp,
        kind: "task-created",
      };
    case "orchestrator-waiting":
      return {
        id,
        taskId,
        sender: "system",
        content: input.content,
        timestamp,
        kind: "orchestrator-waiting",
      };
    case "system-message":
      return {
        id,
        taskId,
        sender: "system",
        content: input.content,
        timestamp,
        kind: "system-message",
      };
  }
}

function createAgent(input: Partial<TaskAgentRecord> & Pick<TaskAgentRecord, "id" | "status">): TaskAgentRecord {
  return {
    taskId: input.taskId ?? "task-1",
    id: input.id,
    opencodeSessionId: input.opencodeSessionId ?? null,
    opencodeAttachBaseUrl: input.opencodeAttachBaseUrl ?? null,
    status: input.status,
    runCount: input.runCount ?? 0,
  };
}

test("下游结构化 prompt 的 Initial Task 继续使用首条用户任务，而不是最新追问", () => {
  const messages = [
    createMessage({
      sender: "user",
      content: "@Build 初始任务：实现加法工具",
      targetAgentIds: ["Build"],
    }),
    createMessage({
      sender: "user",
      content: "@Build 追问：顺便补一份使用说明",
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

test("边配置为 none 时，下游只收到 continue，不再携带上游最后一条正文", () => {
  const messages = [
    createMessage({
      sender: "user",
      content: "@Build 初始任务：实现加法工具",
      targetAgentIds: ["Build"],
    }),
    createMessage({
      sender: "Build",
      content: "我已经写完加法工具，并补了测试。",
      kind: "agent-final",
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
  assert.equal(forwarded.agentMessage, "continue");
});

test("边配置为 all 时，下游会收到完整消息记录，并排除刚生成的派发展示消息", () => {
  const messages = [
    createMessage({
      sender: "user",
      content: "@Build 初始任务：实现加法工具",
      targetAgentIds: ["Build"],
    }),
    createMessage({
      sender: "Build",
      content: "我已经写完加法工具。",
      kind: "agent-final",
    }),
    createMessage({
      sender: "Build",
      content: "@CodeReview",
      kind: "agent-dispatch",
      targetAgentIds: ["CodeReview"],
    }),
    createMessage({
      sender: "CodeReview",
      content: "我认为还需要补边界值测试。",
      kind: "agent-final",
    }),
  ];

  const forwarded = buildDownstreamForwardedContextFromMessages(
    messages,
    "我认为还需要补边界值测试。",
    {
      messageMode: "all",
      includeInitialTask: true,
    },
  );

  assert.equal(forwarded.userMessage, undefined);
  assert.equal(
    forwarded.agentMessage,
    [
      "[user] 初始任务：实现加法工具",
      "[Build] 我已经写完加法工具。",
      "[CodeReview] 我认为还需要补边界值测试。",
    ].join("\n\n"),
  );
});

test("群聊消息保留寻址 @Agent，但下游转发读取时会去掉该寻址标记", () => {
  const storedUserContent = buildUserHistoryContent(
    "在当前项目的一个临时文件中实现一个加法工具，调用后传入a和b，返回c @BA",
    "BA",
  );
  const messages = [
    createMessage({
      sender: "user",
      content: storedUserContent,
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
    createMessage({
      sender: "user",
      content: "@Build 初始任务：实现加法工具",
      targetAgentIds: ["Build"],
    }),
    createMessage({
      sender: "TaskReview",
      content: "请补充实现依据。\n\n@Build",
      kind: "continue-request",
      targetAgentIds: ["Build"],
    }),
  ];

  assert.equal(getInitialUserMessageContent(messages), "初始任务：实现加法工具");
  assert.deepEqual(getPersistedCompletionSeedAgentIds({
    topology: createTopologyForTest({
      nodes: ["Build", "TaskReview"],
      edges: [{ source: "TaskReview", target: "Build", triggerOn: "continue" }],
    }),
    agents: [
      createAgent({ id: "Build", status: "idle" }),
      createAgent({ id: "TaskReview", status: "completed", runCount: 1 }),
    ],
    messages,
  }), ["TaskReview", "Build"]);
});

test("旧运行数据里悬空 idle Agent 不会阻止持久化补偿逻辑判定任务结束", () => {
  const topology = createTopologyForTest({
    nodes: ["BA", "Build", "CodeReview", "IntegrationTest", "TaskReview", "UnitTest"],
    edges: [
      { source: "BA", target: "Build", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "CodeReview", triggerOn: "transfer", messageMode: "last" },
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
    createMessage({
      sender: "Build",
      content: "所有参与的 Agent 都已完成。",
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
    createMessage({
      sender: "user",
      content: "@UnitTest 你的指责呢",
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
    nodes: ["初筛", "疑点辩论"],
    edges: [
      { source: "初筛", target: "疑点辩论", triggerOn: "transfer", messageMode: "last" },
    ],
  });
  const runtimeAgentId = "正方-1";
  const agents = [
    createAgent({ id: "初筛", status: "completed", runCount: 1 }),
    createAgent({ id: runtimeAgentId, status: "idle", runCount: 0 }),
  ];
  const messages = [
    createMessage({
      sender: "初筛",
      content: "初筛发现了一个可疑点。",
      kind: "agent-final",
    }),
    createMessage({
      sender: "初筛",
      content: `@${runtimeAgentId}`,
      timestamp: "2026-04-16T00:00:01.000Z",
      kind: "agent-dispatch",
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
    nodes: ["初筛", "疑点辩论"],
    edges: [
      { source: "初筛", target: "疑点辩论", triggerOn: "transfer", messageMode: "last" },
    ],
  });
  const runtimeAgentId = "正方-1";
  const agents = [
    createAgent({ id: "初筛", status: "completed", runCount: 1 }),
  ];
  const messages = [
    createMessage({
      sender: "初筛",
      content: "初筛发现了一个可疑点。",
      kind: "agent-final",
    }),
    createMessage({
      sender: "初筛",
      content: `@${runtimeAgentId}`,
      timestamp: "2026-04-16T00:00:01.000Z",
      kind: "agent-dispatch",
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

test("没有消息和运行痕迹时，持久化补偿逻辑只会把 Build 当默认入口 seed", () => {
  const topology = createTopologyForTest({
    nodes: ["BA", "Build", "TaskReview"],
    edges: [{ source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" }],
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

test("过期 reviewer 回复不应被当成有效回流继续触发修复", () => {
  const action = resolveActionRequiredRequestContinuationAction({
    continuation: null,
    fallbackActionWhenNoBatch: "ignore",
  });

  assert.equal(action, "ignore");
});

test("没有 batch continuation 但允许 direct fallback 时，会继续触发 fallback reviewer", () => {
  const action = resolveActionRequiredRequestContinuationAction({
    continuation: null,
    fallbackActionWhenNoBatch: "trigger_fallback_review",
  });

  assert.equal(action, "trigger_fallback_review");
});

test("reviewer 已经形成有效回流动作时，不应直接结束 Task", () => {
  const shouldStopTask = shouldStopTaskForUnhandledActionRequiredRequest({
    completeTaskOnFinish: true,
    continuationAction: "trigger_repair_review",
  });

  assert.equal(shouldStopTask, false);
});

test("reviewer 给出需要修复时应标记为 action_required 而不是 failed", () => {
  const status = resolveAgentStatusFromReview({
    reviewDecision: "continue",
    reviewAgent: true,
  });

  assert.equal(status, "continue");
});

test("reviewer 缺少强制标签时应标记为 failed", () => {
  const status = resolveAgentStatusFromReview({
    reviewDecision: "invalid",
    reviewAgent: true,
  });

  assert.equal(status, "failed");
});

test("非拓扑驱动的单次执行后，仍有未完成 Agent 时任务进入 waiting", () => {
  const status = resolveStandaloneTaskStatusAfterAgentRun({
    latestAgentStatus: "completed",
    agentStatuses: [
      createAgent({ id: "Build", status: "completed", runCount: 1 }),
      createAgent({ id: "QA", status: "idle", runCount: 0 }),
    ],
  });

  assert.equal(status, "waiting");
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
