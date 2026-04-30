import type { UiSnapshotPayload } from "@shared/types";

interface UiSnapshotRefreshAcceptanceInput {
  latestAcceptedRequestId: number;
  latestAcceptedPayload: UiSnapshotPayload | null;
  requestId: number;
  payload: UiSnapshotPayload;
}

interface UiSnapshotRefreshAcceptance {
  accepted: boolean;
  latestAcceptedRequestId: number;
  payload: UiSnapshotPayload | null;
}

function getAgentProgressRank(status: string) {
  switch (status) {
    case "failed":
    case "completed":
      return 3;
    case "action_required":
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
  baseline: UiSnapshotPayload,
  candidate: UiSnapshotPayload,
) {
  const baselineTask = baseline.task;
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

    const baselineSessionId = baselineAgent.opencodeSessionId ?? "";
    const candidateSessionId = candidateAgent.opencodeSessionId ?? "";
    if (baselineSessionId.trim().length > 0 && candidateSessionId.trim().length === 0) {
      return true;
    }

    const baselineAttachBaseUrl = baselineAgent.opencodeAttachBaseUrl ?? "";
    const candidateAttachBaseUrl = candidateAgent.opencodeAttachBaseUrl ?? "";
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
  const baselineTask = baseline.task;
  const candidateTask = candidate.task;

  if (!baselineTask || !candidateTask || baselineTask.task.id !== candidateTask.task.id) {
    return false;
  }

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

    const baselineSessionId = baselineAgent.opencodeSessionId ?? "";
    const candidateSessionId = candidateAgent.opencodeSessionId ?? "";
    if (baselineSessionId.trim().length === 0 && candidateSessionId.trim().length > 0) {
      return true;
    }

    const baselineAttachBaseUrl = baselineAgent.opencodeAttachBaseUrl ?? "";
    const candidateAttachBaseUrl = candidateAgent.opencodeAttachBaseUrl ?? "";
    if (baselineAttachBaseUrl.trim().length === 0 && candidateAttachBaseUrl.trim().length > 0) {
      return true;
    }
  }

  return candidateTask.messages.length > baselineTask.messages.length;
}

export function decideUiSnapshotRefreshAcceptance(
  input: UiSnapshotRefreshAcceptanceInput,
): UiSnapshotRefreshAcceptance {
  if (!input.latestAcceptedPayload) {
    return {
      accepted: true,
      latestAcceptedRequestId: input.requestId,
      payload: input.payload,
    };
  }

  if (input.requestId < input.latestAcceptedRequestId) {
    if (
      isSemanticallyNewerUiSnapshot(input.latestAcceptedPayload, input.payload)
      && !isSemanticallyOlderUiSnapshot(input.latestAcceptedPayload, input.payload)
    ) {
      return {
        accepted: true,
        latestAcceptedRequestId: input.latestAcceptedRequestId,
        payload: input.payload,
      };
    }

    return {
      accepted: false,
      latestAcceptedRequestId: input.latestAcceptedRequestId,
      payload: null,
    };
  }

  if (input.requestId === input.latestAcceptedRequestId) {
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
