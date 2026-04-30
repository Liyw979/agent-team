import test from "node:test";
import assert from "node:assert/strict";

import {
  decideUiSnapshotRefreshAcceptance,
  isSemanticallyNewerUiSnapshot,
} from "./ui-snapshot-refresh-gate";
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
    runCount: 1,
    status: "completed",
    routingKind: "default",
    responseNote: "",
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

test("较小请求号若晚返回且语义上更新，门禁仍必须接受，避免并发刷新把群聊卡在旧快照", () => {
  const acceptedStaleHigherRequest = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: 0,
    requestId: 9,
    latestAcceptedPayload: null,
    payload: createUiSnapshotPayload({
      baStatus: "running",
      unitTestStatus: "idle",
      buildStatus: "idle",
      messageCount: 1,
    }),
  });
  assert.equal(acceptedStaleHigherRequest.accepted, true);

  const acceptedFreshLowerRequest = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: acceptedStaleHigherRequest.latestAcceptedRequestId,
    requestId: 8,
    latestAcceptedPayload: acceptedStaleHigherRequest.payload,
    payload: createUiSnapshotPayload({
      baStatus: "completed",
      unitTestStatus: "running",
      buildStatus: "idle",
      messageCount: 3,
    }),
  });

  assert.equal(acceptedFreshLowerRequest.accepted, true);
  assert.equal(acceptedFreshLowerRequest.latestAcceptedRequestId, 9);
  assert.equal(acceptedFreshLowerRequest.payload?.task?.messages.length, 3);
  assert.equal(
    acceptedFreshLowerRequest.payload?.task?.agents.find((agent) => agent.id === "UnitTest")?.status,
    "running",
  );
});

test("语义前进判定会把消息条数增加识别为更新，供事件追平停止条件复用", () => {
  const baselinePayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    buildStatus: "idle",
    messageCount: 1,
  });
  const newerPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    buildStatus: "idle",
    messageCount: 2,
  });

  assert.equal(isSemanticallyNewerUiSnapshot(baselinePayload, newerPayload), true);
  assert.equal(isSemanticallyNewerUiSnapshot(newerPayload, baselinePayload), false);
});

test("较小请求号若仅补齐 session 与 attach，也必须被视为语义更新并接受", () => {
  const higherRequestPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    messageCount: 2,
  });
  const acceptedHigherRequest = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: 0,
    requestId: 12,
    latestAcceptedPayload: null,
    payload: higherRequestPayload,
  });
  assert.equal(acceptedHigherRequest.accepted, true);

  const lowerRequestPayloadWithAttach = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    messageCount: 2,
  });
  const lowerRequestBaAgent = lowerRequestPayloadWithAttach.task?.agents.find((agent) => agent.id === "BA");
  assert.ok(lowerRequestBaAgent, "应存在 BA agent 测试夹具");
  lowerRequestBaAgent.opencodeSessionId = "session-ba-2";
  lowerRequestBaAgent.opencodeAttachBaseUrl = "http://localhost:4310";

  const acceptedLowerRequestWithAttach = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: acceptedHigherRequest.latestAcceptedRequestId,
    requestId: 11,
    latestAcceptedPayload: acceptedHigherRequest.payload,
    payload: lowerRequestPayloadWithAttach,
  });

  assert.equal(acceptedLowerRequestWithAttach.accepted, true);
  assert.equal(
    acceptedLowerRequestWithAttach.payload?.task?.agents.find((agent) => agent.id === "BA")?.opencodeSessionId,
    "session-ba-2",
  );
  assert.equal(
    acceptedLowerRequestWithAttach.payload?.task?.agents.find((agent) => agent.id === "BA")?.opencodeAttachBaseUrl,
    "http://localhost:4310",
  );
});

test("较小请求号若只把旧的非空 session 与 attach 换成另一组非空值，门禁必须拒绝，避免回退到不可证明更晚的连接状态", () => {
  const higherRequestPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    messageCount: 2,
  });
  const higherRequestBaAgent = higherRequestPayload.task?.agents.find((agent) => agent.id === "BA");
  assert.ok(higherRequestBaAgent, "应存在 BA agent 测试夹具");
  higherRequestBaAgent.opencodeSessionId = "session-ba-1";
  higherRequestBaAgent.opencodeAttachBaseUrl = "http://localhost:4310/old";

  const acceptedHigherRequest = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: 0,
    requestId: 14,
    latestAcceptedPayload: null,
    payload: higherRequestPayload,
  });
  assert.equal(acceptedHigherRequest.accepted, true);

  const lowerRequestPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    messageCount: 2,
  });
  const lowerRequestBaAgent = lowerRequestPayload.task?.agents.find((agent) => agent.id === "BA");
  assert.ok(lowerRequestBaAgent, "应存在 BA agent 测试夹具");
  lowerRequestBaAgent.opencodeSessionId = "session-ba-2";
  lowerRequestBaAgent.opencodeAttachBaseUrl = "http://localhost:4310/new";

  const rejectedLowerRequest = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: acceptedHigherRequest.latestAcceptedRequestId,
    requestId: 13,
    latestAcceptedPayload: acceptedHigherRequest.payload,
    payload: lowerRequestPayload,
  });

  assert.equal(rejectedLowerRequest.accepted, false);
  assert.equal(rejectedLowerRequest.payload, null);
});

test("较小请求号即使补齐了 attach，只要消息数发生回退也必须拒绝", () => {
  const higherRequestPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "running",
    messageCount: 3,
  });

  const acceptedHigherRequest = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: 0,
    requestId: 16,
    latestAcceptedPayload: null,
    payload: higherRequestPayload,
  });
  assert.equal(acceptedHigherRequest.accepted, true);

  const lowerRequestPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    messageCount: 2,
  });
  const lowerRequestBaAgent = lowerRequestPayload.task?.agents.find((agent) => agent.id === "BA");
  assert.ok(lowerRequestBaAgent, "应存在 BA agent 测试夹具");
  lowerRequestBaAgent.opencodeSessionId = "session-ba-2";
  lowerRequestBaAgent.opencodeAttachBaseUrl = "http://localhost:4310";

  const rejectedLowerRequest = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: acceptedHigherRequest.latestAcceptedRequestId,
    requestId: 15,
    latestAcceptedPayload: acceptedHigherRequest.payload,
    payload: lowerRequestPayload,
  });

  assert.equal(rejectedLowerRequest.accepted, false);
  assert.equal(rejectedLowerRequest.payload, null);
});

test("较小请求号若首次带回新的 runtime agent，也必须被视为语义前进并接受", () => {
  const higherRequestPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    messageCount: 1,
  });

  const acceptedHigherRequest = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: 0,
    requestId: 18,
    latestAcceptedPayload: null,
    payload: higherRequestPayload,
  });
  assert.equal(acceptedHigherRequest.accepted, true);

  const lowerRequestPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    messageCount: 1,
  });
  lowerRequestPayload.task?.agents.push({
    id: "漏洞挑战-2",
    taskId: "task-1",
    opencodeSessionId: "session-challenge-2",
    opencodeAttachBaseUrl: "http://localhost:4310",
    status: "running",
    runCount: 1,
  });

  const acceptedLowerRequest = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: acceptedHigherRequest.latestAcceptedRequestId,
    requestId: 17,
    latestAcceptedPayload: acceptedHigherRequest.payload,
    payload: lowerRequestPayload,
  });

  assert.equal(acceptedLowerRequest.accepted, true);
  assert.equal(
    acceptedLowerRequest.payload?.task?.agents.some((agent) => agent.id === "漏洞挑战-2"),
    true,
  );
});
