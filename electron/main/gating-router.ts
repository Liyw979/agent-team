import type { AgentStatus } from "@shared/types";

import { resolveRevisionRequestContinuationAction } from "./gating-rules";
import {
  GatingScheduler,
  type GatingAgentState,
  type GatingBatchContinuation,
  type GatingDispatchPlan,
} from "./gating-scheduler";
import {
  applySchedulerRuntimeToGraphState,
  cloneGraphTaskState,
  createEmptyGraphTaskState,
  graphStateToSchedulerRuntime,
  type GraphRevisionRequest,
  type GraphTaskState,
} from "./gating-state";
import { compileTopology } from "./topology-compiler";

const MAX_REVIEW_FAIL_LOOP_COUNT = 4;

export interface GraphDispatchJob {
  agentName: string;
  sourceAgentId: string | null;
  kind: "raw" | "association" | "review_pass" | "revision_request";
}

export interface GraphDispatchBatch {
  sourceAgentId: string | null;
  sourceContent?: string;
  jobs: GraphDispatchJob[];
  triggerTargets: string[];
}

export type GraphRoutingDecision =
  | {
      type: "execute_batch";
      batch: GraphDispatchBatch;
    }
  | {
      type: "waiting";
      waitingReason: string;
    }
  | {
      type: "finished";
    }
  | {
      type: "failed";
      errorMessage: string;
    };

export interface GraphAgentResult {
  agentName: string;
  status: "completed" | "failed";
  reviewAgent: boolean;
  reviewDecision: "pass" | "needs_revision" | "invalid";
  agentStatus: AgentStatus;
  agentContextContent: string;
  opinion: string | null;
  allowDirectFallbackWhenNoBatch: boolean;
  signalDone: boolean;
  errorMessage?: string;
}

export function createGraphTaskState(input: {
  taskId: string;
  projectId: string;
  topology: GraphTaskState["topology"];
}): GraphTaskState {
  return createEmptyGraphTaskState(input);
}

export function createUserDispatchDecision(
  _state: GraphTaskState,
  input: {
    targetAgentName: string;
    content: string;
  },
): GraphRoutingDecision {
  return {
    type: "execute_batch",
    batch: {
      sourceAgentId: null,
      sourceContent: input.content,
      triggerTargets: [input.targetAgentName],
      jobs: [
        {
          agentName: input.targetAgentName,
          sourceAgentId: null,
          kind: "raw",
        },
      ],
    },
  };
}

export function applyAgentResultToGraphState(
  state: GraphTaskState,
  result: GraphAgentResult,
): {
  state: GraphTaskState;
  decision: GraphRoutingDecision;
} {
  const nextState = cloneGraphTaskState(state);
  nextState.agentStatusesByName[result.agentName] = result.agentStatus;
  nextState.taskStatus = "running";
  nextState.waitingReason = null;

  if (result.status === "failed") {
    nextState.taskStatus = "failed";
    return {
      state: nextState,
      decision: {
        type: "failed",
        errorMessage: result.errorMessage ?? `${result.agentName} 执行失败`,
      },
    };
  }

  const runtime = graphStateToSchedulerRuntime(nextState);
  const scheduler = new GatingScheduler(nextState.topology, runtime);
  const batchContinuation = scheduler.recordAssociationBatchResponse(
    result.agentName,
    result.reviewDecision === "needs_revision" ? "fail" : "pass",
    buildGatingAgentStates(nextState),
  );
  applySchedulerRuntimeToGraphState(nextState, runtime);

  if (result.reviewDecision === "needs_revision") {
    return {
      state: nextState,
      decision: handleNeedsRevision(nextState, result, batchContinuation),
    };
  }

  clearReviewFailLoopCountsForReviewer(nextState, result.agentName);

  if (result.reviewDecision === "invalid") {
    nextState.taskStatus = "failed";
    return {
      state: nextState,
      decision: {
        type: "failed",
        errorMessage: `${result.agentName} 返回了无效审查结果`,
      },
    };
  }

  const primaryDecision = result.reviewAgent
    ? triggerReviewPassDownstream(nextState, result.agentName, result.agentContextContent)
    : triggerAssociationDownstream(nextState, result.agentName, result.agentContextContent);
  if (primaryDecision.type === "execute_batch") {
    return { state: nextState, decision: primaryDecision };
  }

  const continuationDecision = continueAfterAssociationBatchResponse(
    nextState,
    batchContinuation,
  );
  if (continuationDecision.type === "execute_batch") {
    return { state: nextState, decision: continuationDecision };
  }

  nextState.taskStatus = "waiting";
  nextState.waitingReason = "no_runnable_agents";
  return {
    state: nextState,
    decision: {
      type: "waiting",
      waitingReason: "no_runnable_agents",
    },
  };
}

function handleNeedsRevision(
  state: GraphTaskState,
  result: GraphAgentResult,
  continuation: GatingBatchContinuation | null,
): GraphRoutingDecision {
  const topologyIndex = compileTopology(state.topology);
  const reviewFailureTargets = topologyIndex.reviewFailTargetsBySource[result.agentName] ?? [];
  const continuationAction = resolveRevisionRequestContinuationAction({
    continuation,
    fallbackActionWhenNoBatch:
      reviewFailureTargets.length > 0 && result.allowDirectFallbackWhenNoBatch
        ? "trigger_fallback_review"
        : "ignore",
  });
  if (reviewFailureTargets.length > 0 && continuationAction !== "ignore") {
    state.pendingRevisionRequestsByAgent[result.agentName] = {
      opinion: result.opinion,
      agentContextContent: result.agentContextContent,
    } satisfies GraphRevisionRequest;
  }

  if (continuationAction === "wait_pending_reviewers") {
    state.waitingReason = "wait_pending_reviewers";
    return {
      type: "waiting",
      waitingReason: "wait_pending_reviewers",
    };
  }

  if (continuationAction === "trigger_repair_review" && continuation?.repairReviewerAgentId) {
    const loopLimitDecision = enforceReviewFailLoopLimit(
      state,
      result.agentName,
      continuation.sourceAgentId,
    );
    if (loopLimitDecision) {
      return loopLimitDecision;
    }
    const storedReview = state.pendingRevisionRequestsByAgent[continuation.repairReviewerAgentId];
    if (!storedReview) {
      return {
        type: "waiting",
        waitingReason: "missing_revision_request",
      };
    }
    state.pendingAssociationRepairTargetsBySource[continuation.sourceAgentId] = [
      continuation.repairReviewerAgentId,
    ];
    const revisionContent =
      storedReview.opinion?.trim()
      || storedReview.agentContextContent
      || "请直接回应当前内容，给出你的判断、补充、澄清、反驳或修改方案。";
    delete state.pendingRevisionRequestsByAgent[continuation.repairReviewerAgentId];
    return triggerRevisionRequestDownstream(
      state,
      continuation.repairReviewerAgentId,
      revisionContent,
    );
  }

  if (continuationAction === "trigger_fallback_review") {
    const reviewFailTargets = topologyIndex.reviewFailTargetsBySource[result.agentName] ?? [];
    const fallbackTarget = reviewFailTargets[0];
    if (!fallbackTarget) {
      state.taskStatus = "failed";
      return {
        type: "failed",
        errorMessage: `${result.agentName} 给出了 needs_revision，但没有可继续推进的 review_fail 链路`,
      };
    }
    const loopLimitDecision = enforceReviewFailLoopLimit(
      state,
      result.agentName,
      fallbackTarget,
    );
    if (loopLimitDecision) {
      return loopLimitDecision;
    }
    const storedReview = state.pendingRevisionRequestsByAgent[result.agentName];
    return triggerRevisionRequestDownstream(
      state,
      result.agentName,
      storedReview?.opinion?.trim()
      || storedReview?.agentContextContent
      || result.opinion?.trim()
      || result.agentContextContent
      || "请直接回应当前内容，给出你的判断、补充、澄清、反驳或修改方案。",
    );
  }

  if (continuationAction === "ignore") {
    state.taskStatus = "failed";
    return {
      type: "failed",
      errorMessage: `${result.agentName} 给出了 needs_revision，但没有可继续推进的 review_fail 链路`,
    };
  }

  return {
    type: "waiting",
    waitingReason: continuationAction,
  };
}

function continueAfterAssociationBatchResponse(
  state: GraphTaskState,
  continuation: GatingBatchContinuation | null,
): GraphRoutingDecision {
  const action = resolveRevisionRequestContinuationAction({
    continuation,
    fallbackActionWhenNoBatch: "ignore",
  });

  if (action === "trigger_repair_review" && continuation?.repairReviewerAgentId) {
    const loopLimitDecision = enforceReviewFailLoopLimit(
      state,
      continuation.repairReviewerAgentId,
      continuation.sourceAgentId,
    );
    if (loopLimitDecision) {
      return loopLimitDecision;
    }
    const storedReview = state.pendingRevisionRequestsByAgent[continuation.repairReviewerAgentId];
    if (!storedReview) {
      return {
        type: "waiting",
        waitingReason: "missing_revision_request",
      };
    }
    state.pendingAssociationRepairTargetsBySource[continuation.sourceAgentId] = [
      continuation.repairReviewerAgentId,
    ];
    const revisionContent =
      storedReview.opinion?.trim()
      || storedReview.agentContextContent
      || "请直接回应当前内容，给出你的判断、补充、澄清、反驳或修改方案。";
    delete state.pendingRevisionRequestsByAgent[continuation.repairReviewerAgentId];
    return triggerRevisionRequestDownstream(
      state,
      continuation.repairReviewerAgentId,
      revisionContent,
    );
  }

  if (action === "redispatch_reviewers" && continuation && continuation.redispatchTargets.length > 0) {
    return triggerAssociationDownstream(
      state,
      continuation.sourceAgentId,
      continuation.sourceContent,
      new Set(continuation.redispatchTargets),
      false,
    );
  }

  if (action === "wait_pending_reviewers") {
    return {
      type: "waiting",
      waitingReason: "wait_pending_reviewers",
    };
  }

  return {
    type: "waiting",
    waitingReason: "no_followup",
  };
}

function triggerRevisionRequestDownstream(
  state: GraphTaskState,
  sourceAgentId: string,
  revisionContent?: string,
): GraphRoutingDecision {
  const topologyIndex = compileTopology(state.topology);
  const targets = (topologyIndex.reviewFailTargetsBySource[sourceAgentId] ?? []).filter(
    (targetName) => targetName !== sourceAgentId,
  );
  if (targets.length === 0) {
    return {
      type: "failed",
      errorMessage: `${sourceAgentId} 没有可用的 review_fail 下游`,
    };
  }

  return {
    type: "execute_batch",
    batch: {
      sourceAgentId,
      sourceContent:
        revisionContent
        || state.pendingRevisionRequestsByAgent[sourceAgentId]?.opinion?.trim()
        || state.pendingRevisionRequestsByAgent[sourceAgentId]?.agentContextContent
        || "请直接回应当前内容，给出你的判断、补充、澄清、反驳或修改方案。",
      triggerTargets: [...targets],
      jobs: targets.map((targetName) => ({
        agentName: targetName,
        sourceAgentId,
        kind: "revision_request",
      })),
    },
  };
}

function triggerAssociationDownstream(
  state: GraphTaskState,
  sourceAgentId: string,
  sourceContent: string,
  restrictTargets?: Set<string>,
  advanceSourceRevision = true,
): GraphRoutingDecision {
  const runtime = graphStateToSchedulerRuntime(state);
  const scheduler = new GatingScheduler(state.topology, runtime);
  const pendingRepairTargets = state.pendingAssociationRepairTargetsBySource[sourceAgentId];
  const effectiveRestrictTargets = pendingRepairTargets
    ? new Set(pendingRepairTargets)
    : restrictTargets;
  const plan = scheduler.planAssociationDispatch(
    sourceAgentId,
    sourceContent,
    buildGatingAgentStates(state),
    {
      restrictTargets: effectiveRestrictTargets,
      advanceSourceRevision,
    },
  );
  applySchedulerRuntimeToGraphState(state, runtime);
  if (pendingRepairTargets) {
    delete state.pendingAssociationRepairTargetsBySource[sourceAgentId];
  }
  return planToDecision(plan, "association");
}

function triggerReviewPassDownstream(
  state: GraphTaskState,
  sourceAgentId: string,
  sourceContent: string,
): GraphRoutingDecision {
  const runtime = graphStateToSchedulerRuntime(state);
  const scheduler = new GatingScheduler(state.topology, runtime);
  const plan = scheduler.planReviewPassDispatch(
    sourceAgentId,
    sourceContent,
    buildGatingAgentStates(state),
  );
  applySchedulerRuntimeToGraphState(state, runtime);
  return planToDecision(plan, "review_pass");
}

function planToDecision(
  plan: GatingDispatchPlan | null,
  kind: GraphDispatchJob["kind"],
): GraphRoutingDecision {
  if (!plan || plan.triggerTargets.length === 0) {
    return {
      type: "waiting",
      waitingReason: "no_dispatch_targets",
    };
  }

  const dispatchTargets = [...plan.readyTargets, ...plan.queuedTargets];
  return {
    type: "execute_batch",
    batch: {
      sourceAgentId: plan.sourceAgentId,
      sourceContent: plan.sourceContent,
      triggerTargets: [...plan.triggerTargets],
      jobs: dispatchTargets.map((targetName) => ({
        agentName: targetName,
        sourceAgentId: plan.sourceAgentId,
        kind,
      })),
    },
  };
}

function buildGatingAgentStates(state: GraphTaskState): GatingAgentState[] {
  return state.topology.nodes.map((name) => ({
    name,
    status: state.agentStatusesByName[name] ?? "idle",
  }));
}

function enforceReviewFailLoopLimit(
  state: GraphTaskState,
  sourceAgentId: string,
  targetAgentId: string,
): GraphRoutingDecision | null {
  const edgeKey = buildReviewFailLoopEdgeKey(sourceAgentId, targetAgentId);
  const nextCount = (state.reviewFailLoopCountByEdge[edgeKey] ?? 0) + 1;
  state.reviewFailLoopCountByEdge[edgeKey] = nextCount;
  if (nextCount <= MAX_REVIEW_FAIL_LOOP_COUNT) {
    return null;
  }

  state.taskStatus = "failed";
  return {
    type: "failed",
    errorMessage: `${sourceAgentId} -> ${targetAgentId} 连续回流已达到 ${MAX_REVIEW_FAIL_LOOP_COUNT} 轮上限，任务已终止以避免无限循环`,
  };
}

function buildReviewFailLoopEdgeKey(sourceAgentId: string, targetAgentId: string): string {
  return `${sourceAgentId}->${targetAgentId}`;
}

function clearReviewFailLoopCountsForReviewer(state: GraphTaskState, reviewerAgentId: string): void {
  for (const edgeKey of Object.keys(state.reviewFailLoopCountByEdge)) {
    if (edgeKey.startsWith(`${reviewerAgentId}->`)) {
      delete state.reviewFailLoopCountByEdge[edgeKey];
    }
  }
}
