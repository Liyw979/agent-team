import test from "node:test";
import assert from "node:assert/strict";

import { decideUiSnapshotRefreshAcceptance } from "./ui-snapshot-refresh-gate";

function createUiSnapshotPayload(input: {
  baStatus: "idle" | "running" | "completed";
  unitTestStatus: "idle" | "running" | "completed";
}) {
  return {
    workspace: null,
    launchTaskId: "task-1",
    launchCwd: "/Users/liyw/code/empty",
    task: {
      task: {
        id: "task-1",
        title: "demo",
        status: "running" as const,
        cwd: "/Users/liyw/code/empty",
        opencodeSessionId: null,
        agentCount: 2,
        createdAt: "2026-04-21T03:22:09.404Z",
        completedAt: null,
        initializedAt: "2026-04-21T03:22:11.615Z",
      },
      agents: [
        {
          id: "task-1:BA",
          taskId: "task-1",
          name: "BA",
          opencodeSessionId: null,
          opencodeAttachBaseUrl: null,
          status: input.baStatus,
          runCount: input.baStatus === "idle" ? 0 : 1,
        },
        {
          id: "task-1:UnitTest",
          taskId: "task-1",
          name: "UnitTest",
          opencodeSessionId: null,
          opencodeAttachBaseUrl: null,
          status: input.unitTestStatus,
          runCount: input.unitTestStatus === "idle" ? 0 : 1,
        },
      ],
      messages: [],
      topology: {
        nodes: ["BA", "UnitTest"],
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
    payload: newerPayload,
  });
  assert.equal(acceptedNewer.accepted, true);
  assert.equal(acceptedNewer.latestAcceptedRequestId, 2);
  assert.equal(acceptedNewer.payload?.task?.agents.find((agent) => agent.name === "UnitTest")?.status, "running");

  const rejectedOlder = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: acceptedNewer.latestAcceptedRequestId,
    requestId: 1,
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
    payload: firstPayload,
  });
  assert.equal(firstAccepted.accepted, true);
  assert.equal(firstAccepted.latestAcceptedRequestId, 1);

  const duplicatedRequest = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: firstAccepted.latestAcceptedRequestId,
    requestId: 1,
    payload: newerPayload,
  });
  assert.equal(duplicatedRequest.accepted, false);
  assert.equal(duplicatedRequest.latestAcceptedRequestId, 1);
  assert.equal(duplicatedRequest.payload, null);

  const newerAccepted = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: firstAccepted.latestAcceptedRequestId,
    requestId: 3,
    payload: newerPayload,
  });
  assert.equal(newerAccepted.accepted, true);
  assert.equal(newerAccepted.latestAcceptedRequestId, 3);
  assert.equal(newerAccepted.payload?.task?.agents.find((agent) => agent.name === "BA")?.status, "completed");
});
