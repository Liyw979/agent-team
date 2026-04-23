import test from "node:test";
import assert from "node:assert/strict";

import type { MessageRecord, TaskAgentRecord, TaskRecord } from "@shared/types";
import { reconcileTaskSnapshotFromMessages } from "./task-lifecycle-rules";

function createAgentFinalMessage(input: {
  id: string;
  sender: string;
  timestamp: string;
  content: string;
  reviewDecision?: "complete" | "continue" | "invalid";
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
    reviewDecision: input.reviewDecision ?? "complete",
    reviewOpinion: "",
    rawResponse: input.content,
  };
}

function createTaskCompletedMessage(input: {
  id: string;
  timestamp: string;
  content: string;
  status: "finished" | "failed";
}): MessageRecord {
  return {
    id: input.id,
    taskId: "task-1",
    sender: "system",
    timestamp: input.timestamp,
    content: input.content,
    kind: "task-completed",
    status: input.status,
  };
}

test("task-completed 与更晚的 agent-final 必须纠正滞后的 task/agent 状态", () => {
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
      id: "task-1:BA",
      taskId: "task-1",
      name: "BA",
      opencodeSessionId: null,
      opencodeAttachBaseUrl: null,
      status: "completed",
      runCount: 1,
    },
    {
      id: "task-1:Build",
      taskId: "task-1",
      name: "Build",
      opencodeSessionId: null,
      opencodeAttachBaseUrl: null,
      status: "completed",
      runCount: 4,
    },
    {
      id: "task-1:CodeReview",
      taskId: "task-1",
      name: "CodeReview",
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
    createTaskCompletedMessage({
      id: "message-2",
      timestamp: "2026-04-21T03:48:00.910Z",
      content: "所有Agent任务已完成",
      status: "finished",
    }),
  ];

  const reconciled = reconcileTaskSnapshotFromMessages({
    task,
    agents,
    messages,
  });

  assert.equal(reconciled.task.status, "finished");
  assert.equal(reconciled.task.completedAt, "2026-04-21T03:48:00.910Z");
  assert.equal(reconciled.agents.find((agent) => agent.name === "CodeReview")?.status, "completed");
});
