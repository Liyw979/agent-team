import type { AgentStatus, Decision } from "@shared/types";

type ActionRequiredRequestContinuationInput = {
  continuation: {
    pendingTargets: string[];
    repairDecisionAgentId: string | null;
    redispatchTargets: string[];
  } | null;
  fallbackActionWhenNoBatch?: Extract<
    ActionRequiredRequestContinuationAction,
    "ignore" | "trigger_fallback_decision"
  >;
};

type ActionRequiredRequestContinuationAction =
  | "ignore"
  | "wait_pending_decision_agents"
  | "trigger_repair_decision"
  | "redispatch_decision_agents"
  | "trigger_fallback_decision";

export function shouldStopTaskForUnhandledActionRequiredRequest(input: {
  completeTaskOnFinish: boolean;
  continuationAction: ActionRequiredRequestContinuationAction;
}): boolean {
  if (!input.completeTaskOnFinish) {
    return false;
  }

  return input.continuationAction === "ignore";
}

export function resolveAgentStatusFromDecision(input: {
  decision: Decision;
  decisionAgent: boolean;
}): Extract<AgentStatus, "completed" | "continue"> {
  if (input.decision === "continue") {
    if (!input.decisionAgent) {
      throw new Error("非判定 Agent 不应返回 continue");
    }
    return "continue";
  }

  return "completed";
}

export function resolveActionRequiredRequestContinuationAction(
  input: ActionRequiredRequestContinuationInput,
): ActionRequiredRequestContinuationAction {
  if (!input.continuation) {
    return input.fallbackActionWhenNoBatch ?? "ignore";
  }

  if (input.continuation.pendingTargets.length > 0) {
    return "wait_pending_decision_agents";
  }

  if (input.continuation.repairDecisionAgentId) {
    return "trigger_repair_decision";
  }

  if (input.continuation.redispatchTargets.length > 0) {
    return "redispatch_decision_agents";
  }

  return "ignore";
}
