import type { UiSnapshotPayload } from "@shared/types";

export type LatestAcceptedUiSnapshotState =
  | {
      kind: "initial";
    }
  | {
      kind: "accepted";
      payload: UiSnapshotPayload;
    };

export const INITIAL_LATEST_ACCEPTED_UI_SNAPSHOT_STATE: LatestAcceptedUiSnapshotState = {
  kind: "initial",
};

interface UiSnapshotRefreshAcceptanceInput {
  latestAcceptedRequestId: number;
  latestAcceptedState: LatestAcceptedUiSnapshotState;
  requestId: number;
  payload: UiSnapshotPayload;
}

type UiSnapshotRefreshAcceptance =
  | {
      accepted: false;
      latestAcceptedRequestId: number;
      latestAcceptedState: LatestAcceptedUiSnapshotState;
    }
  | {
      accepted: true;
      latestAcceptedRequestId: number;
      latestAcceptedState: Extract<LatestAcceptedUiSnapshotState, { kind: "accepted" }>;
    };

function getAgentProgressRank(status: string) {
  switch (status) {
    case "failed":
    case "completed":
      return 3;
    case "running":
      return 1;
    default:
      return 0;
  }
}

function isTerminalTaskStatus(status: string) {
  return status === "failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRawUiSnapshotPayload(value: unknown): value is UiSnapshotPayload {
  if (!isRecord(value)) {
    return false;
  }
  if (
    value["kind"] === "workspace" &&
    isRecord(value["workspace"]) &&
    typeof value["launchCwd"] === "string" &&
    typeof value["taskUrl"] === "string"
  ) {
    return true;
  }
  return (
    value["kind"] === "task" &&
    isRecord(value["workspace"]) &&
    isRecord(value["task"]) &&
    typeof value["launchCwd"] === "string" &&
    typeof value["taskUrl"] === "string" &&
    typeof value["taskLogFilePath"] === "string"
  );
}

export function isSemanticallyOlderUiSnapshot(
  baseline: UiSnapshotPayload,
  candidate: UiSnapshotPayload,
) {
  if (baseline.kind === "workspace") {
    return false;
  }

  if (candidate.kind === "workspace") {
    return true;
  }

  const baselineTask = baseline.task;
  const candidateTask = candidate.task;

  if (baselineTask.task.id !== candidateTask.task.id) {
    return false;
  }

  if (candidateTask.messages.length < baselineTask.messages.length) {
    return true;
  }

  if (isTerminalTaskStatus(baselineTask.task.status) && !isTerminalTaskStatus(candidateTask.task.status)) {
    return true;
  }

  if (
    baselineTask.task.completedAt
    && !candidateTask.task.completedAt
    && isTerminalTaskStatus(candidateTask.task.status)
  ) {
    return true;
  }

  const baselineAgents = new Map(baselineTask.agents.map((agent) => [agent.id, agent]));
  const candidateAgents = new Map(candidateTask.agents.map((agent) => [agent.id, agent]));

  for (const [agentId, baselineAgent] of baselineAgents) {
    const candidateAgent = candidateAgents.get(agentId);
    if (!candidateAgent) {
      return true;
    }

    if (candidateAgent.runCount < baselineAgent.runCount) {
      return true;
    }

    if (
      candidateAgent.runCount === baselineAgent.runCount
      && getAgentProgressRank(candidateAgent.status) < getAgentProgressRank(baselineAgent.status)
    ) {
      return true;
    }

    const baselineSessionId = baselineAgent.opencodeSessionId;
    const candidateSessionId = candidateAgent.opencodeSessionId;
    if (baselineSessionId.trim().length > 0 && candidateSessionId.trim().length === 0) {
      return true;
    }

    const baselineAttachBaseUrl = baselineAgent.opencodeAttachBaseUrl;
    const candidateAttachBaseUrl = candidateAgent.opencodeAttachBaseUrl;
    if (baselineAttachBaseUrl.trim().length > 0 && candidateAttachBaseUrl.trim().length === 0) {
      return true;
    }
  }

  return false;
}

export function isSemanticallyNewerUiSnapshot(
  baseline: UiSnapshotPayload,
  candidate: UiSnapshotPayload,
) {
  if (
    baseline.kind === "workspace" ||
    candidate.kind === "workspace" ||
    baseline.task.task.id !== candidate.task.task.id
  ) {
    return false;
  }

  const baselineTask = baseline.task;
  const candidateTask = candidate.task;

  const baselineAgents = new Map(baselineTask.agents.map((agent) => [agent.id, agent]));
  for (const candidateAgent of candidateTask.agents) {
    const baselineAgent = baselineAgents.get(candidateAgent.id);
    if (!baselineAgent) {
      return true;
    }

    if (candidateAgent.runCount > baselineAgent.runCount) {
      return true;
    }

    if (
      candidateAgent.runCount === baselineAgent.runCount
      && getAgentProgressRank(candidateAgent.status) > getAgentProgressRank(baselineAgent.status)
    ) {
      return true;
    }

    const baselineSessionId = baselineAgent.opencodeSessionId;
    const candidateSessionId = candidateAgent.opencodeSessionId;
    if (baselineSessionId.trim().length === 0 && candidateSessionId.trim().length > 0) {
      return true;
    }

    const baselineAttachBaseUrl = baselineAgent.opencodeAttachBaseUrl;
    const candidateAttachBaseUrl = candidateAgent.opencodeAttachBaseUrl;
    if (baselineAttachBaseUrl.trim().length === 0 && candidateAttachBaseUrl.trim().length > 0) {
      return true;
    }
  }

  return candidateTask.messages.length > baselineTask.messages.length;
}

export function decideUiSnapshotRefreshAcceptance(
  input: UiSnapshotRefreshAcceptanceInput,
): UiSnapshotRefreshAcceptance {
  if (input.latestAcceptedState.kind === "initial") {
    return {
      accepted: true,
      latestAcceptedRequestId: input.requestId,
      latestAcceptedState: {
        kind: "accepted",
        payload: input.payload,
      },
    };
  }

  if (input.requestId < input.latestAcceptedRequestId) {
    if (
      isSemanticallyNewerUiSnapshot(input.latestAcceptedState.payload, input.payload)
      && !isSemanticallyOlderUiSnapshot(input.latestAcceptedState.payload, input.payload)
    ) {
      return {
        accepted: true,
        latestAcceptedRequestId: input.latestAcceptedRequestId,
        latestAcceptedState: {
          kind: "accepted",
          payload: input.payload,
        },
      };
    }

    return {
      accepted: false,
      latestAcceptedRequestId: input.latestAcceptedRequestId,
      latestAcceptedState: input.latestAcceptedState,
    };
  }

  if (input.requestId === input.latestAcceptedRequestId) {
    return {
      accepted: false,
      latestAcceptedRequestId: input.latestAcceptedRequestId,
      latestAcceptedState: input.latestAcceptedState,
    };
  }

  if (isSemanticallyOlderUiSnapshot(input.latestAcceptedState.payload, input.payload)) {
    return {
      accepted: false,
      latestAcceptedRequestId: input.latestAcceptedRequestId,
      latestAcceptedState: input.latestAcceptedState,
    };
  }

  return {
    accepted: true,
    latestAcceptedRequestId: input.requestId,
    latestAcceptedState: {
      kind: "accepted",
      payload: input.payload,
    },
  };
}

export function resolveUiSnapshotQueryData(
  previousPayload: UiSnapshotPayload,
  nextPayload: UiSnapshotPayload,
) {
  if (previousPayload.kind === "workspace") {
    return nextPayload;
  }

  if (isSemanticallyOlderUiSnapshot(previousPayload, nextPayload)) {
    return previousPayload;
  }

  return isSemanticallyNewerUiSnapshot(previousPayload, nextPayload)
    ? nextPayload
    : previousPayload;
}

export function resolveUiSnapshotQueryStructuralSharing(
  oldData: unknown,
  newData: unknown,
) {
  if (!isRawUiSnapshotPayload(newData)) {
    return newData;
  }
  if (!isRawUiSnapshotPayload(oldData)) {
    return newData;
  }
  return resolveUiSnapshotQueryData(oldData, newData);
}
