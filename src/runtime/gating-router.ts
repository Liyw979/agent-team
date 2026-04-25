import {
  DEFAULT_ACTION_REQUIRED_MAX_ROUNDS,
  getActionRequiredEdgeLoopLimit,
  getSpawnRules,
  type AgentStatus,
  type Decision,
  type TopologyRecord,
  type TopologyEdgeTrigger,
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
  agentId: string;
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
      type: "finished";
      finishReason: string;
    }
  | {
      type: "failed";
      errorMessage: string;
    };

export interface GraphAgentResult {
  agentId: string;
  status: "completed" | "failed";
  decisionAgent: boolean;
  decision: Decision;
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
    targetAgentId: string;
    content: string;
  },
): GraphRoutingDecision {
  if (isSpawnNode(state, input.targetAgentId)) {
    try {
      const entryTargets = materializeSpawnNodeTargets(state, input.targetAgentId, input.content, true);
      if (entryTargets.length === 0) {
        return {
          type: "failed",
          errorMessage: `${input.targetAgentId} 未生成可执行的入口实例`,
        };
      }
      return {
        type: "execute_batch",
        batch: {
          sourceAgentId: input.targetAgentId,
          sourceContent: input.content,
          triggerTargets: [...entryTargets],
          jobs: entryTargets.map((agentId) => ({
            agentId,
            sourceAgentId: input.targetAgentId,
            kind: "transfer" as const,
          })),
        },
      };
    } catch (error) {
      return {
        type: "failed",
        errorMessage: error instanceof Error ? error.message : `${input.targetAgentId} 展开失败`,
      };
    }
  }

  return {
    type: "execute_batch",
    batch: {
      sourceAgentId: null,
      sourceContent: input.content,
      triggerTargets: [input.targetAgentId],
      jobs: [
        {
          agentId: input.targetAgentId,
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
  nextState.agentStatusesByName[result.agentId] = result.agentStatus;
  nextState.agentContextByName[result.agentId] = result.agentContextContent;
  nextState.taskStatus = "running";
  nextState.finishReason = null;

  if (result.status === "failed") {
    nextState.taskStatus = "failed";
    return {
      state: nextState,
      decision: {
        type: "failed",
        errorMessage: result.errorMessage ?? `${result.agentId} 执行失败`,
      },
    };
  }

  const runtime = graphStateToSchedulerRuntime(nextState);
  const scheduler = new GatingScheduler(buildEffectiveTopology(nextState), runtime);
  const batchContinuation = scheduler.recordHandoffBatchResponse(
    result.agentId,
    result.decision === "continue" ? "fail" : "complete",
  );
  applySchedulerRuntimeToGraphState(nextState, runtime);

  if (shouldFinishGraphTaskFromEndEdge(nextState, result)) {
    return {
      state: {
        ...nextState,
        taskStatus: "finished",
        finishReason: "end_edge_complete",
      },
      decision: {
        type: "finished",
        finishReason: "end_edge_complete",
      },
    };
  }

  if (result.decision === "continue") {
    const actionRequiredDecision = handleActionRequired(nextState, result, batchContinuation);
    if (actionRequiredDecision.type === "finished") {
      return {
        state: {
          ...nextState,
          taskStatus: "finished",
          finishReason: actionRequiredDecision.finishReason,
        },
        decision: actionRequiredDecision,
      };
    }
    return {
      state: nextState,
      decision: actionRequiredDecision,
    };
  }

  clearActionRequiredLoopCountsForDecisionAgent(nextState, result.agentId);
  if (result.decision === "invalid") {
    nextState.taskStatus = "failed";
    return {
      state: nextState,
      decision: {
        type: "failed",
        errorMessage: `${result.agentId} 返回了无效判定结果`,
      },
    };
  }

  const primaryDecision = result.decisionAgent
    ? triggerApprovedDownstream(nextState, result.agentId, result.agentContextContent)
    : triggerHandoffDownstream(nextState, result.agentId, result.agentContextContent);
  if (primaryDecision.type === "execute_batch") {
    markCompletedSpawnActivationAsDispatchedIfReady(nextState, result.agentId);
    return { state: nextState, decision: primaryDecision };
  }

  const continuationDecision = continueAfterHandoffBatchResponse(
    nextState,
    batchContinuation,
  );
  if (continuationDecision.type === "execute_batch") {
    markCompletedSpawnActivationAsDispatchedIfReady(nextState, result.agentId);
    return { state: nextState, decision: continuationDecision };
  }

  const spawnCompletionDecision = continueCompletedSpawnActivations(nextState, result.agentId);
  if (spawnCompletionDecision.type === "execute_batch") {
    return { state: nextState, decision: spawnCompletionDecision };
  }
  if (spawnCompletionDecision.type === "failed") {
    nextState.taskStatus = "failed";
    return { state: nextState, decision: spawnCompletionDecision };
  }

  if (shouldFinishGraphTask(nextState)) {
    return {
      state: {
        ...nextState,
        taskStatus: "finished",
        finishReason: "all_agents_completed",
      },
      decision: {
        type: "finished",
        finishReason: "all_agents_completed",
      },
    };
  }

  return {
    state: {
      ...nextState,
      taskStatus: "finished",
      finishReason: "no_runnable_agents",
    },
    decision: {
      type: "finished",
      finishReason: "no_runnable_agents",
    },
  };
}

export function resolveRestrictedRepairTargetsForSource(
  topology: TopologyRecord,
  sourceAgentId: string,
  requestedTargets: string[],
): string[] {
  const topologyIndex = compileTopology(topology);
  const directHandoffTargets = new Set(topologyIndex.handoffTargetsBySource[sourceAgentId] ?? []);
  if (directHandoffTargets.size === 0) {
    return [];
  }

  return requestedTargets.filter((target) => directHandoffTargets.has(target));
}

function handleActionRequired(
  state: GraphTaskState,
  result: GraphAgentResult,
  continuation: GatingBatchContinuation | null,
): GraphRoutingDecision {
  const actionRequiredTargets = getActionRequiredTargetsForSource(state, result.agentId);
  const continuationAction = resolveActionRequiredRequestContinuationAction({
    continuation,
    fallbackActionWhenNoBatch:
      actionRequiredTargets.length > 0 && result.allowDirectFallbackWhenNoBatch
        ? "trigger_fallback_decision"
        : "ignore",
  });
  if (actionRequiredTargets.length > 0 && continuationAction !== "ignore") {
    state.pendingActionRequiredRequestsByAgent[result.agentId] = {
      opinion: result.opinion,
      agentContextContent: result.agentContextContent,
    } satisfies GraphActionRequiredRequest;
  }

  if (continuationAction === "wait_pending_decision_agents") {
    return {
      type: "finished",
      finishReason: "wait_pending_decision_agents",
    };
  }

  if (continuationAction === "trigger_repair_decision" && continuation?.repairDecisionAgentId) {
    const repairTargetAgentId = resolveRepairTargetAgentId(
      state,
      result.agentId,
      continuation.sourceAgentId,
    );
    const loopLimitDecision = enforceActionRequiredLoopLimit(
      state,
      result.agentId,
      repairTargetAgentId,
    );
    if (loopLimitDecision) {
      return continueAfterDecisionLoopLimit(
        state,
        result.agentId,
        repairTargetAgentId,
        loopLimitDecision,
      );
    }
    const storedDecision = state.pendingActionRequiredRequestsByAgent[continuation.repairDecisionAgentId];
    if (!storedDecision) {
      return {
        type: "finished",
        finishReason: "missing_continue_request",
      };
    }
    const restrictedRepairTargets = resolveRestrictedRepairTargetsForSource(
      buildEffectiveTopology(state),
      repairTargetAgentId,
      [continuation.repairDecisionAgentId],
    );
    if (restrictedRepairTargets.length > 0) {
      state.pendingHandoffRepairTargetsBySource[repairTargetAgentId] = restrictedRepairTargets;
    }
    const revisionContent =
      storedDecision.opinion?.trim()
      || storedDecision.agentContextContent
      || "请直接回应当前内容，给出你的判断、补充、澄清、反驳或修改方案。";
    delete state.pendingActionRequiredRequestsByAgent[continuation.repairDecisionAgentId];
    return triggerActionRequiredRequestDownstream(
      state,
      continuation.repairDecisionAgentId,
      revisionContent,
    );
  }

  if (continuationAction === "trigger_fallback_decision") {
    const fallbackTarget = actionRequiredTargets[0];
    if (!fallbackTarget) {
      state.taskStatus = "failed";
      return {
        type: "failed",
        errorMessage: `${result.agentId} 给出了 continue，但没有可继续推进的 continue 链路`,
      };
    }
    const loopLimitDecision = enforceActionRequiredLoopLimit(
      state,
      result.agentId,
      fallbackTarget,
    );
    if (loopLimitDecision) {
      return continueAfterDecisionLoopLimit(
        state,
        result.agentId,
        fallbackTarget,
        loopLimitDecision,
      );
    }
    const storedDecision = state.pendingActionRequiredRequestsByAgent[result.agentId];
    return triggerActionRequiredRequestDownstream(
      state,
      result.agentId,
      storedDecision?.opinion?.trim()
      || storedDecision?.agentContextContent
      || result.opinion?.trim()
      || result.agentContextContent
      || "请直接回应当前内容，给出你的判断、补充、澄清、反驳或修改方案。",
    );
  }

  if (continuationAction === "ignore") {
    if (actionRequiredTargets.length > 0) {
      return triggerActionRequiredRequestDownstream(
        state,
        result.agentId,
        result.opinion?.trim()
        || result.agentContextContent
        || "请直接回应当前内容，给出你的判断、补充、澄清、反驳或修改方案。",
      );
    }
    state.taskStatus = "failed";
    return {
      type: "failed",
      errorMessage: `${result.agentId} 给出了 continue，但没有可继续推进的 continue 链路`,
    };
  }

  return {
    type: "finished",
    finishReason: continuationAction,
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

  if (action === "trigger_repair_decision" && continuation?.repairDecisionAgentId) {
    const loopLimitDecision = enforceActionRequiredLoopLimit(
      state,
      continuation.repairDecisionAgentId,
      continuation.sourceAgentId,
    );
    if (loopLimitDecision) {
      return continueAfterDecisionLoopLimit(
        state,
        continuation.repairDecisionAgentId,
        continuation.sourceAgentId,
        loopLimitDecision,
      );
    }
    const storedDecision = state.pendingActionRequiredRequestsByAgent[continuation.repairDecisionAgentId];
    if (!storedDecision) {
      return {
        type: "finished",
        finishReason: "missing_continue_request",
      };
    }
    const restrictedRepairTargets = resolveRestrictedRepairTargetsForSource(
      buildEffectiveTopology(state),
      continuation.sourceAgentId,
      [continuation.repairDecisionAgentId],
    );
    if (restrictedRepairTargets.length > 0) {
      state.pendingHandoffRepairTargetsBySource[continuation.sourceAgentId] = restrictedRepairTargets;
    }
    const revisionContent =
      storedDecision.opinion?.trim()
      || storedDecision.agentContextContent
      || "请直接回应当前内容，给出你的判断、补充、澄清、反驳或修改方案。";
    delete state.pendingActionRequiredRequestsByAgent[continuation.repairDecisionAgentId];
    return triggerActionRequiredRequestDownstream(
      state,
      continuation.repairDecisionAgentId,
      revisionContent,
    );
  }

  if (action === "redispatch_decision_agents" && continuation && continuation.redispatchTargets.length > 0) {
    return triggerHandoffDownstream(
      state,
      continuation.sourceAgentId,
      continuation.sourceContent,
      new Set(continuation.redispatchTargets),
      false,
    );
  }

  if (action === "wait_pending_decision_agents") {
    return {
      type: "finished",
      finishReason: "wait_pending_decision_agents",
    };
  }

  return {
    type: "finished",
    finishReason: "no_followup",
  };
}

function triggerActionRequiredRequestDownstream(
  state: GraphTaskState,
  sourceAgentId: string,
  revisionContent?: string,
): GraphRoutingDecision {
  const targets = getActionRequiredTargetsForSource(state, sourceAgentId).filter(
    (targetName) => targetName !== sourceAgentId,
  );
  if (targets.length === 0) {
    return {
      type: "failed",
      errorMessage: `${sourceAgentId} 没有可用的 continue 下游`,
    };
  }
  const sourceContent =
    revisionContent
    || state.pendingActionRequiredRequestsByAgent[sourceAgentId]?.opinion?.trim()
    || state.pendingActionRequiredRequestsByAgent[sourceAgentId]?.agentContextContent
    || "请直接回应当前内容，给出你的判断、补充、澄清、反驳或修改方案。";
  let dispatchTargets: string[];
  try {
    dispatchTargets = targets.flatMap((targetName) =>
      isSpawnNode(state, targetName)
        ? materializeSpawnNodeTargets(state, targetName, sourceContent, false)
        : [targetName]);
  } catch (error) {
    return {
      type: "failed",
      errorMessage: error instanceof Error ? error.message : `${sourceAgentId} 下游 spawn 展开失败`,
    };
  }

  return {
    type: "execute_batch",
    batch: {
      sourceAgentId,
      sourceContent,
      triggerTargets: [...dispatchTargets],
      jobs: dispatchTargets.map((targetName) => ({
        agentId: targetName,
        sourceAgentId,
        kind: "continue_request",
      })),
    },
  };
}

function resolveRepairTargetAgentId(
  state: GraphTaskState,
  decisionAgentId: string,
  fallbackRepairTargetAgentId: string,
): string {
  const actionRequiredTargets = getActionRequiredTargetsForSource(state, decisionAgentId);
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
      type: "finished",
      finishReason: "no_dispatch_targets",
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
        agentId: targetName,
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
  if (!batch) {
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

  if (batch.targets.length === 0) {
    delete state.activeHandoffBatchBySource[sourceAgentId];
  }
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
  if (parsed.items.length === 0) {
    state.agentStatusesByName[targetName] = "completed";
    state.agentContextByName[targetName] = sourceContent;
    return [];
  }
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

function getActionRequiredTargetsForSource(
  state: GraphTaskState,
  sourceAgentId: string,
): string[] {
  const topologyIndex = compileTopology(buildEffectiveTopology(state));
  return (topologyIndex.actionRequiredTargetsBySource[sourceAgentId] ?? []).filter((targetName) =>
    !isRuntimeNodeFromDispatchedSpawnActivation(state, targetName)
  );
}

function isRuntimeNodeFromDispatchedSpawnActivation(
  state: GraphTaskState,
  targetName: string,
): boolean {
  const runtimeNode = state.runtimeNodes.find((node) => node.id === targetName);
  if (!runtimeNode?.groupId) {
    return false;
  }

  return state.spawnActivations.some((activation) =>
    activation.dispatched
    && activation.bundleGroupIds.includes(runtimeNode.groupId ?? "")
  );
}

function continueCompletedSpawnActivations(
  state: GraphTaskState,
  completedAgentId: string,
): GraphRoutingDecision {
  const bundle = state.spawnBundles.find((candidate) =>
    candidate.nodes.some((node) => node.id === completedAgentId),
  );
  if (!bundle) {
    return {
      type: "finished",
      finishReason: "no_completed_spawn_activation",
    };
  }

  const bundleCompleted = bundle.nodes.every((node) => state.agentStatusesByName[node.id] === "completed");
  if (!bundleCompleted) {
    return {
      type: "finished",
      finishReason: "spawn_bundle_pending",
    };
  }

  const activation = state.spawnActivations.find((candidate) => candidate.id === bundle.activationId);
  if (!activation) {
    return {
      type: "finished",
      finishReason: "spawn_activation_missing",
    };
  }

  if (!activation.completedBundleGroupIds.includes(bundle.groupId)) {
    activation.completedBundleGroupIds.push(bundle.groupId);
  }

  if (activation.dispatched || activation.completedBundleGroupIds.length < activation.bundleGroupIds.length) {
    return {
      type: "finished",
      finishReason: "spawn_activation_pending",
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
  completedAgentId: string,
): void {
  const bundle = state.spawnBundles.find((candidate) =>
    candidate.nodes.some((node) => node.id === completedAgentId),
  );
  if (!bundle) {
    return;
  }

  const activation = state.spawnActivations.find((candidate) => candidate.id === bundle.activationId);
  if (!activation) {
    return;
  }

  if (activation.dispatched) {
    return;
  }

  const reportsBackToOuterTopology = bundle.edges.some((edge) =>
    edge.source === completedAgentId
    && !bundle.nodes.some((node) => node.id === edge.target)
  );
  if (!reportsBackToOuterTopology) {
    const bundleCompleted = bundle.nodes.every((node) => state.agentStatusesByName[node.id] === "completed");
    if (!bundleCompleted) {
      return;
    }
  }

  if (!activation.completedBundleGroupIds.includes(bundle.groupId)) {
    activation.completedBundleGroupIds.push(bundle.groupId);
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
  return buildEffectiveTopology(state).nodes.map((id) => ({
    id,
    status: state.agentStatusesByName[id] ?? "idle",
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

function clearActionRequiredLoopCountsForDecisionAgent(state: GraphTaskState, decisionAgentId: string): void {
  for (const edgeKey of Object.keys(state.actionRequiredLoopCountByEdge)) {
    if (edgeKey.startsWith(`${decisionAgentId}->`)) {
      delete state.actionRequiredLoopCountByEdge[edgeKey];
    }
  }
}

function continueAfterDecisionLoopLimit(
  state: GraphTaskState,
  decisionAgentId: string,
  repairTargetAgentId: string,
  loopLimitDecision: ActionRequiredLoopLimitDecision,
): GraphRoutingDecision {
  const limitedDecisionAgentRequest = state.pendingActionRequiredRequestsByAgent[decisionAgentId];
  state.agentStatusesByName[decisionAgentId] = "failed";
  delete state.pendingActionRequiredRequestsByAgent[decisionAgentId];

  const nextDecisionAgentId = findNextPendingRepairDecisionAgent(
    state,
    repairTargetAgentId,
    decisionAgentId,
  );
  if (nextDecisionAgentId) {
    const storedDecision = state.pendingActionRequiredRequestsByAgent[nextDecisionAgentId];
    if (!storedDecision) {
      state.taskStatus = "failed";
      return {
        type: "failed",
        errorMessage: loopLimitDecision.errorMessage,
      };
    }

    const restrictedRepairTargets = resolveRestrictedRepairTargetsForSource(
      buildEffectiveTopology(state),
      repairTargetAgentId,
      [nextDecisionAgentId],
    );
    if (restrictedRepairTargets.length > 0) {
      state.pendingHandoffRepairTargetsBySource[repairTargetAgentId] = restrictedRepairTargets;
    }
    delete state.pendingActionRequiredRequestsByAgent[nextDecisionAgentId];
    return triggerActionRequiredRequestDownstream(
      state,
      nextDecisionAgentId,
      storedDecision.opinion?.trim()
      || storedDecision.agentContextContent
      || "请直接回应当前内容，给出你的判断、补充、澄清、反驳或修改方案。",
    );
  }

  const loopLimitEscalationDecision = triggerApprovedDownstream(
    state,
    decisionAgentId,
    buildActionRequiredLoopLimitEscalationForwardContent({
      decisionAgentId,
      repairTargetAgentId,
      decisionRequest: limitedDecisionAgentRequest,
    }),
    buildActionRequiredLoopLimitEscalationDisplayContent({
      decisionAgentId,
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
  decisionAgentId: string;
  repairTargetAgentId: string;
  decisionRequest: GraphActionRequiredRequest | undefined;
}): string {
  const decisionContent =
    input.decisionRequest?.opinion?.trim()
    || input.decisionRequest?.agentContextContent
    || "当前 decisionAgent 未提供额外正文。";
  return decisionContent;
}

function buildActionRequiredLoopLimitEscalationDisplayContent(input: {
  decisionAgentId: string;
  repairTargetAgentId: string;
  maxRevisionRounds: number;
}): string {
  return `${input.decisionAgentId} -> ${input.repairTargetAgentId} 已连续交流 ${input.maxRevisionRounds} 次`;
}

function findNextPendingRepairDecisionAgent(
  state: GraphTaskState,
  repairTargetAgentId: string,
  excludeDecisionAgentId: string,
): string | null {
  const effectiveTopology = buildEffectiveTopology(state);
  for (const edge of effectiveTopology.edges) {
    if (
      edge.triggerOn === "continue"
      && edge.target === repairTargetAgentId
      && edge.source !== excludeDecisionAgentId
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

function shouldFinishGraphTaskFromEndEdge(
  state: GraphTaskState,
  result: Pick<GraphAgentResult, "agentId" | "signalDone" | "decisionAgent" | "decision">,
): boolean {
  const endNode = state.topology.langgraph?.end;
  const endSources = endNode?.sources ?? [];
  if (!endSources.includes(result.agentId)) {
    return false;
  }
  const incoming = endNode?.incoming?.filter((edge) => edge.source === result.agentId) ?? [];
  if (incoming.length > 0) {
    if (!incoming.some((edge) => endTriggerMatchesResult(edge.triggerOn, result))) {
      return false;
    }
  } else if (!result.signalDone) {
    return false;
  }
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

  return true;
}

function endTriggerMatchesResult(
  triggerOn: TopologyEdgeTrigger | undefined,
  result: Pick<GraphAgentResult, "decisionAgent" | "decision">,
): boolean {
  if (!triggerOn) {
    return true;
  }
  if (triggerOn === "transfer") {
    return !result.decisionAgent;
  }
  if (triggerOn === "complete") {
    return result.decisionAgent && result.decision === "complete";
  }
  return result.decisionAgent && result.decision === "continue";
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
