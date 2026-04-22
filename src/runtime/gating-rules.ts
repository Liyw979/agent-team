import type { AgentStatus } from "@shared/types";

type RevisionRequestContinuationInput = {
  continuation: {
    pendingTargets: string[];
    repairReviewerAgentId: string | null;
    redispatchTargets: string[];
  } | null;
  fallbackActionWhenNoBatch?: Extract<
    RevisionRequestContinuationAction,
    "ignore" | "trigger_fallback_review"
  >;
};

type RevisionRequestContinuationAction =
  | "ignore"
  | "wait_pending_reviewers"
  | "trigger_repair_review"
  | "redispatch_reviewers"
  | "trigger_fallback_review";

export function shouldStopTaskForUnhandledRevisionRequest(input: {
  completeTaskOnFinish: boolean;
  continuationAction: RevisionRequestContinuationAction;
}): boolean {
  if (!input.completeTaskOnFinish) {
    return false;
  }

  return input.continuationAction === "ignore";
}

export function resolveAgentStatusFromReview(input: {
  reviewDecision: "approved" | "needs_revision" | "invalid";
  reviewAgent: boolean;
}): AgentStatus {
  if (input.reviewDecision === "invalid") {
    return "failed";
  }

  if (input.reviewDecision === "needs_revision") {
    return input.reviewAgent ? "needs_revision" : "failed";
  }

  return "completed";
}

export function resolveRevisionRequestContinuationAction(
  input: RevisionRequestContinuationInput,
): RevisionRequestContinuationAction {
  if (!input.continuation) {
    return input.fallbackActionWhenNoBatch ?? "ignore";
  }

  if (input.continuation.pendingTargets.length > 0) {
    return "wait_pending_reviewers";
  }

  if (input.continuation.repairReviewerAgentId) {
    return "trigger_repair_review";
  }

  if (input.continuation.redispatchTargets.length > 0) {
    return "redispatch_reviewers";
  }

  return "ignore";
}
