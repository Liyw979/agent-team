import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  decideUiSnapshotRefreshAcceptance,
  INITIAL_LATEST_ACCEPTED_UI_SNAPSHOT_STATE,
  isSemanticallyNewerUiSnapshot,
  isSemanticallyOlderUiSnapshot,
  resolveUiSnapshotQueryData,
  type LatestAcceptedUiSnapshotState,
} from "./ui-snapshot-refresh-gate";
import {
  buildTopologyNodeRecords,
  createTopologyFlowRecord,
  type MessageRecord,
  type TaskAgentRecord,
  toUtcIsoTimestamp,
  type UiSnapshotPayload,
} from "@shared/types";

function createSystemMessage(id: string, sender: "system" | "BA", content: string, timestamp: string): MessageRecord {
  if (sender === "system") {
    return {
      id,
      taskId: "task-1",
      sender: "system",
      content,
      timestamp: toUtcIsoTimestamp(timestamp),
      kind: "system-message",
    };
  }

  return {
    id,
    taskId: "task-1",
    sender: "BA",
    content,
    timestamp: toUtcIsoTimestamp(timestamp),
    kind: "agent-final",
    runCount: 1,
    status: "completed",
    routingKind: "default",
    responseNote: "",
    rawResponse: content,
  };
}

function readAcceptedPayload(state: LatestAcceptedUiSnapshotState): UiSnapshotPayload {
  assert.equal(state.kind, "accepted");
  return state.payload;
}

function requireTaskAgent(payload: UiSnapshotPayload, agentId: string): TaskAgentRecord {
  const agent = payload.task?.agents.find((item) => item.id === agentId);
  assert.ok(agent, `应存在 ${agentId} agent 测试夹具`);
  return agent;
}

function createUiSnapshotPayload(input: {
  baStatus: "idle" | "running" | "completed";
  unitTestStatus: "idle" | "running" | "completed";
  buildStatus?: "idle" | "running" | "completed";
  messageCount?: number;
  taskStatus?: "running" | "finished" | "failed";
  completedAt: string;
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
    launchCwd: "/Users/liyw/code/empty",
    taskLogFilePath: "/Users/liyw/Library/Application Support/agent-team/logs/tasks/task-1.log",
    taskUrl: "http://localhost:4310/",
    task: {
      task: {
        id: "task-1",
        title: "demo",
        status: input.taskStatus ?? "running",
        cwd: "/Users/liyw/code/empty",
        agentCount: 3,
        createdAt: "2026-04-21T03:22:09.404Z",
        completedAt: input.completedAt,
        initializedAt: "2026-04-21T03:22:11.615Z",
      },
      agents: [
        {
          taskId: "task-1",
          id: "BA",
          opencodeSessionId: "",
          opencodeAttachBaseUrl: "",
          status: input.baStatus,
          runCount: baRunCount,
        },
        {
          taskId: "task-1",
          id: "UnitTest",
          opencodeSessionId: "",
          opencodeAttachBaseUrl: "",
          status: input.unitTestStatus,
          runCount: unitTestRunCount,
        },
        {
          taskId: "task-1",
          id: "Build",
          opencodeSessionId: "",
          opencodeAttachBaseUrl: "",
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
        flow: createTopologyFlowRecord({
          nodes: ["BA", "Build", "UnitTest"],
          edges: [],
        }),
        nodeRecords: buildTopologyNodeRecords({
          nodes: ["BA", "Build", "UnitTest"],
          groupNodeIds: new Set(),
          templateNameByNodeId: new Map(),
          initialMessageRoutingByNodeId: new Map(),
          groupRuleIdByNodeId: new Map(),
          groupEnabledNodeIds: new Set(),
          promptByNodeId: new Map(),
          writableNodeIds: new Set(),
        }),
      },
    },
  };
}

test("较新的 ui snapshot 响应一旦已被接受，较旧响应必须被拒绝", () => {
  const newerPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "running",
    completedAt: "",
  });
  const olderPayload = createUiSnapshotPayload({
    baStatus: "running",
    unitTestStatus: "idle",
    completedAt: "",
  });

  const acceptedNewer = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: 0,
    requestId: 2,
    latestAcceptedState: INITIAL_LATEST_ACCEPTED_UI_SNAPSHOT_STATE,
    payload: newerPayload,
  });
  assert.equal(acceptedNewer.accepted, true);
  assert.equal(acceptedNewer.latestAcceptedRequestId, 2);
  assert.equal(readAcceptedPayload(acceptedNewer.latestAcceptedState).task?.agents.find((agent) => agent.id === "UnitTest")?.status, "running");

  const rejectedOlder = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: acceptedNewer.latestAcceptedRequestId,
    requestId: 1,
    latestAcceptedState: acceptedNewer.latestAcceptedState,
    payload: olderPayload,
  });
  assert.equal(rejectedOlder.accepted, false);
  assert.equal(rejectedOlder.latestAcceptedRequestId, 2);
});

test("ui snapshot 门禁允许首次响应和更大请求号通过，但拒绝相同请求号重复回写", () => {
  const firstPayload = createUiSnapshotPayload({
    baStatus: "running",
    unitTestStatus: "idle",
    completedAt: "",
  });
  const newerPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "running",
    completedAt: "",
  });

  const firstAccepted = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: 0,
    requestId: 1,
    latestAcceptedState: INITIAL_LATEST_ACCEPTED_UI_SNAPSHOT_STATE,
    payload: firstPayload,
  });
  assert.equal(firstAccepted.accepted, true);

  const duplicatedRequest = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: firstAccepted.latestAcceptedRequestId,
    requestId: 1,
    latestAcceptedState: firstAccepted.latestAcceptedState,
    payload: newerPayload,
  });
  assert.equal(duplicatedRequest.accepted, false);

  const newerAccepted = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: firstAccepted.latestAcceptedRequestId,
    requestId: 3,
    latestAcceptedState: firstAccepted.latestAcceptedState,
    payload: newerPayload,
  });
  assert.equal(newerAccepted.accepted, true);
  assert.equal(readAcceptedPayload(newerAccepted.latestAcceptedState).task?.agents.find((agent) => agent.id === "BA")?.status, "completed");
});

test("较大的请求号若带回更旧的任务快照，必须被拒绝", () => {
  const acceptedFresh = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: 0,
    requestId: 4,
    latestAcceptedState: INITIAL_LATEST_ACCEPTED_UI_SNAPSHOT_STATE,
    payload: createUiSnapshotPayload({
      baStatus: "completed",
      buildStatus: "running",
      unitTestStatus: "idle",
      completedAt: "",
      messageCount: 3,
    }),
  });
  assert.equal(acceptedFresh.accepted, true);

  const rejectedSemanticallyOlder = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: acceptedFresh.latestAcceptedRequestId,
    requestId: 5,
    latestAcceptedState: acceptedFresh.latestAcceptedState,
    payload: createUiSnapshotPayload({
      baStatus: "running",
      buildStatus: "idle",
      unitTestStatus: "idle",
      completedAt: "",
      messageCount: 2,
    }),
  });
  assert.equal(rejectedSemanticallyOlder.accepted, false);
});

test("较新的请求号把任务从 finished 重新带回 running 时，门禁必须接受这次合法 reopen", () => {
  const acceptedFinished = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: 0,
    requestId: 7,
    latestAcceptedState: INITIAL_LATEST_ACCEPTED_UI_SNAPSHOT_STATE,
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
    latestAcceptedState: acceptedFinished.latestAcceptedState,
    payload: createUiSnapshotPayload({
      baStatus: "running",
      unitTestStatus: "idle",
      taskStatus: "running",
      completedAt: "",
      messageCount: 3,
      baRunCount: 2,
    }),
  });

  assert.equal(reopenedRunning.accepted, true);
  assert.equal(readAcceptedPayload(reopenedRunning.latestAcceptedState).task?.task.status, "running");
});

test("较小请求号若晚返回且语义上更新，门禁仍必须接受", () => {
  const acceptedHigherRequest = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: 0,
    requestId: 9,
    latestAcceptedState: INITIAL_LATEST_ACCEPTED_UI_SNAPSHOT_STATE,
    payload: createUiSnapshotPayload({
      baStatus: "running",
      unitTestStatus: "idle",
      buildStatus: "idle",
      completedAt: "",
      messageCount: 1,
    }),
  });
  assert.equal(acceptedHigherRequest.accepted, true);

  const acceptedLowerRequest = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: acceptedHigherRequest.latestAcceptedRequestId,
    requestId: 8,
    latestAcceptedState: acceptedHigherRequest.latestAcceptedState,
    payload: createUiSnapshotPayload({
      baStatus: "completed",
      unitTestStatus: "running",
      buildStatus: "idle",
      completedAt: "",
      messageCount: 3,
    }),
  });

  assert.equal(acceptedLowerRequest.accepted, true);
  assert.equal(acceptedLowerRequest.latestAcceptedRequestId, 9);
  assert.equal(readAcceptedPayload(acceptedLowerRequest.latestAcceptedState).task?.messages.length, 3);
});

test("语义前进判定会把消息条数增加识别为更新", () => {
  const baselinePayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    buildStatus: "idle",
    completedAt: "",
    messageCount: 1,
  });
  const newerPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    buildStatus: "idle",
    completedAt: "",
    messageCount: 2,
  });

  assert.equal(isSemanticallyNewerUiSnapshot(baselinePayload, newerPayload), true);
  assert.equal(isSemanticallyNewerUiSnapshot(newerPayload, baselinePayload), false);
});

test("较小请求号若仅补齐 session 与 attach，也必须被视为语义更新并接受", () => {
  const higherRequestPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    completedAt: "",
    messageCount: 2,
  });
  const acceptedHigherRequest = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: 0,
    requestId: 12,
    latestAcceptedState: INITIAL_LATEST_ACCEPTED_UI_SNAPSHOT_STATE,
    payload: higherRequestPayload,
  });
  assert.equal(acceptedHigherRequest.accepted, true);

  const lowerRequestPayloadWithAttach = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    completedAt: "",
    messageCount: 2,
  });
  const lowerRequestBaAgent = requireTaskAgent(lowerRequestPayloadWithAttach, "BA");
  lowerRequestBaAgent.opencodeSessionId = "session-ba-2";
  lowerRequestBaAgent.opencodeAttachBaseUrl = "http://localhost:4310";

  const acceptedLowerRequestWithAttach = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: acceptedHigherRequest.latestAcceptedRequestId,
    requestId: 11,
    latestAcceptedState: acceptedHigherRequest.latestAcceptedState,
    payload: lowerRequestPayloadWithAttach,
  });

  assert.equal(acceptedLowerRequestWithAttach.accepted, true);
  assert.equal(
    requireTaskAgent(readAcceptedPayload(acceptedLowerRequestWithAttach.latestAcceptedState), "BA").opencodeSessionId,
    "session-ba-2",
  );
});

test("较小请求号若只把旧的非空 session 与 attach 换成另一组非空值，门禁必须拒绝", () => {
  const higherRequestPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    completedAt: "",
    messageCount: 2,
  });
  const higherRequestBaAgent = requireTaskAgent(higherRequestPayload, "BA");
  higherRequestBaAgent.opencodeSessionId = "session-ba-1";
  higherRequestBaAgent.opencodeAttachBaseUrl = "http://localhost:4310/old";

  const acceptedHigherRequest = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: 0,
    requestId: 14,
    latestAcceptedState: INITIAL_LATEST_ACCEPTED_UI_SNAPSHOT_STATE,
    payload: higherRequestPayload,
  });
  assert.equal(acceptedHigherRequest.accepted, true);

  const lowerRequestPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    completedAt: "",
    messageCount: 2,
  });
  const lowerRequestBaAgent = requireTaskAgent(lowerRequestPayload, "BA");
  lowerRequestBaAgent.opencodeSessionId = "session-ba-2";
  lowerRequestBaAgent.opencodeAttachBaseUrl = "http://localhost:4310/new";

  const rejectedLowerRequest = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: acceptedHigherRequest.latestAcceptedRequestId,
    requestId: 13,
    latestAcceptedState: acceptedHigherRequest.latestAcceptedState,
    payload: lowerRequestPayload,
  });

  assert.equal(rejectedLowerRequest.accepted, false);
});

test("较小请求号即使补齐了 attach，只要消息数发生回退也必须拒绝", () => {
  const acceptedHigherRequest = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: 0,
    requestId: 16,
    latestAcceptedState: INITIAL_LATEST_ACCEPTED_UI_SNAPSHOT_STATE,
    payload: createUiSnapshotPayload({
      baStatus: "completed",
      unitTestStatus: "running",
      completedAt: "",
      messageCount: 3,
    }),
  });
  assert.equal(acceptedHigherRequest.accepted, true);

  const lowerRequestPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    completedAt: "",
    messageCount: 2,
  });
  const lowerRequestBaAgent = requireTaskAgent(lowerRequestPayload, "BA");
  lowerRequestBaAgent.opencodeSessionId = "session-ba-2";
  lowerRequestBaAgent.opencodeAttachBaseUrl = "http://localhost:4310";

  const rejectedLowerRequest = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: acceptedHigherRequest.latestAcceptedRequestId,
    requestId: 15,
    latestAcceptedState: acceptedHigherRequest.latestAcceptedState,
    payload: lowerRequestPayload,
  });

  assert.equal(rejectedLowerRequest.accepted, false);
});

test("较小请求号若首次带回新的 runtime agent，也必须被视为语义前进并接受", () => {
  const acceptedHigherRequest = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: 0,
    requestId: 18,
    latestAcceptedState: INITIAL_LATEST_ACCEPTED_UI_SNAPSHOT_STATE,
    payload: createUiSnapshotPayload({
      baStatus: "completed",
      unitTestStatus: "idle",
      completedAt: "",
      messageCount: 1,
    }),
  });
  assert.equal(acceptedHigherRequest.accepted, true);

  const lowerRequestPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    completedAt: "",
    messageCount: 1,
  });
  lowerRequestPayload.task?.agents.push({
    id: "误报论证-2",
    taskId: "task-1",
    opencodeSessionId: "session-challenge-2",
    opencodeAttachBaseUrl: "http://localhost:4310",
    status: "running",
    runCount: 1,
  });

  const acceptedLowerRequest = decideUiSnapshotRefreshAcceptance({
    latestAcceptedRequestId: acceptedHigherRequest.latestAcceptedRequestId,
    requestId: 17,
    latestAcceptedState: acceptedHigherRequest.latestAcceptedState,
    payload: lowerRequestPayload,
  });

  assert.equal(acceptedLowerRequest.accepted, true);
  assert.equal(
    readAcceptedPayload(acceptedLowerRequest.latestAcceptedState).task?.agents.some((agent) => agent.id === "误报论证-2"),
    true,
  );
});

test("语义更旧的 ui snapshot 必须被识别出来", () => {
  const newerPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "running",
    completedAt: "",
  });
  const olderPayload = createUiSnapshotPayload({
    baStatus: "running",
    unitTestStatus: "idle",
    completedAt: "",
  });

  assert.equal(isSemanticallyOlderUiSnapshot(newerPayload, olderPayload), true);
});

test("缓存里已有较新 snapshot 时，语义更旧的结果必须被拒绝", () => {
  const acceptedFresh = createUiSnapshotPayload({
    baStatus: "completed",
    buildStatus: "running",
    unitTestStatus: "idle",
    completedAt: "",
    messageCount: 3,
  });
  const olderPayload = createUiSnapshotPayload({
    baStatus: "running",
    buildStatus: "idle",
    unitTestStatus: "idle",
    completedAt: "",
    messageCount: 2,
  });

  assert.equal(resolveUiSnapshotQueryData(acceptedFresh, olderPayload), acceptedFresh);
});

test("合法 reopen 的 running snapshot 仍然应当被接受", () => {
  const finishedPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    taskStatus: "finished",
    completedAt: "2026-04-21T03:22:20.000Z",
    messageCount: 2,
  });
  const reopenedRunning = createUiSnapshotPayload({
    baStatus: "running",
    unitTestStatus: "idle",
    taskStatus: "running",
    completedAt: "",
    messageCount: 3,
    baRunCount: 2,
  });

  assert.equal(isSemanticallyOlderUiSnapshot(finishedPayload, reopenedRunning), false);
  assert.equal(resolveUiSnapshotQueryData(finishedPayload, reopenedRunning), reopenedRunning);
});

test("语义上更新的 snapshot 必须覆盖旧缓存", () => {
  const previousPayload = createUiSnapshotPayload({
    baStatus: "running",
    unitTestStatus: "idle",
    buildStatus: "idle",
    completedAt: "",
    messageCount: 1,
  });
  const nextPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "running",
    buildStatus: "idle",
    completedAt: "",
    messageCount: 3,
  });

  const acceptedPayload = resolveUiSnapshotQueryData(previousPayload, nextPayload);
  assert.equal(acceptedPayload, nextPayload);
  assert.equal(acceptedPayload.task?.messages.length, 3);
});

test("消息条数增加时，查询缓存应接受新 snapshot", () => {
  const previousPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    buildStatus: "idle",
    completedAt: "",
    messageCount: 1,
  });
  const nextPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    buildStatus: "idle",
    completedAt: "",
    messageCount: 2,
  });

  assert.equal(resolveUiSnapshotQueryData(previousPayload, nextPayload), nextPayload);
  assert.equal(resolveUiSnapshotQueryData(nextPayload, previousPayload), nextPayload);
});

test("补齐 session 与 attach 的 snapshot 必须被视为语义更新并接受", () => {
  const previousPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    completedAt: "",
    messageCount: 2,
  });

  const nextPayloadWithAttach = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    completedAt: "",
    messageCount: 2,
  });
  const nextBaAgent = requireTaskAgent(nextPayloadWithAttach, "BA");
  nextBaAgent.opencodeSessionId = "session-ba-2";
  nextBaAgent.opencodeAttachBaseUrl = "http://localhost:4310";

  const acceptedPayload = resolveUiSnapshotQueryData(previousPayload, nextPayloadWithAttach);
  assert.equal(requireTaskAgent(acceptedPayload, "BA").opencodeSessionId, "session-ba-2");
});

test("仅把旧的非空 session 与 attach 换成另一组非空值时，查询缓存必须保留 previousPayload", () => {
  const previousPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    completedAt: "",
    messageCount: 2,
  });
  const previousBaAgent = requireTaskAgent(previousPayload, "BA");
  previousBaAgent.opencodeSessionId = "session-ba-1";
  previousBaAgent.opencodeAttachBaseUrl = "http://localhost:4310/old";

  const nextPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    completedAt: "",
    messageCount: 2,
  });
  const nextBaAgent = requireTaskAgent(nextPayload, "BA");
  nextBaAgent.opencodeSessionId = "session-ba-2";
  nextBaAgent.opencodeAttachBaseUrl = "http://localhost:4310/new";

  assert.equal(resolveUiSnapshotQueryData(previousPayload, nextPayload), previousPayload);
});

test("较小请求号若首次带回新的 runtime agent，查询缓存也必须采用新 snapshot", () => {
  const previousPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    completedAt: "",
    messageCount: 1,
  });
  const nextPayload = createUiSnapshotPayload({
    baStatus: "completed",
    unitTestStatus: "idle",
    completedAt: "",
    messageCount: 1,
  });
  nextPayload.task?.agents.push({
    id: "误报论证-2",
    taskId: "task-1",
    opencodeSessionId: "session-challenge-2",
    opencodeAttachBaseUrl: "http://localhost:4310",
    status: "running",
    runCount: 1,
  });

  const acceptedPayload = resolveUiSnapshotQueryData(previousPayload, nextPayload);
  assert.equal(acceptedPayload, nextPayload);
  assert.equal(acceptedPayload.task?.agents.some((agent) => agent.id === "误报论证-2"), true);
});
