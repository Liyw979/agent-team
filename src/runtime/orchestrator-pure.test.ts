import assert from "node:assert/strict";
import { test } from "bun:test";

import type {
  AgentFinalMessageRecord,
  MessageRecord,
  TaskAgentRecord,
  TopologyEdgeTrigger,
  TopologyRecord,
} from "@shared/types";
import {
  buildTopologyNodeRecords,
  createTopologyFlowRecord,
  toUtcIsoTimestamp,
} from "@shared/types";

import { buildDownstreamForwardedContextFromMessages } from "./message-forwarding";
import { resolveAgentStatusFromRouting } from "./gating-rules";
import {
  getPersistedCompletionSeedAgentIds,
  resolveStandaloneTaskStatusAfterAgentRun,
  shouldFinishTaskFromPersistedState,
} from "./task-lifecycle-rules";

const TASK_ID = "task-1";
const TIMESTAMP = "2026-04-16T00:00:00.000Z";
const DEFAULT_TIMESTAMP = toUtcIsoTimestamp(TIMESTAMP);

function createTopology(input: {
  nodes: string[];
  edges: Array<{
    source: string;
    target: string;
    trigger: TopologyEdgeTrigger;
    messageMode: "last" | "none";
    maxTriggerRounds: number;
  }>;
}): TopologyRecord {
  const nodeIds = new Set<string>(input.nodes);
  input.edges.forEach((edge) => {
    nodeIds.add(edge.source);
    nodeIds.add(edge.target);
  });

  return {
    nodes: [...nodeIds],
    edges: input.edges.map((edge) => ({ ...edge })),
    flow: createTopologyFlowRecord({
      nodes: [...nodeIds],
      edges: input.edges.map((edge) => ({ ...edge })),
    }),
    nodeRecords: buildTopologyNodeRecords({
      nodes: [...nodeIds],
      groupNodeIds: new Set(),
      templateNameByNodeId: new Map(),
      initialMessageRoutingByNodeId: new Map(),
      groupRuleIdByNodeId: new Map(),
      groupEnabledNodeIds: new Set(),
      promptByNodeId: new Map(),
      writableNodeIds: new Set(),
    }),
  };
}

function createUserMessage(input: {
  content: string;
  targetAgentIds: string[];
}): MessageRecord {
  return {
    id: `user:${input.content}`,
    taskId: TASK_ID,
    sender: "user",
    content: input.content,
    timestamp: DEFAULT_TIMESTAMP,
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
  routingKind: "default" | "invalid";
}): AgentFinalMessageRecord {
  const base: Omit<AgentFinalMessageRecord, "routingKind" | "trigger"> = {
    id: `${input.sender}:${input.content}`,
    taskId: TASK_ID,
    sender: input.sender,
    content: input.content,
    timestamp: DEFAULT_TIMESTAMP,
    kind: "agent-final",
    runCount: 1,
    status: "completed",
    rawResponse: input.content,
  };
  return input.routingKind === "invalid"
    ? {
        ...base,
        routingKind: "invalid",
      } satisfies AgentFinalMessageRecord
    : {
        ...base,
        routingKind: "default",
      } satisfies AgentFinalMessageRecord;
}

function createAgentDispatchMessage(input: {
  sender: string;
  content: string;
  targetAgentIds: string[];
}): MessageRecord {
  return {
    id: `${input.sender}:${input.content}`,
    taskId: TASK_ID,
    sender: input.sender,
    content: input.content,
    timestamp: DEFAULT_TIMESTAMP,
    kind: "agent-dispatch",
    targetAgentIds: input.targetAgentIds,
    targetRunCounts: input.targetAgentIds.map(() => 1),
    dispatchDisplayContent: input.content,
  };
}

function createAgent(input: {
  id: string;
  status: TaskAgentRecord["status"];
  runCount: number;
}): TaskAgentRecord {
  return {
    taskId: TASK_ID,
    id: input.id,
    opencodeSessionId: `session:${input.id}`,
    opencodeAttachBaseUrl: "http://127.0.0.1:43127",
    status: input.status,
    runCount: input.runCount,
  };
}

const GLOBAL_ORDER = ["Build", "线索发现", "漏洞讨论", "误报论证", "漏洞论证", "线索完备性评估"];

test("messageMode=none 时不会默认转发 source 正文", () => {
  const forwarded = buildDownstreamForwardedContextFromMessages(
    [
      createUserMessage({
        content: "@Build 请实现",
        targetAgentIds: ["Build"],
      }),
      createAgentFinalMessage({
        sender: "Build",
        content: "Build 已实现。",
        routingKind: "default",
      }),
    ],
    "Build 已实现。",
    {
      messageMode: "none",
      initialMessageRouting: { mode: "inherit" },
      sourceAgentId: "Build",
      initialMessageSourceAliasesByAgentId: {},
      globalSourceOrder: GLOBAL_ORDER,
    },
  );

  assert.deepEqual(forwarded, { kind: "empty" });
});

test("initialMessage 会额外注入指定来源的最后一条可转发消息", () => {
  const forwarded = buildDownstreamForwardedContextFromMessages(
    [
      createAgentFinalMessage({
        sender: "线索发现",
        content: "线索发现确认了入口参数可控。",
        routingKind: "default",
      }),
    ],
    "漏洞讨论准备接手。",
    {
      messageMode: "last",
      initialMessageRouting: { mode: "list", agentIds: ["线索发现"] },
      sourceAgentId: "漏洞讨论",
      initialMessageSourceAliasesByAgentId: {
        "线索发现": ["线索发现"],
      },
      globalSourceOrder: GLOBAL_ORDER,
    },
  );

  assert.deepEqual(forwarded, {
    kind: "forwarded",
    agentMessage: [
      "[From 线索发现 Agent]",
      "线索发现确认了入口参数可控。",
      "",
      "[From 漏洞讨论 Agent]",
      "漏洞讨论准备接手。",
    ].join("\n"),
  });
});

test("initialMessage 缺少部分来源消息时，不会阻断已有来源与当前上游的转发", () => {
  const forwarded = buildDownstreamForwardedContextFromMessages(
    [
      createAgentFinalMessage({
        sender: "线索发现",
        content: "线索发现确认了入口参数可控。",
        routingKind: "default",
      }),
      createAgentFinalMessage({
        sender: "误报论证",
        content: "误报论证认为当前材料已经足够进入总结。",
        routingKind: "default",
      }),
    ],
    "误报论证认为当前材料已经足够进入总结。",
    {
      messageMode: "last",
      initialMessageRouting: { mode: "list", agentIds: ["线索发现", "误报论证", "漏洞论证"] },
      sourceAgentId: "误报论证",
      initialMessageSourceAliasesByAgentId: {
        "线索发现": ["线索发现"],
        "误报论证": ["误报论证"],
        "漏洞论证": ["漏洞论证"],
      },
      globalSourceOrder: GLOBAL_ORDER,
    },
  );

  assert.deepEqual(forwarded, {
    kind: "forwarded",
    agentMessage: [
      "[From 线索发现 Agent]",
      "线索发现确认了入口参数可控。",
      "",
      "[From 误报论证 Agent]",
      "误报论证认为当前材料已经足够进入总结。",
    ].join("\n"),
  });
});

test("resolveAgentStatusFromRouting 只区分 invalid 与非 invalid", () => {
  assert.equal(resolveAgentStatusFromRouting({ routingKind: "default" }), "completed");
  assert.equal(resolveAgentStatusFromRouting({ routingKind: "triggered" }), "completed");
  assert.equal(resolveAgentStatusFromRouting({ routingKind: "invalid" }), "failed");
});

test("单次执行在最新 agent 未失败时会结束为 finished", () => {
  assert.equal(
    resolveStandaloneTaskStatusAfterAgentRun({
      latestAgentStatus: "completed",
      agentStatuses: [
        createAgent({ id: "Build", status: "completed", runCount: 1 }),
        createAgent({ id: "QA", status: "idle", runCount: 0 }),
      ],
    }),
    "finished",
  );
});

test("单次执行在最新 agent 失败时会结束为 failed", () => {
  assert.equal(
    resolveStandaloneTaskStatusAfterAgentRun({
      latestAgentStatus: "failed",
      agentStatuses: [createAgent({ id: "Build", status: "failed", runCount: 1 })],
    }),
    "failed",
  );
});

test("持久化补偿会从 user 和 agent-dispatch 中提取 seed agents", () => {
  const seeds = getPersistedCompletionSeedAgentIds({
    topology: createTopology({
      nodes: ["Build", "TaskReview"],
      edges: [
        {
          source: "TaskReview",
          target: "Build",
          trigger: "<continue>",
          messageMode: "last",
          maxTriggerRounds: 4,
        },
      ],
    }),
    agents: [
      createAgent({ id: "Build", status: "idle", runCount: 0 }),
      createAgent({ id: "TaskReview", status: "completed", runCount: 1 }),
    ],
    messages: [
      createUserMessage({
        content: "@Build 请修复",
        targetAgentIds: ["Build"],
      }),
      createAgentDispatchMessage({
        sender: "TaskReview",
        content: "@Build",
        targetAgentIds: ["Build"],
      }),
    ],
  });

  assert.deepEqual(seeds, ["TaskReview", "Build"]);
});

test("最新消息是 user 时，持久化补偿不会提前结束任务", () => {
  const shouldFinish = shouldFinishTaskFromPersistedState({
    taskStatus: "running",
    topology: createTopology({
      nodes: ["UnitTest"],
      edges: [],
    }),
    agents: [createAgent({ id: "UnitTest", status: "completed", runCount: 1 })],
    messages: [
      createUserMessage({
        content: "@UnitTest 继续说明",
        targetAgentIds: ["UnitTest"],
      }),
    ],
  });

  assert.equal(shouldFinish, false);
});

test("最新消息是 agent-dispatch 时，持久化补偿不会提前结束任务", () => {
  const shouldFinish = shouldFinishTaskFromPersistedState({
    taskStatus: "running",
    topology: createTopology({
      nodes: ["Build", "CodeReview"],
      edges: [
        {
          source: "Build",
          target: "CodeReview",
          trigger: "<default>",
          messageMode: "last",
          maxTriggerRounds: 4,
        },
      ],
    }),
    agents: [
      createAgent({ id: "Build", status: "completed", runCount: 1 }),
      createAgent({ id: "CodeReview", status: "completed", runCount: 0 }),
    ],
    messages: [
      createAgentDispatchMessage({
        sender: "Build",
        content: "@CodeReview",
        targetAgentIds: ["CodeReview"],
      }),
    ],
  });

  assert.equal(shouldFinish, false);
});

test("所有参与 agent 已完成且不存在待派发消息时，持久化补偿会结束任务", () => {
  const shouldFinish = shouldFinishTaskFromPersistedState({
    taskStatus: "running",
    topology: createTopology({
      nodes: ["BA", "Build", "TaskReview"],
      edges: [
        {
          source: "BA",
          target: "Build",
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
      ],
    }),
    agents: [
      createAgent({ id: "BA", status: "completed", runCount: 1 }),
      createAgent({ id: "Build", status: "completed", runCount: 1 }),
      createAgent({ id: "TaskReview", status: "completed", runCount: 1 }),
    ],
    messages: [
      createAgentFinalMessage({
        sender: "TaskReview",
        content: "可以验收。",
        routingKind: "default",
      }),
    ],
  });

  assert.equal(shouldFinish, true);
});
