import type { UiSnapshotPayload } from "@shared/types";

export interface UiSnapshotRefreshAcceptanceInput {
  latestAcceptedRequestId: number;
  latestAcceptedPayload: UiSnapshotPayload | null;
  requestId: number;
  payload: UiSnapshotPayload;
}

export interface UiSnapshotRefreshAcceptance {
  accepted: boolean;
  latestAcceptedRequestId: number;
  payload: UiSnapshotPayload | null;
}

function getAgentProgressRank(status: string) {
  switch (status) {
    case "failed":
    case "completed":
      return 3;
    case "continue":
      return 2;
    case "running":
      return 1;
    default:
      return 0;
  }
}

function isTerminalTaskStatus(status: string) {
  return status === "failed";
}

function isSemanticallyOlderUiSnapshot(
  baseline: UiSnapshotPayload | null,
  candidate: UiSnapshotPayload,
) {
  const baselineTask = baseline?.task;
  const candidateTask = candidate.task;

  if (!baselineTask) {
    return false;
  }

  if (!candidateTask) {
    return true;
  }

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
    baselineTask.task.completedAt &&
    !candidateTask.task.completedAt &&
    isTerminalTaskStatus(candidateTask.task.status)
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
      candidateAgent.runCount === baselineAgent.runCount &&
      getAgentProgressRank(candidateAgent.status) < getAgentProgressRank(baselineAgent.status)
    ) {
      return true;
    }
  }

  return false;
}

export function decideUiSnapshotRefreshAcceptance(
  input: UiSnapshotRefreshAcceptanceInput,
): UiSnapshotRefreshAcceptance {
  if (input.requestId <= input.latestAcceptedRequestId) {
    return {
      accepted: false,
      latestAcceptedRequestId: input.latestAcceptedRequestId,
      payload: null,
    };
  }

  if (isSemanticallyOlderUiSnapshot(input.latestAcceptedPayload, input.payload)) {
    return {
      accepted: false,
      latestAcceptedRequestId: input.latestAcceptedRequestId,
      payload: null,
    };
  }

  return {
    accepted: true,
    latestAcceptedRequestId: input.requestId,
    payload: input.payload,
  };
}
