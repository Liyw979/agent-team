import test from "node:test";
import assert from "node:assert/strict";

import { decideUiSnapshotRefreshAcceptance } from "./ui-snapshot-refresh-gate";
import type { MessageRecord, UiSnapshotPayload } from "@shared/types";

function createSystemMessage(id: string, sender: "system" | "BA", content: string, timestamp: string): MessageRecord {
  if (sender === "system") {
    return {
      id,
      taskId: "task-1",
      sender: "system",
      content,
      timestamp,
      kind: "system-message",
    };
  }

  return {
    id,
    taskId: "task-1",
    sender: "BA",
    content,
    timestamp,
    kind: "agent-final",
    status: "completed",
    reviewDecision: "complete",
    reviewOpinion: "",
    rawResponse: content,
  };
}

function createUiSnapshotPayload(input: {
  baStatus: "idle" | "running" | "completed";
  unitTestStatus: "idle" | "running" | "completed";
  buildStatus?: "idle" | "running" | "completed";
  messageCount?: number;
  taskStatus?: "running" | "finished" | "failed";
  completedAt?: string | null;
  baRunCount?: number;
  unitTestRunCount?: number;
  buildRunCount?: number;
}): UiSnapshotPayload {
  const buildStatus = input.buildStatus ?? "idle";
  const messageCount = input.messageCount ?? 0;
  const baRunCount = input.baRunCount ?? (input.baStatus === "idle" ? 0 : 1);
  const unitTestRunCount = input.unitTestRunCount ?? (input.unitTestStatus === "idle" ? 0 : 1);
  const buildRunCount = input.buildRunCount ?? (buildStatus === "idle" ? 0 : 1);
  return {
    workspace: null,
    launchTaskId: "task-1",
    launchCwd: "/Users/liyw/code/empty",
    taskLogFilePath: "/Users/liyw/Library/Application Support/agent-team/logs/tasks/task-1.log",
    taskUrl: "http://localhost:4310/?taskId=task-1",
    task: {
      task: {
        id: "task-1",
        title: "demo",
        status: input.taskStatus ?? "running",
        cwd: "/Users/liyw/code/empty",
        opencodeSessionId: null,
        agentCount: 2,
        createdAt: "2026-04-21T03:22:09.404Z",
        completedAt: input.completedAt ?? null,
        initializedAt: "2026-04-21T03:22:11.615Z",
      },
      agents: [
        {
          taskId: "task-1",
          id: "BA",
          opencodeSessionId: null,
          opencodeAttachBaseUrl: null,
          status: input.baStatus,
          runCount: baRunCount,
        },
        {
          taskId: "task-1",
          id: "UnitTest",
          opencodeSessionId: null,
          opencodeAttachBaseUrl: null,
          status: input.unitTestStatus,
          runCount: unitTestRunCount,
        },
        {
          taskId: "task-1",
          id: "Build",
          opencodeSessionId: null,
          opencodeAttachBaseUrl: null,
          status: buildStatus,
          runCount: buildRunCount,
        },
      ],
      messages: Array.from({ length: messageCount }).map((value, index) => {
        void value;
        return createSystemMessage(
          `message-${index + 1}`,
          index === 0 ? "system" : "BA",
          `message-${index + 1}`,
          `2026-04-21T03:22:${String(index).padStart(2, "0")}.000Z`,
        );
      }),
      topology: {
        nodes: ["BA", "Build", "UnitTest"],
        edges: [],
      },
    },
  };
}

test("较新的 ui snapshot 响应一旦已被接受，较旧响应必须被拒绝，避免把 UnitTest 运行中回滚成 BA 运行中", () => {
  const newerPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "running",
  });
  const olderPayload = createUiSnapshotPayload({
    baStatus: "running",
    unitTestStatus: "idle",
  });

  const acceptedNewer = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: 0,
    requestId: 2,
    latestAcceptedPayload: null,
    payload: newerPayload,
  });
  assert.equal(acceptedNewer.accepted, true);
  assert.equal(acceptedNewer.latestAcceptedRequestId, 2);
  assert.equal(acceptedNewer.payload?.task?.agents.find((agent) => agent.id === "UnitTest")?.status, "running");

  const rejectedOlder = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: acceptedNewer.latestAcceptedRequestId,
    requestId: 1,
    latestAcceptedPayload: acceptedNewer.payload,
    payload: olderPayload,
  });
  assert.equal(rejectedOlder.accepted, false);
  assert.equal(rejectedOlder.latestAcceptedRequestId, 2);
  assert.equal(rejectedOlder.payload, null);
});

test("ui snapshot 门禁允许首次响应和更大请求号通过，但拒绝相同请求号重复回写", () => {
  const firstPayload = createUiSnapshotPayload({
    baStatus: "running",
    unitTestStatus: "idle",
  });
  const newerPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "running",
  });

  const firstAccepted = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: 0,
    requestId: 1,
    latestAcceptedPayload: null,
    payload: firstPayload,
  });
  assert.equal(firstAccepted.accepted, true);
  assert.equal(firstAccepted.latestAcceptedRequestId, 1);

  const duplicatedRequest = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: firstAccepted.latestAcceptedRequestId,
    requestId: 1,
    latestAcceptedPayload: firstAccepted.payload,
    payload: newerPayload,
  });
  assert.equal(duplicatedRequest.accepted, false);
  assert.equal(duplicatedRequest.latestAcceptedRequestId, 1);
  assert.equal(duplicatedRequest.payload, null);

  const newerAccepted = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: firstAccepted.latestAcceptedRequestId,
    requestId: 3,
    latestAcceptedPayload: firstAccepted.payload,
    payload: newerPayload,
  });
  assert.equal(newerAccepted.accepted, true);
  assert.equal(newerAccepted.latestAcceptedRequestId, 3);
  assert.equal(newerAccepted.payload?.task?.agents.find((agent) => agent.id === "BA")?.status, "completed");
});

test("较大的请求号若带回更旧的任务快照，必须被拒绝，避免把 BA 已完成和 Build 已启动回滚成旧画面", () => {
  const acceptedFresh = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: 0,
    requestId: 4,
    latestAcceptedPayload: null,
    payload: createUiSnapshotPayload({
      baStatus: "completed",
      buildStatus: "running",
      unitTestStatus: "idle",
      messageCount: 3,
    }),
  });
  assert.equal(acceptedFresh.accepted, true);

  const rejectedSemanticallyOlder = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: acceptedFresh.latestAcceptedRequestId,
    requestId: 5,
    latestAcceptedPayload: acceptedFresh.payload,
    payload: createUiSnapshotPayload({
      baStatus: "running",
      buildStatus: "idle",
      unitTestStatus: "idle",
      messageCount: 2,
    }),
  });
  assert.equal(rejectedSemanticallyOlder.accepted, false);
  assert.equal(rejectedSemanticallyOlder.latestAcceptedRequestId, acceptedFresh.latestAcceptedRequestId);
  assert.equal(rejectedSemanticallyOlder.payload, null);
});

test("较新的请求号把任务从 finished 重新带回 running 时，门禁必须接受这次合法 reopen", () => {
  const acceptedFinished = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: 0,
    requestId: 7,
    latestAcceptedPayload: null,
    payload: createUiSnapshotPayload({
      baStatus: "completed",
      unitTestStatus: "idle",
      taskStatus: "finished",
      completedAt: "2026-04-21T03:22:20.000Z",
      messageCount: 2,
    }),
  });
  assert.equal(acceptedFinished.accepted, true);

  const reopenedRunning = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: acceptedFinished.latestAcceptedRequestId,
    requestId: 8,
    latestAcceptedPayload: acceptedFinished.payload,
    payload: createUiSnapshotPayload({
      baStatus: "running",
      unitTestStatus: "idle",
      taskStatus: "running",
      completedAt: null,
      messageCount: 3,
      baRunCount: 2,
    }),
  });

  assert.equal(reopenedRunning.accepted, true);
  assert.equal(reopenedRunning.payload?.task?.task.status, "running");
});
