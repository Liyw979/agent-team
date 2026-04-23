import {
  DEFAULT_ACTION_REQUIRED_MAX_ROUNDS,
  getActionRequiredEdgeLoopLimit,
  getSpawnRules,
  type AgentStatus,
} from "@shared/types";

import { resolveActionRequiredRequestContinuationAction } from "./gating-rules";
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
  type GraphActionRequiredRequest,
  type GraphTaskState,
} from "./gating-state";
import { buildEffectiveTopology, ensureRuntimeAgentStatuses } from "./runtime-topology-graph";
import {
  buildSpawnItemId,
  buildSpawnItemTitle,
  getNextSpawnSequence,
  getSpawnRuleEntryRuntimeNodeIds,
  getSpawnRuleIdForNode,
  isSpawnNode,
} from "./runtime-topology-graph";
import { compileTopology } from "./topology-compiler";
import { spawnRuntimeAgentsForItems } from "./gating-spawn";
import { extractSpawnItemsFromContent } from "./spawn-items";
export interface GraphDispatchJob {
  agentName: string;
  sourceAgentId: string | null;
  kind: "raw" | "transfer" | "complete" | "continue_request";
}

export interface GraphDispatchBatch {
  sourceAgentId: string | null;
  sourceContent?: string;
  displayContent?: string;
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
  reviewDecision: "complete" | "continue" | "invalid";
  agentStatus: AgentStatus;
  agentContextContent: string;
  opinion: string | null;
  allowDirectFallbackWhenNoBatch: boolean;
  signalDone: boolean;
  errorMessage?: string;
}

interface ActionRequiredLoopLimitDecision {
  errorMessage: string;
  maxRevisionRounds: number;
}

export function createGraphTaskState(input: {
  taskId: string;
  topology: GraphTaskState["topology"];
}): GraphTaskState {
  return createEmptyGraphTaskState(input);
}

export function createUserDispatchDecision(
  state: GraphTaskState,
  input: {
    targetAgentName: string;
    content: string;
  },
): GraphRoutingDecision {
  if (isSpawnNode(state, input.targetAgentName)) {
    try {
      const entryTargets = materializeSpawnNodeTargets(state, input.targetAgentName, input.content, true);
      if (entryTargets.length === 0) {
        return {
          type: "failed",
          errorMessage: `${input.targetAgentName} 未生成可执行的入口实例`,
        };
      }
      return {
        type: "execute_batch",
        batch: {
          sourceAgentId: input.targetAgentName,
          sourceContent: input.content,
          triggerTargets: [...entryTargets],
          jobs: entryTargets.map((agentName) => ({
            agentName,
            sourceAgentId: input.targetAgentName,
            kind: "transfer" as const,
          })),
        },
      };
    } catch (error) {
      return {
        type: "failed",
        errorMessage: error instanceof Error ? error.message : `${input.targetAgentName} 展开失败`,
      };
    }
  }

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
  ensureRuntimeAgentStatuses(nextState);
  nextState.agentStatusesByName[result.agentName] = result.agentStatus;
  nextState.agentContextByName[result.agentName] = result.agentContextContent;
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
  const scheduler = new GatingScheduler(buildEffectiveTopology(nextState), runtime);
  const batchContinuation = scheduler.recordHandoffBatchResponse(
    result.agentName,
    result.reviewDecision === "continue" ? "fail" : "complete",
    buildGatingAgentStates(nextState),
  );
  applySchedulerRuntimeToGraphState(nextState, runtime);

  if (result.reviewDecision === "continue") {
    return {
      state: nextState,
      decision: handleActionRequired(nextState, result, batchContinuation),
    };
  }

  clearActionRequiredLoopCountsForReviewer(nextState, result.agentName);

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
    ? triggerApprovedDownstream(nextState, result.agentName, result.agentContextContent)
    : triggerHandoffDownstream(nextState, result.agentName, result.agentContextContent);
  if (primaryDecision.type === "execute_batch") {
    markCompletedSpawnActivationAsDispatchedIfReady(nextState, result.agentName);
    return { state: nextState, decision: primaryDecision };
  }

  const continuationDecision = continueAfterHandoffBatchResponse(
    nextState,
    batchContinuation,
  );
  if (continuationDecision.type === "execute_batch") {
    markCompletedSpawnActivationAsDispatchedIfReady(nextState, result.agentName);
    return { state: nextState, decision: continuationDecision };
  }

  const spawnCompletionDecision = continueCompletedSpawnActivations(nextState, result.agentName);
  if (spawnCompletionDecision.type === "execute_batch") {
    return { state: nextState, decision: spawnCompletionDecision };
  }
  if (spawnCompletionDecision.type === "failed") {
    nextState.taskStatus = "failed";
    return { state: nextState, decision: spawnCompletionDecision };
  }

  if (shouldFinishGraphTask(nextState)) {
    nextState.taskStatus = "finished";
    nextState.waitingReason = null;
    return {
      state: nextState,
      decision: {
        type: "finished",
      },
    };
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

function handleActionRequired(
  state: GraphTaskState,
  result: GraphAgentResult,
  continuation: GatingBatchContinuation | null,
): GraphRoutingDecision {
  const topologyIndex = compileTopology(buildEffectiveTopology(state));
  const actionRequiredTargets = topologyIndex.actionRequiredTargetsBySource[result.agentName] ?? [];
  const continuationAction = resolveActionRequiredRequestContinuationAction({
    continuation,
    fallbackActionWhenNoBatch:
      actionRequiredTargets.length > 0 && result.allowDirectFallbackWhenNoBatch
        ? "trigger_fallback_review"
        : "ignore",
  });
  if (actionRequiredTargets.length > 0 && continuationAction !== "ignore") {
    state.pendingActionRequiredRequestsByAgent[result.agentName] = {
      opinion: result.opinion,
      agentContextContent: result.agentContextContent,
    } satisfies GraphActionRequiredRequest;
  }

  if (continuationAction === "wait_pending_reviewers") {
    state.waitingReason = "wait_pending_reviewers";
    return {
      type: "waiting",
      waitingReason: "wait_pending_reviewers",
    };
  }

  if (continuationAction === "trigger_repair_review" && continuation?.repairReviewerAgentId) {
    const repairTargetAgentId = resolveRepairTargetAgentId(
      state,
      result.agentName,
      continuation.sourceAgentId,
    );
    const loopLimitDecision = enforceActionRequiredLoopLimit(
      state,
      result.agentName,
      repairTargetAgentId,
    );
    if (loopLimitDecision) {
      return continueAfterReviewerLoopLimit(
        state,
        result.agentName,
        repairTargetAgentId,
        loopLimitDecision,
      );
    }
    const storedReview = state.pendingActionRequiredRequestsByAgent[continuation.repairReviewerAgentId];
    if (!storedReview) {
      return {
        type: "waiting",
        waitingReason: "missing_continue_request",
      };
    }
    state.pendingHandoffRepairTargetsBySource[repairTargetAgentId] = [
      continuation.repairReviewerAgentId,
    ];
    const revisionContent =
      storedReview.opinion?.trim()
      || storedReview.agentContextContent
      || "请直接回应当前内容，给出你的判断、补充、澄清、反驳或修改方案。";
    delete state.pendingActionRequiredRequestsByAgent[continuation.repairReviewerAgentId];
    return triggerActionRequiredRequestDownstream(
      state,
      continuation.repairReviewerAgentId,
      revisionContent,
    );
  }

  if (continuationAction === "trigger_fallback_review") {
    const actionRequiredTargets = topologyIndex.actionRequiredTargetsBySource[result.agentName] ?? [];
    const fallbackTarget = actionRequiredTargets[0];
    if (!fallbackTarget) {
      state.taskStatus = "failed";
      return {
        type: "failed",
        errorMessage: `${result.agentName} 给出了 continue，但没有可继续推进的 continue 链路`,
      };
    }
    const loopLimitDecision = enforceActionRequiredLoopLimit(
      state,
      result.agentName,
      fallbackTarget,
    );
    if (loopLimitDecision) {
      return continueAfterReviewerLoopLimit(
        state,
        result.agentName,
        fallbackTarget,
        loopLimitDecision,
      );
    }
    const storedReview = state.pendingActionRequiredRequestsByAgent[result.agentName];
    return triggerActionRequiredRequestDownstream(
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
      errorMessage: `${result.agentName} 给出了 continue，但没有可继续推进的 continue 链路`,
    };
  }

  return {
    type: "waiting",
    waitingReason: continuationAction,
  };
}

function continueAfterHandoffBatchResponse(
  state: GraphTaskState,
  continuation: GatingBatchContinuation | null,
): GraphRoutingDecision {
  const action = resolveActionRequiredRequestContinuationAction({
    continuation,
    fallbackActionWhenNoBatch: "ignore",
  });

  if (action === "trigger_repair_review" && continuation?.repairReviewerAgentId) {
    const loopLimitDecision = enforceActionRequiredLoopLimit(
      state,
      continuation.repairReviewerAgentId,
      continuation.sourceAgentId,
    );
    if (loopLimitDecision) {
      return continueAfterReviewerLoopLimit(
        state,
        continuation.repairReviewerAgentId,
        continuation.sourceAgentId,
        loopLimitDecision,
      );
    }
    const storedReview = state.pendingActionRequiredRequestsByAgent[continuation.repairReviewerAgentId];
    if (!storedReview) {
      return {
        type: "waiting",
        waitingReason: "missing_continue_request",
      };
    }
    state.pendingHandoffRepairTargetsBySource[continuation.sourceAgentId] = [
      continuation.repairReviewerAgentId,
    ];
    const revisionContent =
      storedReview.opinion?.trim()
      || storedReview.agentContextContent
      || "请直接回应当前内容，给出你的判断、补充、澄清、反驳或修改方案。";
    delete state.pendingActionRequiredRequestsByAgent[continuation.repairReviewerAgentId];
    return triggerActionRequiredRequestDownstream(
      state,
      continuation.repairReviewerAgentId,
      revisionContent,
    );
  }

  if (action === "redispatch_reviewers" && continuation && continuation.redispatchTargets.length > 0) {
    return triggerHandoffDownstream(
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

function triggerActionRequiredRequestDownstream(
  state: GraphTaskState,
  sourceAgentId: string,
  revisionContent?: string,
): GraphRoutingDecision {
  const topologyIndex = compileTopology(buildEffectiveTopology(state));
  const targets = (topologyIndex.actionRequiredTargetsBySource[sourceAgentId] ?? []).filter(
    (targetName) => targetName !== sourceAgentId,
  );
  if (targets.length === 0) {
    return {
      type: "failed",
      errorMessage: `${sourceAgentId} 没有可用的 continue 下游`,
    };
  }

  return {
    type: "execute_batch",
    batch: {
      sourceAgentId,
      sourceContent:
        revisionContent
        || state.pendingActionRequiredRequestsByAgent[sourceAgentId]?.opinion?.trim()
        || state.pendingActionRequiredRequestsByAgent[sourceAgentId]?.agentContextContent
        || "请直接回应当前内容，给出你的判断、补充、澄清、反驳或修改方案。",
      triggerTargets: [...targets],
      jobs: targets.map((targetName) => ({
        agentName: targetName,
        sourceAgentId,
        kind: "continue_request",
      })),
    },
  };
}

function resolveRepairTargetAgentId(
  state: GraphTaskState,
  reviewerAgentId: string,
  fallbackRepairTargetAgentId: string,
): string {
  const topologyIndex = compileTopology(buildEffectiveTopology(state));
  const actionRequiredTargets = topologyIndex.actionRequiredTargetsBySource[reviewerAgentId] ?? [];
  if (actionRequiredTargets.includes(fallbackRepairTargetAgentId)) {
    return fallbackRepairTargetAgentId;
  }
  return actionRequiredTargets[0] ?? fallbackRepairTargetAgentId;
}

function triggerHandoffDownstream(
  state: GraphTaskState,
  sourceAgentId: string,
  sourceContent: string,
  restrictTargets?: Set<string>,
  advanceSourceRevision = true,
): GraphRoutingDecision {
  const runtime = graphStateToSchedulerRuntime(state);
  const scheduler = new GatingScheduler(buildEffectiveTopology(state), runtime);
  const pendingRepairTargets = state.pendingHandoffRepairTargetsBySource[sourceAgentId];
  const effectiveRestrictTargets = pendingRepairTargets
    ? new Set(pendingRepairTargets)
    : restrictTargets;
  const plan = scheduler.planHandoffDispatch(
    sourceAgentId,
    sourceContent,
    buildGatingAgentStates(state),
    {
      ...(effectiveRestrictTargets ? { restrictTargets: effectiveRestrictTargets } : {}),
      advanceSourceRevision,
    },
  );
  applySchedulerRuntimeToGraphState(state, runtime);
  if (pendingRepairTargets) {
    delete state.pendingHandoffRepairTargetsBySource[sourceAgentId];
  }
  let nextPlan: GatingDispatchPlan | null;
  try {
    nextPlan = materializeSpawnTargetsInPlan(state, plan, sourceContent);
  } catch (error) {
    return {
      type: "failed",
      errorMessage: error instanceof Error ? error.message : `${sourceAgentId} 下游 spawn 展开失败`,
    };
  }
  if (nextPlan) {
    return planToDecision(nextPlan, "transfer");
  }
  return planToDecision(plan, "transfer");
}

function triggerApprovedDownstream(
  state: GraphTaskState,
  sourceAgentId: string,
  sourceContent: string,
  displayContent?: string,
): GraphRoutingDecision {
  const runtime = graphStateToSchedulerRuntime(state);
  const scheduler = new GatingScheduler(buildEffectiveTopology(state), runtime);
  const plan = scheduler.planApprovedDispatch(
    sourceAgentId,
    sourceContent,
    buildGatingAgentStates(state),
  );
  applySchedulerRuntimeToGraphState(state, runtime);
  let nextPlan: GatingDispatchPlan | null;
  try {
    nextPlan = materializeSpawnTargetsInPlan(state, plan, sourceContent);
  } catch (error) {
    return {
      type: "failed",
      errorMessage: error instanceof Error ? error.message : `${sourceAgentId} 下游 spawn 展开失败`,
    };
  }
  if (nextPlan) {
    return planToDecision(nextPlan, "complete", displayContent);
  }
  return planToDecision(plan, "complete", displayContent);
}

function planToDecision(
  plan: GatingDispatchPlan | null,
  kind: GraphDispatchJob["kind"],
  displayContent?: string,
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
      ...(displayContent ? { displayContent } : {}),
      triggerTargets: [...plan.triggerTargets],
      jobs: dispatchTargets.map((targetName) => ({
        agentName: targetName,
        sourceAgentId: plan.sourceAgentId,
        kind,
      })),
    },
  };
}

function materializeSpawnTargetsInPlan(
  state: GraphTaskState,
  plan: GatingDispatchPlan | null,
  sourceContent: string,
): GatingDispatchPlan | null {
  if (!plan) {
    return null;
  }

  const jobTargets = [...plan.readyTargets, ...plan.queuedTargets];
  if (jobTargets.length === 0) {
    return plan;
  }

  const nextReadyTargets: string[] = [];
  const nextQueuedTargets: string[] = [];
  let changed = false;

  for (const targetName of jobTargets) {
    if (!isSpawnNode(state, targetName)) {
      if (plan.readyTargets.includes(targetName)) {
        nextReadyTargets.push(targetName);
      } else {
        nextQueuedTargets.push(targetName);
      }
      continue;
    }

    const spawnRuleId = getSpawnRuleIdForNode(state, targetName);
    if (!spawnRuleId) {
      if (plan.readyTargets.includes(targetName)) {
        nextReadyTargets.push(targetName);
      } else {
        nextQueuedTargets.push(targetName);
      }
      continue;
    }

    changed = true;
    const entryTargets = materializeSpawnNodeTargets(state, targetName, sourceContent, false);
    replaceHandoffBatchTarget(state, plan.sourceAgentId, targetName, entryTargets);
    for (const entryTarget of entryTargets) {
      if (plan.readyTargets.includes(targetName)) {
        nextReadyTargets.push(entryTarget);
      } else {
        nextQueuedTargets.push(entryTarget);
      }
    }
  }

  if (!changed) {
    return plan;
  }

  return {
    ...plan,
    triggerTargets: [...nextReadyTargets, ...nextQueuedTargets],
    readyTargets: nextReadyTargets,
    queuedTargets: nextQueuedTargets,
  };
}

function replaceHandoffBatchTarget(
  state: GraphTaskState,
  sourceAgentId: string,
  targetName: string,
  replacementTargets: string[],
): void {
  const batch = state.activeHandoffBatchBySource[sourceAgentId];
  if (!batch || replacementTargets.length === 0) {
    return;
  }

  const replaceTargets = (targets: string[]) => uniqueTargetNames(
    targets.flatMap((currentTarget) => (
      currentTarget === targetName ? replacementTargets : [currentTarget]
    )),
  );

  batch.targets = replaceTargets(batch.targets);
  batch.pendingTargets = replaceTargets(batch.pendingTargets);
  batch.respondedTargets = batch.respondedTargets.filter((currentTarget) => currentTarget !== targetName);
  batch.failedTargets = batch.failedTargets.filter((currentTarget) => currentTarget !== targetName);
}

function uniqueTargetNames(targets: string[]): string[] {
  return [...new Set(targets)];
}

function buildSpawnActivationId(spawnRuleId: string, sequence: number): string {
  return `activation:${buildSpawnItemId(spawnRuleId, sequence)}`;
}

function buildSpawnActivationItemId(
  spawnRuleId: string,
  sequence: number,
  index: number,
  total: number,
): string {
  const base = buildSpawnItemId(spawnRuleId, sequence);
  return total <= 1 ? base : `${base}-${index + 1}`;
}

function materializeSpawnNodeTargets(
  state: GraphTaskState,
  targetName: string,
  sourceContent: string,
  allowSingleItemFallback: boolean,
): string[] {
  const spawnRuleId = getSpawnRuleIdForNode(state, targetName);
  if (!spawnRuleId) {
    throw new Error(`${targetName} 缺少 spawnRuleId`);
  }
  const rule = getSpawnRules(state.topology).find((candidate) => candidate.id === spawnRuleId);
  if (!rule) {
    throw new Error(`spawn rule 不存在：${spawnRuleId}`);
  }
  const allowRawFallback = allowSingleItemFallback || Boolean(rule.reportToTemplateName);

  const sequence = getNextSpawnSequence(state, spawnRuleId);
  const parsed = tryExtractSpawnItemsFromContent(
    sourceContent,
    spawnRuleId,
    sequence,
    allowRawFallback,
  );
  const activationId = buildSpawnActivationId(spawnRuleId, sequence);
  const items = parsed.items.map((item, index, itemsList) => ({
    ...item,
    id: buildSpawnActivationItemId(spawnRuleId, sequence, index, itemsList.length),
  }));

  const bundles = spawnRuntimeAgentsForItems({
    state,
    spawnRuleId,
    activationId,
    items,
  });
  state.spawnActivations.push({
    id: activationId,
    spawnNodeName: targetName,
    spawnRuleId,
    sourceContent,
    bundleGroupIds: bundles.map((bundle) => bundle.groupId),
    completedBundleGroupIds: [],
    dispatched: false,
  });

  return bundles.flatMap((bundle) => getSpawnRuleEntryRuntimeNodeIds(state, bundle.groupId, spawnRuleId));
}

function tryExtractSpawnItemsFromContent(
  sourceContent: string,
  spawnRuleId: string,
  sequence: number,
  allowSingleItemFallback: boolean,
) {
  try {
    return extractSpawnItemsFromContent(sourceContent);
  } catch (error) {
    if (!allowSingleItemFallback) {
      throw error;
    }
    return {
      items: [
        {
          id: buildSpawnItemId(spawnRuleId, sequence),
          title: buildSpawnItemTitle(sourceContent, sequence),
        },
      ],
    };
  }
}

function continueCompletedSpawnActivations(
  state: GraphTaskState,
  completedAgentName: string,
): GraphRoutingDecision {
  const bundle = state.spawnBundles.find((candidate) =>
    candidate.nodes.some((node) => node.id === completedAgentName),
  );
  if (!bundle) {
    return {
      type: "waiting",
      waitingReason: "no_completed_spawn_activation",
    };
  }

  const bundleCompleted = bundle.nodes.every((node) => state.agentStatusesByName[node.id] === "completed");
  if (!bundleCompleted) {
    return {
      type: "waiting",
      waitingReason: "spawn_bundle_pending",
    };
  }

  const activation = state.spawnActivations.find((candidate) => candidate.id === bundle.activationId);
  if (!activation) {
    return {
      type: "waiting",
      waitingReason: "spawn_activation_missing",
    };
  }

  if (!activation.completedBundleGroupIds.includes(bundle.groupId)) {
    activation.completedBundleGroupIds.push(bundle.groupId);
  }

  if (activation.dispatched || activation.completedBundleGroupIds.length < activation.bundleGroupIds.length) {
    return {
      type: "waiting",
      waitingReason: "spawn_activation_pending",
    };
  }

  activation.dispatched = true;
  const aggregatedContent = buildSpawnActivationContent(state, activation.id, activation.sourceContent);
  state.agentStatusesByName[activation.spawnNodeName] = "completed";
  state.agentContextByName[activation.spawnNodeName] = aggregatedContent;
  return triggerHandoffDownstream(state, activation.spawnNodeName, aggregatedContent);
}

function buildSpawnActivationContent(
  state: GraphTaskState,
  activationId: string,
  fallbackContent: string,
): string {
  const bundles = state.spawnBundles.filter((bundle) => bundle.activationId === activationId);
  const sections = bundles.map((bundle) => {
    const terminalNodeIds = findBundleTerminalNodeIds(bundle);
    const outputs = terminalNodeIds
      .map((nodeId) => state.agentContextByName[nodeId]?.trim() ?? "")
      .filter(Boolean);
    const body = outputs.join("\n\n").trim();
    return [`[Item] ${bundle.item.title}`, body].filter(Boolean).join("\n");
  }).filter(Boolean);

  return sections.join("\n\n").trim() || fallbackContent;
}

function markCompletedSpawnActivationAsDispatchedIfReady(
  state: GraphTaskState,
  completedAgentName: string,
): void {
  const bundle = state.spawnBundles.find((candidate) =>
    candidate.nodes.some((node) => node.id === completedAgentName),
  );
  if (!bundle) {
    return;
  }

  const bundleCompleted = bundle.nodes.every((node) => state.agentStatusesByName[node.id] === "completed");
  if (!bundleCompleted) {
    return;
  }

  const activation = state.spawnActivations.find((candidate) => candidate.id === bundle.activationId);
  if (!activation) {
    return;
  }

  if (!activation.completedBundleGroupIds.includes(bundle.groupId)) {
    activation.completedBundleGroupIds.push(bundle.groupId);
  }

  if (activation.dispatched || activation.completedBundleGroupIds.length < activation.bundleGroupIds.length) {
    return;
  }

  activation.dispatched = true;
  state.agentStatusesByName[activation.spawnNodeName] = "completed";
  state.agentContextByName[activation.spawnNodeName] = buildSpawnActivationContent(
    state,
    activation.id,
    activation.sourceContent,
  );
}

function findBundleTerminalNodeIds(bundle: GraphTaskState["spawnBundles"][number]): string[] {
  const outgoing = new Set(bundle.edges.map((edge) => edge.source));
  return bundle.nodes
    .map((node) => node.id)
    .filter((nodeId) => !outgoing.has(nodeId));
}

function buildGatingAgentStates(state: GraphTaskState): GatingAgentState[] {
  return buildEffectiveTopology(state).nodes.map((name) => ({
    name,
    status: state.agentStatusesByName[name] ?? "idle",
  }));
}

function enforceActionRequiredLoopLimit(
  state: GraphTaskState,
  sourceAgentId: string,
  targetAgentId: string,
): ActionRequiredLoopLimitDecision | null {
  const maxRevisionRounds = getActionRequiredEdgeLoopLimit(
    buildEffectiveTopology(state),
    sourceAgentId,
    targetAgentId,
  );
  const edgeKey = buildActionRequiredLoopEdgeKey(sourceAgentId, targetAgentId);
  const nextCount = (state.actionRequiredLoopCountByEdge[edgeKey] ?? 0) + 1;
  state.actionRequiredLoopCountByEdge[edgeKey] = nextCount;
  if (nextCount <= maxRevisionRounds) {
    return null;
  }

  const normalizedMaxRevisionRounds = maxRevisionRounds || DEFAULT_ACTION_REQUIRED_MAX_ROUNDS;
  return {
    errorMessage: `${sourceAgentId} -> ${targetAgentId} 已连续交流 ${normalizedMaxRevisionRounds} 次，任务已结束`,
    maxRevisionRounds: normalizedMaxRevisionRounds,
  };
}

function buildActionRequiredLoopEdgeKey(sourceAgentId: string, targetAgentId: string): string {
  return `${sourceAgentId}->${targetAgentId}`;
}

function clearActionRequiredLoopCountsForReviewer(state: GraphTaskState, reviewerAgentId: string): void {
  for (const edgeKey of Object.keys(state.actionRequiredLoopCountByEdge)) {
    if (edgeKey.startsWith(`${reviewerAgentId}->`)) {
      delete state.actionRequiredLoopCountByEdge[edgeKey];
    }
  }
}

function continueAfterReviewerLoopLimit(
  state: GraphTaskState,
  reviewerAgentId: string,
  repairTargetAgentId: string,
  loopLimitDecision: ActionRequiredLoopLimitDecision,
): GraphRoutingDecision {
  const limitedReviewerRequest = state.pendingActionRequiredRequestsByAgent[reviewerAgentId];
  state.agentStatusesByName[reviewerAgentId] = "failed";
  delete state.pendingActionRequiredRequestsByAgent[reviewerAgentId];

  const nextReviewerAgentId = findNextPendingRepairReviewer(
    state,
    repairTargetAgentId,
    reviewerAgentId,
  );
  if (nextReviewerAgentId) {
    const storedReview = state.pendingActionRequiredRequestsByAgent[nextReviewerAgentId];
    if (!storedReview) {
      state.taskStatus = "failed";
      return {
        type: "failed",
        errorMessage: loopLimitDecision.errorMessage,
      };
    }

    state.pendingHandoffRepairTargetsBySource[repairTargetAgentId] = [nextReviewerAgentId];
    delete state.pendingActionRequiredRequestsByAgent[nextReviewerAgentId];
    return triggerActionRequiredRequestDownstream(
      state,
      nextReviewerAgentId,
      storedReview.opinion?.trim()
      || storedReview.agentContextContent
      || "请直接回应当前内容，给出你的判断、补充、澄清、反驳或修改方案。",
    );
  }

  const loopLimitEscalationDecision = triggerApprovedDownstream(
    state,
    reviewerAgentId,
    buildActionRequiredLoopLimitEscalationForwardContent({
      reviewerAgentId,
      repairTargetAgentId,
      reviewRequest: limitedReviewerRequest,
    }),
    buildActionRequiredLoopLimitEscalationDisplayContent({
      reviewerAgentId,
      repairTargetAgentId,
      maxRevisionRounds: loopLimitDecision.maxRevisionRounds,
    }),
  );
  if (loopLimitEscalationDecision.type === "execute_batch") {
    return loopLimitEscalationDecision;
  }

  state.taskStatus = "failed";
  return {
    type: "failed",
    errorMessage: loopLimitDecision.errorMessage,
  };
}

function buildActionRequiredLoopLimitEscalationForwardContent(input: {
  reviewerAgentId: string;
  repairTargetAgentId: string;
  reviewRequest: GraphActionRequiredRequest | undefined;
}): string {
  const reviewerContent =
    input.reviewRequest?.opinion?.trim()
    || input.reviewRequest?.agentContextContent
    || "当前 reviewer 未提供额外正文。";
  return reviewerContent;
}

function buildActionRequiredLoopLimitEscalationDisplayContent(input: {
  reviewerAgentId: string;
  repairTargetAgentId: string;
  maxRevisionRounds: number;
}): string {
  return `${input.reviewerAgentId} -> ${input.repairTargetAgentId} 已连续交流 ${input.maxRevisionRounds} 次`;
}

function findNextPendingRepairReviewer(
  state: GraphTaskState,
  repairTargetAgentId: string,
  excludeReviewerAgentId: string,
): string | null {
  const effectiveTopology = buildEffectiveTopology(state);
  for (const edge of effectiveTopology.edges) {
    if (
      edge.triggerOn === "continue"
      && edge.target === repairTargetAgentId
      && edge.source !== excludeReviewerAgentId
      && state.pendingActionRequiredRequestsByAgent[edge.source]
    ) {
      return edge.source;
    }
  }

  return null;
}

function shouldFinishGraphTask(state: GraphTaskState): boolean {
  if (Object.keys(state.pendingActionRequiredRequestsByAgent).length > 0) {
    return false;
  }
  if (Object.keys(state.activeHandoffBatchBySource).length > 0) {
    return false;
  }
  if (state.spawnActivations.some((activation) => !activation.dispatched)) {
    return false;
  }
  if (state.runningAgents.length > 0 || state.queuedAgents.length > 0) {
    return false;
  }

  const effectiveTopology = buildEffectiveTopology(state);
  const activeNodeNames = new Set(effectiveTopology.nodes);
  const runnableReachableNodes = new Set<string>();

  for (const nodeName of activeNodeNames) {
    const status = state.agentStatusesByName[nodeName];
    if (status && status !== "idle") {
      runnableReachableNodes.add(nodeName);
    }
  }

  for (const nodeName of [...runnableReachableNodes]) {
    for (const downstream of collectReachableNodeNames(effectiveTopology, nodeName)) {
      runnableReachableNodes.add(downstream);
    }
  }

  for (const nodeName of runnableReachableNodes) {
    const status = state.agentStatusesByName[nodeName];
    if (status && status !== "completed") {
      return false;
    }
  }

  return runnableReachableNodes.size > 0;
}

function collectReachableNodeNames(
  topology: GraphTaskState["topology"],
  sourceNodeName: string,
): Set<string> {
  const visited = new Set<string>();
  const queue = [sourceNodeName];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const edge of topology.edges) {
      if (edge.source === current && !visited.has(edge.target)) {
        queue.push(edge.target);
      }
    }
  }

  return visited;
}
