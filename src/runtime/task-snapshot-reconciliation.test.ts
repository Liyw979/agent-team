import test from "node:test";
import assert from "node:assert/strict";

import type { MessageRecord, TaskAgentRecord, TaskRecord } from "@shared/types";
import { reconcileTaskSnapshotFromMessages } from "./task-lifecycle-rules";

function createAgentFinalMessage(input: {
  id: string;
  sender: string;
  timestamp: string;
  content: string;
  decision?: "complete" | "continue" | "invalid";
  status?: "completed" | "error";
}): MessageRecord {
  return {
    id: input.id,
    taskId: "task-1",
    sender: input.sender,
    timestamp: input.timestamp,
    content: input.content,
    kind: "agent-final",
    status: input.status ?? "completed",
    decision: input.decision ?? "complete",
    decisionNote: "",
    rawResponse: input.content,
  };
}

function createTaskRoundFinishedMessage(input: {
  id: string;
  timestamp: string;
  content: string;
}): MessageRecord {
  return {
    id: input.id,
    taskId: "task-1",
    sender: "system",
    timestamp: input.timestamp,
    content: input.content,
    kind: "task-round-finished",
    finishReason: "round_finished",
  };
}

test("task-round-finished 与更晚的 agent-final 必须纠正滞后的 task/agent 状态", () => {
  const task: TaskRecord = {
    id: "task-1",
    title: "demo",
    status: "running",
    cwd: "/Users/liyw/code/empty",
    opencodeSessionId: null,
    agentCount: 3,
    createdAt: "2026-04-21T03:45:04.435Z",
    completedAt: null,
    initializedAt: "2026-04-21T03:45:08.563Z",
  };
  const agents: TaskAgentRecord[] = [
    {
          taskId: "task-1",
      id: "BA",
      opencodeSessionId: null,
      opencodeAttachBaseUrl: null,
      status: "completed",
      runCount: 1,
    },
    {
          taskId: "task-1",
      id: "Build",
      opencodeSessionId: null,
      opencodeAttachBaseUrl: null,
      status: "completed",
      runCount: 4,
    },
    {
          taskId: "task-1",
      id: "CodeReview",
      opencodeSessionId: null,
      opencodeAttachBaseUrl: null,
      status: "running",
      runCount: 4,
    },
  ];
  const messages: MessageRecord[] = [
    createAgentFinalMessage({
      id: "message-1",
      sender: "CodeReview",
      timestamp: "2026-04-21T03:48:00.819Z",
      content: "<complete>通过</complete>",
    }),
    createTaskRoundFinishedMessage({
      id: "message-2",
      timestamp: "2026-04-21T03:48:00.910Z",
      content: "本轮已完成，可继续 @Agent 发起下一轮。",
    }),
  ];

  const reconciled = reconcileTaskSnapshotFromMessages({
    task,
    agents,
    messages,
  });

  assert.equal(reconciled.task.status, "finished");
  assert.equal(reconciled.task.completedAt, "2026-04-21T03:48:00.910Z");
  assert.equal(reconciled.agents.find((agent) => agent.id === "CodeReview")?.status, "completed");
});

test("旧的 task-round-finished 后面出现新的用户消息时，补偿逻辑不能把 reopen 中的任务误判回 finished", () => {
  const task: TaskRecord = {
    id: "task-1",
    title: "demo",
    status: "running",
    cwd: "/Users/liyw/code/empty",
    opencodeSessionId: null,
    agentCount: 1,
    createdAt: "2026-04-21T03:45:04.435Z",
    completedAt: null,
    initializedAt: "2026-04-21T03:45:08.563Z",
  };
  const agents: TaskAgentRecord[] = [
    {
      taskId: "task-1",
      id: "BA",
      opencodeSessionId: null,
      opencodeAttachBaseUrl: null,
      status: "running",
      runCount: 2,
    },
  ];
  const messages: MessageRecord[] = [
    createTaskRoundFinishedMessage({
      id: "message-1",
      timestamp: "2026-04-21T03:48:00.910Z",
      content: "本轮已完成，可继续 @Agent 发起下一轮。",
    }),
    {
      id: "message-2",
      taskId: "task-1",
      sender: "user",
      timestamp: "2026-04-21T03:49:00.000Z",
      content: "@BA 请继续第二轮",
      kind: "user",
      scope: "task",
      taskTitle: "demo",
      targetAgentIds: ["BA"],
    },
  ];

  const reconciled = reconcileTaskSnapshotFromMessages({
    task,
    agents,
    messages,
  });

  assert.equal(reconciled.task.status, "running");
  assert.equal(reconciled.task.completedAt, null);
});

test("reconcileTaskSnapshotFromMessages 在 agents 缺失时不会抛出 input.agents.map", () => {
  const task: TaskRecord = {
    id: "task-1",
    title: "demo",
    status: "running",
    cwd: "/Users/liyw/code/empty",
    opencodeSessionId: null,
    agentCount: 0,
    createdAt: "2026-04-24T00:00:00.000Z",
    completedAt: null,
    initializedAt: "2026-04-24T00:00:00.000Z",
  };

  assert.doesNotThrow(() =>
    reconcileTaskSnapshotFromMessages({
      task,
      agents: undefined as unknown as TaskAgentRecord[],
      messages: [],
    }),
  );
});
