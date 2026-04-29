import {
  DEFAULT_TOPOLOGY_TRIGGER,
  DEFAULT_ACTION_REQUIRED_MAX_ROUNDS,
  getActionRequiredEdgeLoopLimit,
  getSpawnRules,
  isActionRequiredTopologyTrigger,
  isDefaultTopologyTrigger,
  normalizeTopologyEdgeTrigger,
  resolveTriggerRoutingKindForSource,
  type AgentStatus,
  type TopologyRecord,
} from "@shared/types";

import { resolveActionRequiredRequestContinuationAction } from "./gating-rules";
import {
  GatingScheduler,
  type GatingAgentState,
  type GatingBatchContinuation,
  type GatingDispatchPlan,
  type GatingRepairBatchContinuation,
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
  getNextSpawnSequence,
  getSpawnRuleEntryRuntimeNodeIds,
  getSpawnRuleIdForNode,
  isSpawnNode,
} from "./runtime-topology-graph";
import { compileTopology } from "./topology-compiler";
import { spawnRuntimeAgentsForItems } from "./gating-spawn";

export interface GraphRawDispatchJob {
  agentId: string;
  sourceContent: string;
  displayContent: string;
  kind: "raw";
}

export interface GraphTransferDispatchJob {
  agentId: string;
  sourceAgentId: string;
  sourceContent: string;
  displayContent: string;
  kind: "transfer";
}

export interface GraphLabeledDispatchJob {
  agentId: string;
  sourceAgentId: string;
  sourceMessageId: string;
  sourceContent: string;
  displayContent: string;
  kind: "dispatch";
}

export interface GraphActionRequiredDispatchJob {
  agentId: string;
  sourceAgentId: string;
  sourceMessageId: string;
  sourceContent: string;
  displayContent: string;
  kind: "action_required_request";
}

export type GraphDispatchJob =
  | GraphRawDispatchJob
  | GraphTransferDispatchJob
  | GraphLabeledDispatchJob;

export type GraphDispatchJobEntry = GraphDispatchJob | GraphActionRequiredDispatchJob;

interface GraphDispatchBatchBase {
  routingKind: "default" | "labeled";
  sourceAgentId: string | null;
  sourceContent: string;
  displayContent: string;
  jobs: GraphDispatchJobEntry[];
  triggerTargets: string[];
}

export type GraphDispatchBatch =
  | (GraphDispatchBatchBase & {
      routingKind: "default";
      trigger?: never;
    })
  | (GraphDispatchBatchBase & {
      routingKind: "labeled";
      trigger: string;
    });

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

interface GraphAgentResultBase {
  agentId: string;
  messageId: string;
  decisionAgent: boolean;
  agentStatus: AgentStatus;
  agentContextContent: string;
  opinion: string;
  signalDone: boolean;
}

export type GraphAgentResult =
  | (GraphAgentResultBase & {
      status: "failed";
      routingKind: "invalid";
      trigger?: never;
      errorMessage: string;
    })
  | (GraphAgentResultBase & {
      status: "completed";
      routingKind: "default";
      trigger?: never;
    })
  | (GraphAgentResultBase & {
      status: "completed";
      routingKind: "invalid";
      trigger?: never;
    })
  | (GraphAgentResultBase & {
      status: "completed";
      routingKind: "labeled";
      trigger: string;
    });

interface ActionRequiredLoopLimitDecision {
  errorMessage: string;
  maxTriggerRounds: number;
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
      const entryTargets = materializeSpawnNodeTargets(state, input.targetAgentId, input.content);
      if (entryTargets.length === 0) {
        return {
          type: "failed",
          errorMessage: `${input.targetAgentId} 未生成可执行的入口实例`,
        };
      }
      return {
        type: "execute_batch",
        batch: {
          routingKind: "default",
          sourceAgentId: input.targetAgentId,
          sourceContent: input.content,
          displayContent: input.content,
          triggerTargets: [...entryTargets],
          jobs: entryTargets.map((agentId) => ({
            agentId,
            sourceAgentId: input.targetAgentId,
            sourceContent: input.content,
            displayContent: input.content,
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
      routingKind: "default",
      sourceAgentId: null,
      sourceContent: input.content,
      displayContent: input.content,
      triggerTargets: [input.targetAgentId],
      jobs: [
        {
          agentId: input.targetAgentId,
          sourceContent: input.content,
          displayContent: input.content,
          kind: "raw",
        },
      ],
    },
  };
}

function resolveGraphAgentResultTriggerRouteKind(
  topology: TopologyRecord,
  result: GraphAgentResult,
): "default" | "labeled" | "action_required" | "invalid" {
  switch (result.routingKind) {
    case "invalid":
      return "invalid";
    case "default":
      return "default";
    case "labeled":
      return resolveTriggerRoutingKindForSource(topology, result.agentId, result.trigger) ?? "invalid";
  }
}

export function applyAgentResultToGraphState(
  state: GraphTaskState,
  result: GraphAgentResult,
): {
  state: GraphTaskState;
  decision: GraphRoutingDecision;
} {
  const nextState = cloneGraphTaskState(state);
  const resultMessageId = result.messageId;
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
        errorMessage: result.errorMessage,
      },
    };
  }

  const runtime = graphStateToSchedulerRuntime(nextState);
  const effectiveTopology = buildEffectiveTopology(nextState);
  const scheduler = new GatingScheduler(effectiveTopology, runtime);
  const triggerRouteKind = resolveGraphAgentResultTriggerRouteKind(effectiveTopology, result);
  const batchContinuation = scheduler.recordHandoffBatchResponse(
    result.agentId,
    triggerRouteKind === "action_required" ? "action_required" : "resolved",
  );
  applySchedulerRuntimeToGraphState(nextState, runtime);

  if (shouldFinishGraphTaskFromEndEdge(nextState, result)) {
    return {
      state: {
        ...nextState,
        taskStatus: "finished",
        finishReason: "end_edge_triggered",
      },
      decision: {
        type: "finished",
        finishReason: "end_edge_triggered",
      },
    };
  }

  if (result.routingKind === "invalid") {
    clearActionRequiredLoopCountsForDecisionAgent(nextState, result.agentId);
    nextState.taskStatus = "failed";
    return {
      state: nextState,
      decision: {
        type: "failed",
        errorMessage: `${result.agentId} 返回了无效判定结果`,
      },
    };
  }

  if (result.routingKind === "labeled" && triggerRouteKind === "action_required") {
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

  const primaryDecision = result.routingKind === "labeled"
    ? triggerLabeledDownstream(
        nextState,
        result.agentId,
        resultMessageId,
        result.agentContextContent,
        result.agentContextContent,
        result.trigger!,
      )
    : triggerHandoffDownstream(nextState, result.agentId, result.agentContextContent);
  if (primaryDecision.type === "execute_batch") {
    markCompletedSpawnActivationAsDispatchedIfReady(nextState, result.agentId);
    return { state: nextState, decision: primaryDecision };
  }

  if (result.routingKind === "labeled") {
    const resumedDebateDecision = resumeBlockedAllCompletedDebateIfNeeded(nextState, result);
    if (resumedDebateDecision) {
      return { state: nextState, decision: resumedDebateDecision };
    }
  }

  const followUpDecision = resumeAfterHandoffBatchResponse(
    nextState,
    batchContinuation,
  );
  if (followUpDecision.type === "execute_batch") {
    markCompletedSpawnActivationAsDispatchedIfReady(nextState, result.agentId);
    return { state: nextState, decision: followUpDecision };
  }

  const spawnFollowUpDecision = resumeCompletedSpawnActivations(nextState, result.agentId);
  if (spawnFollowUpDecision.type === "execute_batch") {
    return { state: nextState, decision: spawnFollowUpDecision };
  }
  if (spawnFollowUpDecision.type === "failed") {
    nextState.taskStatus = "failed";
    return { state: nextState, decision: spawnFollowUpDecision };
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
  result: Extract<GraphAgentResult, { routingKind: "labeled"; status: "completed" }>,
  continuation: GatingBatchContinuation | GatingRepairBatchContinuation | null,
): GraphRoutingDecision {
  const actionRequiredTargets = getActionRequiredTargetsForTrigger(state, result.agentId, result.trigger);
  const currentRequest = actionRequiredTargets.length > 0
    ? createActionRequiredRequest({
        sourceMessageId: result.messageId,
        trigger: result.trigger,
        targetAgentIds: actionRequiredTargets,
        opinion: result.opinion,
        agentContextContent: result.agentContextContent,
      })
    : null;
  const continuationAction = resolveActionRequiredRequestContinuationAction({ continuation });
  if (currentRequest && continuationAction !== "ignore") {
    state.pendingActionRequiredRequestsByAgent[result.agentId] = currentRequest;
  }

  if (continuationAction === "wait_pending_decision_agents") {
    return {
      type: "finished",
      finishReason: "wait_pending_decision_agents",
    };
  }

  if (continuationAction === "trigger_repair_decision") {
    const repairContinuation = continuation as GatingRepairBatchContinuation;
    const storedDecision = requirePendingActionRequiredRequest(state, repairContinuation.repairDecisionAgentId);
    return dispatchActionRequiredRequest(state, repairContinuation.repairDecisionAgentId, storedDecision, {
      consumePendingRequest: true,
    });
  }

  if (continuationAction === "ignore") {
    if (currentRequest) {
      return dispatchActionRequiredRequest(
        state,
        result.agentId,
        currentRequest,
        {
          consumePendingRequest: false,
        },
      );
    }
    state.taskStatus = "failed";
    return {
      type: "failed",
      errorMessage: `${result.agentId} 返回了 action_required 路由，但没有可继续推进的 action_required 链路`,
    };
  }

  return {
    type: "finished",
    finishReason: continuationAction,
  };
}

function resumeAfterHandoffBatchResponse(
  state: GraphTaskState,
  continuation: GatingBatchContinuation | GatingRepairBatchContinuation | null,
): GraphRoutingDecision {
  const action = resolveActionRequiredRequestContinuationAction({ continuation });

  if (action === "trigger_repair_decision") {
    const repairContinuation = continuation as GatingRepairBatchContinuation;
    const storedDecision = requirePendingActionRequiredRequest(state, repairContinuation.repairDecisionAgentId);
    return dispatchActionRequiredRequest(state, repairContinuation.repairDecisionAgentId, storedDecision, {
      consumePendingRequest: true,
    });
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

  if (continuation?.sourceAgentId) {
    const nextDecisionAgentId = findNextPendingRepairDecisionAgent(
      state,
      continuation.sourceAgentId,
      new Set<string>(),
    );
    if (nextDecisionAgentId) {
      const storedDecision = requirePendingActionRequiredRequest(state, nextDecisionAgentId);
      return dispatchActionRequiredRequest(state, nextDecisionAgentId, storedDecision, {
        consumePendingRequest: true,
      });
    }
  }

  return {
    type: "finished",
    finishReason: "no_followup",
  };
}

function resolveRequiredActionRequiredDisplayContent(
  decisionAgentId: string,
  request: Pick<GraphActionRequiredRequest, "opinion" | "agentContextContent">,
): string {
  const content = request.opinion.trim() || request.agentContextContent.trim();
  if (!content) {
    throw new Error(`${decisionAgentId} 的 action_required 结果缺少可转发正文`);
  }
  return content;
}

function resolveRequiredActionRequiredSpawnSourceContent(
  decisionAgentId: string,
  request: Pick<GraphActionRequiredRequest, "agentContextContent">,
): string {
  const content = request.agentContextContent.trim();
  if (!content) {
    throw new Error(`${decisionAgentId} 的 action_required 结果缺少可供 spawn 展开的 finding 正文`);
  }
  return content;
}

function triggerActionRequiredRequestDownstream(
  state: GraphTaskState,
  sourceAgentId: string,
  request: GraphActionRequiredRequest,
  restrictTargets?: Set<string>,
): GraphRoutingDecision {
  const targets = getActionRequiredTargetsForTrigger(state, sourceAgentId, request.trigger).filter(
    (targetName) =>
      targetName !== sourceAgentId
      && (!restrictTargets || restrictTargets.has(targetName)),
  );
  if (targets.length === 0) {
    return {
      type: "failed",
      errorMessage: `${sourceAgentId} 没有可用的 action_required 下游`,
    };
  }
  const displayContent = resolveRequiredActionRequiredDisplayContent(sourceAgentId, request);
  const normalSourceContent = displayContent;
  const jobs: GraphActionRequiredDispatchJob[] = [];
  const dispatchTargets: string[] = [];
  try {
    for (const targetName of targets) {
      if (isSpawnNode(state, targetName)) {
        const spawnSourceContent = resolveRequiredActionRequiredSpawnSourceContent(sourceAgentId, request);
        const runtimeTargets = materializeSpawnNodeTargets(state, targetName, spawnSourceContent);
        dispatchTargets.push(...runtimeTargets);
        jobs.push(...runtimeTargets.map((runtimeTarget) => ({
          agentId: runtimeTarget,
          sourceAgentId,
          sourceMessageId: request.sourceMessageId,
          sourceContent: spawnSourceContent,
          displayContent,
          kind: "action_required_request" as const,
        })));
        continue;
      }
      dispatchTargets.push(targetName);
      jobs.push({
        agentId: targetName,
        sourceAgentId,
        sourceMessageId: request.sourceMessageId,
        sourceContent: normalSourceContent,
        displayContent,
        kind: "action_required_request",
      });
    }
  } catch (error) {
    return {
      type: "failed",
      errorMessage: error instanceof Error ? error.message : `${sourceAgentId} 下游 spawn 展开失败`,
    };
  }
  registerPendingRepairTargetsForDecision(state, sourceAgentId, dispatchTargets);

  return {
    type: "execute_batch",
    batch: {
      routingKind: "labeled",
      sourceAgentId,
      sourceContent: displayContent,
      displayContent,
      trigger: request.trigger,
      triggerTargets: [...dispatchTargets],
      jobs,
    },
  };
}

function triggerHandoffDownstream(
  state: GraphTaskState,
  sourceAgentId: string,
  sourceContent: string,
  restrictTargets?: Set<string>,
  advanceSourceRound = true,
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
      advanceSourceRound,
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
    return createTransferBatchDecision(nextPlan);
  }
  return createTransferBatchDecision(plan);
}

function triggerLabeledDownstream(
  state: GraphTaskState,
  sourceAgentId: string,
  sourceMessageId: string,
  sourceContent: string,
  displayContent: string,
  trigger: string,
): GraphRoutingDecision {
  const runtime = graphStateToSchedulerRuntime(state);
  const scheduler = new GatingScheduler(buildEffectiveTopology(state), runtime);
  const plan = scheduler.planLabeledDispatch(
    sourceAgentId,
    sourceContent,
    buildGatingAgentStates(state),
    {
      restrictTargets: new Set(getTriggeredTargetsForSource(state, sourceAgentId, trigger)),
      trigger,
    },
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
    return createLabeledBatchDecision(nextPlan, sourceMessageId, trigger, displayContent);
  }
  return createLabeledBatchDecision(plan, sourceMessageId, trigger, displayContent);
}

function createTransferBatchDecision(
  plan: GatingDispatchPlan | null,
): GraphRoutingDecision {
  return createExecuteBatchDecision({
    plan,
    routingKind: "default",
    displayContent: plan ? plan.sourceContent : "",
    createJob: (targetName, sourceAgentId, sourceContent, displayContent) => ({
      agentId: targetName,
      sourceAgentId,
      sourceContent,
      displayContent,
      kind: "transfer" as const,
    }),
  });
}

function createLabeledBatchDecision(
  plan: GatingDispatchPlan | null,
  sourceMessageId: string,
  trigger: string,
  displayContent: string,
): GraphRoutingDecision {
  return createExecuteBatchDecision({
    plan,
    routingKind: "labeled",
    trigger,
    displayContent,
    createJob: (targetName, sourceAgentId, sourceContent, batchDisplayContent) => ({
      agentId: targetName,
      sourceAgentId,
      sourceMessageId,
      sourceContent,
      displayContent: batchDisplayContent,
      kind: "dispatch" as const,
    }),
  });
}

function createExecuteBatchDecision(input: {
  plan: GatingDispatchPlan | null;
  routingKind: "default" | "labeled";
  trigger?: string;
  displayContent: string;
  createJob: (
    targetName: string,
    sourceAgentId: string,
    sourceContent: string,
    displayContent: string,
  ) => GraphDispatchJobEntry;
}): GraphRoutingDecision {
  if (!input.plan || input.plan.triggerTargets.length === 0) {
    return {
      type: "finished",
      finishReason: "no_dispatch_targets",
    };
  }
  const batchDisplayContent = input.displayContent ?? input.plan.sourceContent;
  const dispatchTargets = [...input.plan.readyTargets, ...input.plan.queuedTargets];
  const batchBase = {
    sourceAgentId: input.plan.sourceAgentId,
    sourceContent: input.plan.sourceContent,
    displayContent: batchDisplayContent,
    triggerTargets: [...input.plan.triggerTargets],
    jobs: dispatchTargets.map((targetName) =>
      input.createJob(targetName, input.plan!.sourceAgentId, input.plan!.sourceContent, batchDisplayContent)),
  };
  return {
    type: "execute_batch",
    batch: input.routingKind === "labeled"
      ? {
          ...batchBase,
          routingKind: "labeled",
          trigger: input.trigger!,
        }
      : {
          ...batchBase,
          routingKind: "default",
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
    const entryTargets = materializeSpawnNodeTargets(state, targetName, sourceContent);
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

function buildSpawnItemTitle(sourceContent: string): string {
  const firstLine = sourceContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    throw new Error("spawn 上游输出缺少可展开的 finding 正文");
  }
  return firstLine;
}

function materializeSpawnNodeTargets(
  state: GraphTaskState,
  targetName: string,
  sourceContent: string,
): string[] {
  const spawnRuleId = getSpawnRuleIdForNode(state, targetName);
  if (!spawnRuleId) {
    throw new Error(`${targetName} 缺少 spawnRuleId`);
  }
  if (!getSpawnRules(state.topology).some((candidate) => candidate.id === spawnRuleId)) {
    throw new Error(`spawn rule 不存在：${spawnRuleId}`);
  }

  const sequence = getNextSpawnSequence(state, spawnRuleId);
  const activationId = buildSpawnActivationId(spawnRuleId, sequence);
  const items = [
    {
      id: buildSpawnItemId(spawnRuleId, sequence),
      title: buildSpawnItemTitle(sourceContent),
    },
  ].map((item, index, itemsList) => ({
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

function getActionRequiredTargetsForSource(
  state: GraphTaskState,
  sourceAgentId: string,
): string[] {
  const topology = buildEffectiveTopology(state);
  const targets = compileTopology(topology).actionRequiredTargetsBySource[sourceAgentId] ?? [];
  return targets.filter((targetName) =>
    !isRuntimeNodeFromDispatchedSpawnActivation(state, targetName)
  );
}

function getActionRequiredTargetsForTrigger(
  state: GraphTaskState,
  sourceAgentId: string,
  trigger: string,
): string[] {
  return getTriggeredTargetsForSource(state, sourceAgentId, trigger).filter((targetName) =>
    !isRuntimeNodeFromDispatchedSpawnActivation(state, targetName)
  );
}

function getTriggeredTargetsForSource(
  state: GraphTaskState,
  sourceAgentId: string,
  trigger: string,
): string[] {
  const effectiveTopology = buildEffectiveTopology(state);
  return [...new Set(
    effectiveTopology.edges
      .filter((edge) =>
        edge.source === sourceAgentId
        && edge.trigger === trigger,
      )
      .map((edge) => edge.target),
  )];
}

function prepareActionRequiredDispatch(
  state: GraphTaskState,
  decisionAgentId: string,
  request: GraphActionRequiredRequest,
): {
  dispatchTargetIds: string[];
  limitedTargetIds: string[];
  firstLoopLimitDecision: ActionRequiredLoopLimitDecision | null;
} {
  const dispatchTargetIds: string[] = [];
  const limitedTargetIds: string[] = [];
  let firstLoopLimitDecision: ActionRequiredLoopLimitDecision | null = null;

  for (const targetAgentId of uniqueStringValues(request.targetAgentIds)) {
    const loopLimitDecision = enforceActionRequiredLoopLimit(
      state,
      decisionAgentId,
      targetAgentId,
      request.trigger,
    );
    if (loopLimitDecision) {
      limitedTargetIds.push(targetAgentId);
      firstLoopLimitDecision ??= loopLimitDecision;
      continue;
    }
    dispatchTargetIds.push(targetAgentId);
  }

  return {
    dispatchTargetIds,
    limitedTargetIds,
    firstLoopLimitDecision,
  };
}

function createActionRequiredRequest(input: {
  sourceMessageId: string;
  trigger: string;
  targetAgentIds: string[];
  opinion: string;
  agentContextContent: string;
}): GraphActionRequiredRequest {
  return {
    sourceMessageId: input.sourceMessageId,
    trigger: input.trigger,
    targetAgentIds: [...input.targetAgentIds],
    opinion: input.opinion,
    agentContextContent: input.agentContextContent,
  };
}

function requirePendingActionRequiredRequest(
  state: GraphTaskState,
  decisionAgentId: string,
): GraphActionRequiredRequest {
  const request = state.pendingActionRequiredRequestsByAgent[decisionAgentId];
  if (!request) {
    throw new Error(`${decisionAgentId} 缺少待处理的 action_required 请求`);
  }
  return request;
}

function buildMissingActionRequiredTargetsError(decisionAgentId: string): string {
  return `${decisionAgentId} 返回了 action_required 路由，但没有可继续推进的 action_required 链路`;
}

function dispatchActionRequiredRequest(
  state: GraphTaskState,
  decisionAgentId: string,
  request: GraphActionRequiredRequest,
  options: {
    consumePendingRequest: boolean;
  },
): GraphRoutingDecision {
  const preparedDispatch = prepareActionRequiredDispatch(
    state,
    decisionAgentId,
    request,
  );
  if (preparedDispatch.dispatchTargetIds.length === 0 && preparedDispatch.firstLoopLimitDecision) {
    return resolveActionRequiredLoopLimitTransition(
      state,
      decisionAgentId,
      preparedDispatch.limitedTargetIds[0]!,
      preparedDispatch.firstLoopLimitDecision,
      request,
    );
  }
  if (preparedDispatch.dispatchTargetIds.length === 0) {
    state.taskStatus = "failed";
    return {
      type: "failed",
      errorMessage: buildMissingActionRequiredTargetsError(decisionAgentId),
    };
  }
  if (options.consumePendingRequest) {
    delete state.pendingActionRequiredRequestsByAgent[decisionAgentId];
  }
  return triggerActionRequiredRequestDownstream(
    state,
    decisionAgentId,
    request,
    new Set(preparedDispatch.dispatchTargetIds),
  );
}

function registerPendingRepairTargetsForDecision(
  state: GraphTaskState,
  decisionAgentId: string,
  repairTargetAgentIds: string[],
): void {
  const effectiveTopology = buildEffectiveTopology(state);
  for (const repairTargetAgentId of uniqueStringValues(repairTargetAgentIds)) {
    const restrictedRepairTargets = resolveRestrictedRepairTargetsForSource(
      effectiveTopology,
      repairTargetAgentId,
      [decisionAgentId],
    );
    if (restrictedRepairTargets.length > 0) {
      state.pendingHandoffRepairTargetsBySource[repairTargetAgentId] = restrictedRepairTargets;
    } else {
      delete state.pendingHandoffRepairTargetsBySource[repairTargetAgentId];
    }
  }
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

function resolveUniformActionRequiredTriggerForTargets(
  state: GraphTaskState,
  sourceAgentId: string,
  targetNames: string[],
): string {
  const effectiveTopology = buildEffectiveTopology(state);
  const triggers = [...new Set(
    effectiveTopology.edges
      .filter((edge) =>
        edge.source === sourceAgentId
        && targetNames.includes(edge.target)
        && resolveTriggerRoutingKindForSource(effectiveTopology, sourceAgentId, edge.trigger) === "action_required",
      )
      .map((edge) => edge.trigger),
  )];
  if (triggers.length !== 1) {
    throw new Error(
      `${sourceAgentId} 的 action_required 下游 trigger 不唯一，无法继续派发：${targetNames.join(", ")}`,
    );
  }
  return triggers[0]!;
}

function resumeBlockedAllCompletedDebateIfNeeded(
  state: GraphTaskState,
  result: Extract<GraphAgentResult, { routingKind: "labeled"; status: "completed" }>,
): GraphRoutingDecision | null {
  const pendingDebateTargets = resolvePendingAllCompletedDebateTargets(
    state,
    result.agentId,
    result.trigger,
  );
  if (pendingDebateTargets.length === 0) {
    return null;
  }
  const followUpTrigger = resolveUniformActionRequiredTriggerForTargets(
    state,
    result.agentId,
    pendingDebateTargets,
  );

  return triggerActionRequiredRequestDownstream(
    state,
    result.agentId,
    createActionRequiredRequest({
      sourceMessageId: result.messageId,
      trigger: followUpTrigger,
      targetAgentIds: pendingDebateTargets,
      opinion: result.opinion,
      agentContextContent: result.agentContextContent,
    }),
    new Set(pendingDebateTargets),
  );
}

function resolvePendingAllCompletedDebateTargets(
  state: GraphTaskState,
  sourceAgentId: string,
  trigger: string,
): string[] {
  const topology = buildEffectiveTopology(state);
  const actionRequiredTargets = getActionRequiredTargetsForSource(state, sourceAgentId).filter(
    (targetName) =>
      targetName !== sourceAgentId
      && getAgentStatusById(state, targetName) === "idle",
  );
  if (actionRequiredTargets.length === 0) {
    return [];
  }

  const sourceTemplateName = getTemplateNameForNode(topology, sourceAgentId);
  if (!sourceTemplateName) {
    return [];
  }

  const pendingTargetIds = new Set<string>();
  for (const edge of topology.edges.filter((candidate) =>
    candidate.source === sourceAgentId
    && candidate.trigger === trigger
  )) {
    const summaryTemplateName = getTemplateNameForNode(topology, edge.target);
    if (!summaryTemplateName) {
      continue;
    }

    for (const rule of topology.spawnRules ?? []) {
      if (rule.exitWhen !== "all_completed") {
        continue;
      }

      const matchingSummaryRoles = rule.spawnedAgents
        .filter((agent) => agent.templateName === summaryTemplateName)
        .map((agent) => agent.role);
      if (matchingSummaryRoles.length === 0) {
        continue;
      }

      for (const summaryRole of matchingSummaryRoles) {
        const requiredSourceTemplateNames = uniqueStringValues(
          rule.edges
            .filter((ruleEdge) => ruleEdge.trigger === edge.trigger && ruleEdge.targetRole === summaryRole)
            .map((ruleEdge) => getSpawnRuleTemplateNameForRole(rule, ruleEdge.sourceRole))
            .filter((value): value is string => Boolean(value)),
        );
        if (
          requiredSourceTemplateNames.length <= 1
          || !requiredSourceTemplateNames.includes(sourceTemplateName)
        ) {
          continue;
        }

        for (const actionRequiredTarget of actionRequiredTargets) {
          const actionRequiredTargetTemplateName = getTemplateNameForNode(topology, actionRequiredTarget);
          if (
            actionRequiredTargetTemplateName
            && requiredSourceTemplateNames.includes(actionRequiredTargetTemplateName)
          ) {
            pendingTargetIds.add(actionRequiredTarget);
          }
        }
      }
    }
  }

  return [...pendingTargetIds];
}

function getTemplateNameForNode(topology: TopologyRecord, nodeId: string): string | null {
  return topology.nodeRecords?.find((node) => node.id === nodeId)?.templateName ?? nodeId;
}

function getSpawnRuleTemplateNameForRole(
  rule: NonNullable<TopologyRecord["spawnRules"]>[number],
  role: string,
): string | null {
  return rule.spawnedAgents.find((agent) => agent.role === role)?.templateName ?? null;
}

function uniqueStringValues(values: string[]): string[] {
  return [...new Set(values)];
}

function getAgentStatusById(state: GraphTaskState, agentId: string): AgentStatus | undefined {
  return state.agentStatusesByName[agentId];
}

function resumeCompletedSpawnActivations(
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

  if (!isSpawnBundleReady(state, bundle)) {
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

  const aggregatedContent = finalizeSpawnActivationIfReady(state, activation.id, bundle.groupId);
  if (!aggregatedContent) {
    return {
      type: "finished",
      finishReason: "spawn_activation_pending",
    };
  }
  return triggerHandoffDownstream(state, activation.spawnNodeName, aggregatedContent);
}

function buildSpawnActivationContent(
  state: GraphTaskState,
  activationId: string,
): string {
  const bundles = state.spawnBundles.filter((bundle) => bundle.activationId === activationId);
  const sections = bundles.map((bundle) => {
    const terminalNodeIds = findBundleTerminalNodeIds(bundle);
    const outputs = terminalNodeIds
      .map((nodeId) => state.agentContextByName[nodeId]?.trim() ?? "")
      .filter(Boolean);
    if (outputs.length === 0) {
      throw new Error(`spawn activation ${activationId} 的条目 ${bundle.item.title} 缺少终局输出`);
    }
    const body = outputs.join("\n\n").trim();
    return [`[Item] ${bundle.item.title}`, body].filter(Boolean).join("\n");
  }).filter(Boolean);
  if (sections.length === 0) {
    throw new Error(`spawn activation ${activationId} 缺少可汇总的终局输出`);
  }
  return sections.join("\n\n").trim();
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

  if (!isSpawnBundleReady(state, bundle)) {
    return;
  }
  finalizeSpawnActivationIfReady(state, activation.id, bundle.groupId);
}

function finalizeSpawnActivationIfReady(
  state: GraphTaskState,
  activationId: string,
  completedBundleGroupId: string,
): string | null {
  const activation = state.spawnActivations.find((candidate) => candidate.id === activationId);
  if (!activation) {
    return null;
  }
  if (!activation.completedBundleGroupIds.includes(completedBundleGroupId)) {
    activation.completedBundleGroupIds.push(completedBundleGroupId);
  }
  if (activation.dispatched || activation.completedBundleGroupIds.length < activation.bundleGroupIds.length) {
    return null;
  }
  const aggregatedContent = buildSpawnActivationContent(state, activation.id);
  activation.dispatched = true;
  state.agentStatusesByName[activation.spawnNodeName] = "completed";
  state.agentContextByName[activation.spawnNodeName] = aggregatedContent;
  return aggregatedContent;
}

function findBundleTerminalNodeIds(bundle: GraphTaskState["spawnBundles"][number]): string[] {
  const bundleNodeIds = new Set(bundle.nodes.map((node) => node.id));
  const outgoing = new Set(
    bundle.edges
      .filter((edge) => bundleNodeIds.has(edge.source) && bundleNodeIds.has(edge.target))
      .map((edge) => edge.source),
  );
  return bundle.nodes
    .map((node) => node.id)
    .filter((nodeId) => !outgoing.has(nodeId));
}

function isSpawnBundleReady(
  state: GraphTaskState,
  bundle: GraphTaskState["spawnBundles"][number],
): boolean {
  if (bundle.nodes.every((node) => state.agentStatusesByName[node.id] === "completed")) {
    return true;
  }
  const bundleNodeIds = new Set(bundle.nodes.map((node) => node.id));
  return bundle.edges.some((edge) =>
    bundleNodeIds.has(edge.source)
    && !bundleNodeIds.has(edge.target)
    && state.agentStatusesByName[edge.source] === "completed",
  );
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
  trigger: string,
): ActionRequiredLoopLimitDecision | null {
  const maxTriggerRounds = getActionRequiredEdgeLoopLimit(
    buildEffectiveTopology(state),
    sourceAgentId,
    targetAgentId,
    trigger,
  );
  const edgeKey = buildActionRequiredLoopEdgeKey(sourceAgentId, targetAgentId, trigger);
  const nextCount = (state.actionRequiredLoopCountByEdge[edgeKey] ?? 0) + 1;
  state.actionRequiredLoopCountByEdge[edgeKey] = nextCount;
  if (nextCount <= maxTriggerRounds) {
    return null;
  }

  const normalizedMaxTriggerRounds = maxTriggerRounds || DEFAULT_ACTION_REQUIRED_MAX_ROUNDS;
  return {
    errorMessage: `${sourceAgentId} -> ${targetAgentId} 已连续交流 ${normalizedMaxTriggerRounds} 次，任务已结束`,
    maxTriggerRounds: normalizedMaxTriggerRounds,
  };
}

function buildActionRequiredLoopEdgeKey(sourceAgentId: string, targetAgentId: string, trigger: string): string {
  return `${sourceAgentId}->${targetAgentId}->${trigger}`;
}

function clearActionRequiredLoopCountsForDecisionAgent(state: GraphTaskState, decisionAgentId: string): void {
  for (const edgeKey of Object.keys(state.actionRequiredLoopCountByEdge)) {
    if (edgeKey.startsWith(`${decisionAgentId}->`)) {
      delete state.actionRequiredLoopCountByEdge[edgeKey];
    }
  }
}

function resolveActionRequiredLoopLimitTransition(
  state: GraphTaskState,
  decisionAgentId: string,
  repairTargetAgentId: string,
  loopLimitDecision: ActionRequiredLoopLimitDecision,
  decisionRequest: GraphActionRequiredRequest,
): GraphRoutingDecision {
  state.agentStatusesByName[decisionAgentId] = "failed";
  delete state.pendingActionRequiredRequestsByAgent[decisionAgentId];

  const nextDecisionAgentId = findNextPendingRepairDecisionAgent(
    state,
    repairTargetAgentId,
    new Set([decisionAgentId]),
  );
  if (nextDecisionAgentId) {
    const storedDecision = requirePendingActionRequiredRequest(state, nextDecisionAgentId);
    return dispatchActionRequiredRequest(state, nextDecisionAgentId, storedDecision, {
      consumePendingRequest: true,
    });
  }

  const loopLimitEscalationTrigger = resolveLoopLimitEscalationTrigger(
    state,
    decisionAgentId,
    repairTargetAgentId,
  );
  if (loopLimitEscalationTrigger.kind === "none") {
    state.taskStatus = "failed";
    return {
      type: "failed",
      errorMessage: loopLimitDecision.errorMessage,
    };
  }

  const loopLimitEscalationDecision = triggerLabeledDownstream(
    state,
    decisionAgentId,
    decisionRequest.sourceMessageId,
    buildActionRequiredLoopLimitEscalationForwardContent({
      decisionAgentId,
      decisionRequest,
    }),
    buildActionRequiredLoopLimitEscalationDisplayContent({
      decisionAgentId,
      repairTargetAgentId,
      maxTriggerRounds: loopLimitDecision.maxTriggerRounds,
    }),
    loopLimitEscalationTrigger.trigger,
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

function resolveLoopLimitEscalationTrigger(
  state: GraphTaskState,
  decisionAgentId: string,
  repairTargetAgentId: string,
): {
  kind: "labeled";
  trigger: string;
} | {
  kind: "none";
} {
  const topology = buildEffectiveTopology(state);
  const candidateTriggers = new Set<string>();
  for (const edge of topology.edges) {
    if (
      edge.source === decisionAgentId
      && edge.target !== repairTargetAgentId
      && edge.trigger !== DEFAULT_TOPOLOGY_TRIGGER
      && resolveTriggerRoutingKindForSource(topology, decisionAgentId, edge.trigger) === "labeled"
    ) {
      candidateTriggers.add(edge.trigger);
    }
  }
  for (const edge of topology.langgraph?.end?.incoming ?? []) {
    if (
      edge.source === decisionAgentId
      && edge.trigger !== DEFAULT_TOPOLOGY_TRIGGER
      && resolveTriggerRoutingKindForSource(topology, decisionAgentId, edge.trigger) === "labeled"
    ) {
      candidateTriggers.add(edge.trigger);
    }
  }
  if (candidateTriggers.size === 1) {
    return {
      kind: "labeled",
      trigger: [...candidateTriggers][0]!,
    };
  }
  if (candidateTriggers.size > 1) {
    throw new Error(
      `${decisionAgentId} 在回流超限后存在多个可升级 trigger，无法唯一决定：${[...candidateTriggers].join(" / ")}`,
    );
  }
  return {
    kind: "none",
  };
}

function buildActionRequiredLoopLimitEscalationForwardContent(input: {
  decisionAgentId: string;
  decisionRequest: GraphActionRequiredRequest;
}): string {
  return resolveRequiredActionRequiredDisplayContent(input.decisionAgentId, input.decisionRequest);
}

function buildActionRequiredLoopLimitEscalationDisplayContent(input: {
  decisionAgentId: string;
  repairTargetAgentId: string;
  maxTriggerRounds: number;
}): string {
  return `${input.decisionAgentId} -> ${input.repairTargetAgentId} 已连续交流 ${input.maxTriggerRounds} 次`;
}

function findNextPendingRepairDecisionAgent(
  state: GraphTaskState,
  repairTargetAgentId: string,
  excludedDecisionAgentIds: ReadonlySet<string>,
): string | null {
  const effectiveTopology = buildEffectiveTopology(state);
  for (const edge of effectiveTopology.edges) {
    if (
      isActionRequiredTopologyTrigger(edge.trigger, edge.maxTriggerRounds)
      && edge.target === repairTargetAgentId
      && !excludedDecisionAgentIds.has(edge.source)
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
  result: Pick<GraphAgentResult, "agentId" | "signalDone" | "decisionAgent" | "routingKind" | "trigger">,
): boolean {
  const endNode = state.topology.langgraph?.end;
  const endSources = endNode?.sources ?? [];
  if (!endSources.includes(result.agentId)) {
    return false;
  }
  const incoming = (endNode?.incoming ?? []).filter((edge) => edge.source === result.agentId);
  if (incoming.length === 0) {
    return false;
  }
  if (!incoming.some((edge) => endTriggerMatchesResult(edge, result))) {
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
  edge: { trigger: string },
  result: Pick<GraphAgentResult, "decisionAgent" | "routingKind" | "trigger">,
): boolean {
  const edgeTrigger = normalizeTopologyEdgeTrigger(edge.trigger);
  if (isDefaultTopologyTrigger(edgeTrigger)) {
    return !result.decisionAgent;
  }
  return result.decisionAgent
    && result.routingKind === "labeled"
    && result.trigger === edgeTrigger;
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
