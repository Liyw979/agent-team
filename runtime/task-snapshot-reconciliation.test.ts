import test from "node:test";
import assert from "node:assert/strict";

import type { MessageRecord, TaskAgentRecord, TaskRecord } from "@shared/types";
import { reconcileTaskSnapshotFromMessages } from "./task-lifecycle-rules";

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
    {
      id: "message-1",
      taskId: "task-1",
      sender: "CodeReview",
      timestamp: "2026-04-21T03:48:00.819Z",
      content: "<approved>通过</approved>",
      meta: {
        kind: "agent-final",
        status: "completed",
        reviewDecision: "approved",
        finalMessage: "通过",
      },
    },
    {
      id: "message-2",
      taskId: "task-1",
      sender: "system",
      timestamp: "2026-04-21T03:48:00.910Z",
      content: "所有Agent任务已完成",
      meta: {
        kind: "task-completed",
        status: "finished",
      },
    },
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
