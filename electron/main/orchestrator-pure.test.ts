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
  shouldFinishTaskFromPersistedState,
} from "./orchestrator-pure";

function createTopologyForTest(input: {
  projectId: string;
  startAgentId: string | null;
  nodes: string[];
  edges: Array<{ source: string; target: string; triggerOn: TopologyEdgeTrigger }>;
}): TopologyRecord {
  const nodeIds = new Set<string>();
  for (const agentId of input.nodes) {
    nodeIds.add(agentId);
  }
  if (input.startAgentId) {
    nodeIds.add(input.startAgentId);
  }
  for (const edge of input.edges) {
    nodeIds.add(edge.source);
    nodeIds.add(edge.target);
  }

  return {
    projectId: input.projectId,
    startAgentId: input.startAgentId,
    nodes: [...nodeIds],
    edges: input.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      triggerOn: edge.triggerOn,
    })),
  };
}

function createMessage(input: Partial<MessageRecord> & Pick<MessageRecord, "sender" | "content">): MessageRecord {
  return {
    id: input.id ?? `${input.sender}:${input.content}`,
    projectId: input.projectId ?? "project-1",
    taskId: input.taskId ?? "task-1",
    sender: input.sender,
    content: input.content,
    timestamp: input.timestamp ?? "2026-04-16T00:00:00.000Z",
    meta: input.meta,
  };
}

function createAgent(input: Partial<TaskAgentRecord> & Pick<TaskAgentRecord, "name" | "status">): TaskAgentRecord {
  return {
    id: input.id ?? `agent:${input.name}`,
    taskId: input.taskId ?? "task-1",
    projectId: input.projectId ?? "project-1",
    name: input.name,
    opencodeSessionId: input.opencodeSessionId ?? null,
    status: input.status,
    runCount: input.runCount ?? 0,
  };
}

test("下游结构化 prompt 的 Initial Task 继续使用首条用户任务，而不是最新追问", () => {
  const messages = [
    createMessage({
      sender: "user",
      content: "@Build 初始任务：实现加法工具",
      meta: {
        scope: "task",
        taskTitle: "demo",
        targetAgentId: "Build",
      },
    }),
    createMessage({
      sender: "user",
      content: "@Build 追问：顺便补一份使用说明",
      meta: {
        scope: "task",
        taskTitle: "demo",
        targetAgentId: "Build",
      },
    }),
  ];

  const forwarded = buildDownstreamForwardedContextFromMessages(
    messages,
    "Build 已完成实现，等待下游继续处理。",
  );

  assert.equal(forwarded.userMessage, "初始任务：实现加法工具");
  assert.equal(forwarded.agentMessage, "Build 已完成实现，等待下游继续处理。");
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
      meta: {
        scope: "task",
        taskTitle: "demo",
        targetAgentId: "BA",
      },
    }),
  ];

  const forwardedUserContent = getInitialUserMessageContent(messages);

  assert.equal(messages[0]?.content.includes("@BA"), true);
  assert.equal(forwardedUserContent.includes("@BA"), false);
  assert.equal(forwardedUserContent.includes("返回c"), true);
});

test("旧运行数据里悬空 idle Agent 不会阻止持久化补偿逻辑判定任务结束", () => {
  const topology = createTopologyForTest({
    projectId: "project-1",
    startAgentId: "BA",
    nodes: ["BA", "Build", "CodeReview", "IntegrationTest", "TaskReview", "UnitTest"],
    edges: [
      { source: "BA", target: "Build", triggerOn: "association" },
      { source: "Build", target: "UnitTest", triggerOn: "association" },
      { source: "Build", target: "TaskReview", triggerOn: "association" },
      { source: "Build", target: "CodeReview", triggerOn: "association" },
    ],
  });
  const agents = [
    createAgent({ name: "BA", status: "completed", runCount: 1 }),
    createAgent({ name: "Build", status: "completed", runCount: 1 }),
    createAgent({ name: "UnitTest", status: "completed", runCount: 1 }),
    createAgent({ name: "TaskReview", status: "completed", runCount: 1 }),
    createAgent({ name: "CodeReview", status: "completed", runCount: 1 }),
    createAgent({ name: "IntegrationTest", status: "idle", runCount: 0 }),
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
    projectId: "project-1",
    startAgentId: "UnitTest",
    nodes: ["UnitTest"],
    edges: [],
  });
  const agents = [
    createAgent({ name: "UnitTest", status: "completed", runCount: 1 }),
  ];
  const messages = [
    createMessage({
      sender: "user",
      content: "@UnitTest 你的指责呢",
      meta: {
        scope: "task",
        taskTitle: "demo",
        targetAgentId: "UnitTest",
      },
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
