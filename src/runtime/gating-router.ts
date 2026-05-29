import {
  getTriggerEdgeLoopLimit,
  getGroupRules,
  isTriggeredAgentRouting,
  isDefaultTopologyTrigger,
  normalizeTopologyEdgeTrigger,
  resolveTriggerRoutingKindForSource,
  type AgentRouting,
  type AgentStatus,
  type TopologyFlowEndIncoming,
  type TopologyRecord,
} from "@shared/types";

import {
  GatingScheduler,
  type GatingAgentState,
  type GatingDispatchPlan,
} from "./gating-scheduler";
import {
  applySchedulerRuntimeToGraphState,
  cloneGraphTaskState,
  graphStateToSchedulerRuntime,
  type GraphTaskState,
} from "./gating-state";
import { materializeRuntimeGroupAgentsForItems } from "./gating-group";
import {
  buildEffectiveTopology,
  ensureRuntimeAgentStatuses,
  getGroupRuleEntryRuntimeNodeIds,
  getGroupRuleIdForNode,
  getNextGroupSequence,
  isGroupNode,
  resolveSourceTemplateName,
} from "./runtime-topology-graph";

type HandoffOptions =
  | {
      kind: "all_targets";
      advanceSourceRound: boolean;
    }
  | {
      kind: "restricted";
      restrictTargets: Set<string>;
      advanceSourceRound: boolean;
    };

interface GraphRawDispatchJob {
  agentId: string;
  sourceContent: string;
  displayContent: string;
  kind: "raw";
}

interface GraphTransferDispatchJob {
  agentId: string;
  sourceAgentId: string;
  sourceContent: string;
  displayContent: string;
  kind: "transfer";
}

interface GraphTriggeredDispatchJob {
  agentId: string;
  sourceAgentId: string;
  sourceMessageId: string;
  sourceContent: string;
  displayContent: string;
  kind: "dispatch";
}

type GraphDispatchJob =
  | GraphRawDispatchJob
  | GraphTransferDispatchJob
  | GraphTriggeredDispatchJob;

type GraphDispatchBatchSource =
  | {
      kind: "user";
    }
  | {
      kind: "agent";
      agentId: string;
    };

interface GraphDispatchBatchBase {
  // 2026-05-29: 用户要求调度批次只接受单一 routing 联合语义，禁止回退为 routingKind + trigger 双字段组合。
  routing: Extract<AgentRouting, { kind: "default" | "triggered" }>;
  source: GraphDispatchBatchSource;
  sourceContent: string;
  displayContent: string;
  jobs: GraphDispatchJob[];
  triggerTargets: string[];
}

export type GraphDispatchBatch = GraphDispatchBatchBase;

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

type GroupActivationResult =
  | {
      kind: "activated";
      content: string;
    }
  | {
      kind: "not_ready";
    };

interface GraphAgentResultBase {
  agentId: string;
  messageId: string;
  decisionAgent: boolean;
  agentStatus: AgentStatus;
  agentContextContent: string;
  forwardedAgentMessage: string;
  signalDone: boolean;
}

export type GraphAgentResult =
  | (GraphAgentResultBase & {
      status: "failed";
      routing: Extract<AgentRouting, { kind: "invalid" }>;
      errorMessage: string;
    })
  | (GraphAgentResultBase & {
      status: "completed";
      routing: AgentRouting;
    });

export function createUserDispatchDecision(
  state: GraphTaskState,
  input: {
    targetAgentId: string;
    content: string;
  },
): GraphRoutingDecision {
  if (isGroupNode(state, input.targetAgentId)) {
    try {
      const entryTargets = materializeGroupNodeTargets(
        state,
        input.targetAgentId,
        input.content,
        { kind: "user" },
      );
      if (entryTargets.length === 0) {
        return {
          type: "failed",
          errorMessage: `${input.targetAgentId} 未生成可执行的入口实例`,
        };
      }
      markAgentsScheduled(state, entryTargets);
      return {
        type: "execute_batch",
        batch: {
          routing: { kind: "default" },
          source: { kind: "user" },
          sourceContent: input.content,
          displayContent: input.content,
          triggerTargets: [...entryTargets],
          jobs: entryTargets.map((agentId) => ({
            agentId,
            sourceContent: input.content,
            displayContent: input.content,
            kind: "raw" as const,
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

  markAgentsScheduled(state, [input.targetAgentId]);
  return {
    type: "execute_batch",
    batch: {
      routing: { kind: "default" },
      source: { kind: "user" },
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
): "default" | "triggered" | "invalid" {
  switch (result.routing.kind) {
    case "invalid":
      return "invalid";
    case "default":
      return "default";
    case "triggered":
      return resolveTriggeredRouteKind(topology, result.agentId, result.routing.trigger);
  }
}

function resolveTriggeredRouteKind(
  topology: TopologyRecord,
  agentId: string,
  trigger: string,
): "triggered" | "invalid" {
  const routeKind = resolveTriggerRoutingKindForSource(topology, agentId, trigger);
  if (routeKind.kind === "triggered") {
    return "triggered";
  }
  return "invalid";
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
  unsetScheduledAgent(nextState, result.agentId);
  nextState.agentStatusesByName[result.agentId] = result.agentStatus;
  nextState.agentContextByName[result.agentId] = result.agentContextContent;
  nextState.forwardedAgentMessageByName[result.agentId] = result.forwardedAgentMessage;
  nextState.taskStatus = "running";
  nextState.finishReason = "running";

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

  if (resolveGraphAgentResultTriggerRouteKind(buildEffectiveTopology(nextState), result) === "invalid") {
    nextState.taskStatus = "failed";
    return {
      state: nextState,
      decision: {
        type: "failed",
        errorMessage: `${result.agentId} 返回了无效判定结果`,
      },
    };
  }

  const primaryDecision = isTriggeredAgentRouting(result.routing)
    ? triggerTriggeredDownstream(
        nextState,
        result.agentId,
        result.messageId,
        result.agentContextContent,
        result.agentContextContent,
        result.routing.trigger,
        new Set<string>(),
      )
    : triggerHandoffDownstream(nextState, result.agentId, result.agentContextContent);
  if (primaryDecision.type === "execute_batch") {
    markCompletedGroupActivationAsDispatchedIfReady(nextState, result.agentId);
    return { state: nextState, decision: primaryDecision };
  }
  if (primaryDecision.type === "failed") {
    nextState.taskStatus = "failed";
    return { state: nextState, decision: primaryDecision };
  }
  if (primaryDecision.type === "finished" && primaryDecision.finishReason === "end_edge_triggered") {
    return { state: nextState, decision: primaryDecision };
  }

  const groupFollowUpDecision = resumeCompletedGroupActivations(nextState, result.agentId);
  if (groupFollowUpDecision.type === "execute_batch") {
    return { state: nextState, decision: groupFollowUpDecision };
  }
  if (groupFollowUpDecision.type === "failed") {
    nextState.taskStatus = "failed";
    return { state: nextState, decision: groupFollowUpDecision };
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

function triggerHandoffDownstream(
  state: GraphTaskState,
  sourceAgentId: string,
  sourceContent: string,
  options: HandoffOptions = { kind: "all_targets", advanceSourceRound: true },
): GraphRoutingDecision {
  const runtime = graphStateToSchedulerRuntime(state);
  const scheduler = new GatingScheduler(buildEffectiveTopology(state), runtime);
  const plan = scheduler.planHandoffDispatch(
    sourceAgentId,
    sourceContent,
    buildGatingAgentStates(state),
    buildHandoffDispatchOptions(options),
  );
  applySchedulerRuntimeToGraphState(state, runtime);
  delete state.activeHandoffBatchBySource[sourceAgentId];

  let nextPlan: GatingDispatchPlan;
  try {
    nextPlan = materializeGroupTargetsInPlan(state, plan, sourceContent);
  } catch (error) {
    return {
      type: "failed",
      errorMessage: error instanceof Error ? error.message : `${sourceAgentId} 下游 group 展开失败`,
    };
  }
  return createTransferBatchDecision(state, nextPlan);
}

function buildHandoffDispatchOptions(options: HandoffOptions) {
  if (options.kind === "restricted") {
    return {
      restrictTargets: options.restrictTargets,
      advanceSourceRound: options.advanceSourceRound,
    };
  }
  return {
    advanceSourceRound: options.advanceSourceRound,
  };
}

function triggerTriggeredDownstream(
  state: GraphTaskState,
  sourceAgentId: string,
  sourceMessageId: string,
  sourceContent: string,
  displayContent: string,
  trigger: string,
  attemptedTriggers: ReadonlySet<string>,
): GraphRoutingDecision {
  const runtime = graphStateToSchedulerRuntime(state);
  const scheduler = new GatingScheduler(buildEffectiveTopology(state), runtime);
  const plan = scheduler.planTriggeredDispatch(
    sourceAgentId,
    sourceContent,
    buildGatingAgentStates(state),
    {
      restrictTargets: new Set(getTriggeredTargetsForSource(state, sourceAgentId, trigger)),
      trigger,
    },
  );

  if (plan.triggerTargets.length > 0) {
    const effectiveTopology = buildEffectiveTopology(state);
    for (const targetAgentId of plan.triggerTargets) {
      const loopLimitDecision = enforceTriggeredLoopLimit(
        state,
        effectiveTopology,
        sourceAgentId,
        targetAgentId,
        trigger,
      );
      if (loopLimitDecision.kind === "failed") {
        const nextAttemptedTriggers = new Set([...attemptedTriggers, trigger]);
        const escalation = resolveTriggeredLoopEscalation(
          effectiveTopology,
          sourceAgentId,
          trigger,
          nextAttemptedTriggers,
        );
        if (escalation.kind === "triggered") {
          return triggerTriggeredDownstream(
            state,
            sourceAgentId,
            sourceMessageId,
            sourceContent,
            buildTriggeredLoopEscalationDisplayContent(
              sourceAgentId,
              targetAgentId,
              loopLimitDecision.maxTriggerRounds,
            ),
            escalation.trigger,
            nextAttemptedTriggers,
          );
        }
        if (escalation.kind === "end") {
          delete state.activeHandoffBatchBySource[sourceAgentId];
          state.taskStatus = "finished";
          state.finishReason = "end_edge_triggered";
          return {
            type: "finished",
            finishReason: "end_edge_triggered",
          };
        }
        state.taskStatus = "failed";
        return {
          type: "failed",
          errorMessage: loopLimitDecision.errorMessage,
        };
      }
    }
  }

  applySchedulerRuntimeToGraphState(state, runtime);
  delete state.activeHandoffBatchBySource[sourceAgentId];

  let nextPlan: GatingDispatchPlan;
  try {
    nextPlan = materializeGroupTargetsInPlan(state, plan, sourceContent);
  } catch (error) {
    return {
      type: "failed",
      errorMessage: error instanceof Error ? error.message : `${sourceAgentId} 下游 group 展开失败`,
    };
  }
  return createTriggeredBatchDecision(
    state,
    nextPlan,
    sourceMessageId,
    trigger,
    displayContent,
  );
}

function createTransferBatchDecision(
  state: GraphTaskState,
  plan: GatingDispatchPlan,
): GraphRoutingDecision {
  return createExecuteBatchDecision({
    state,
    plan,
    routing: { kind: "default" },
    displayContent: plan.sourceContent,
    createJob: (targetName, sourceAgentId, sourceContent, displayContent) => ({
      agentId: targetName,
      sourceAgentId,
      sourceContent,
      displayContent,
      kind: "transfer" as const,
    }),
  });
}

function createTriggeredBatchDecision(
  state: GraphTaskState,
  plan: GatingDispatchPlan,
  sourceMessageId: string,
  trigger: string,
  displayContent: string,
): GraphRoutingDecision {
  return createExecuteBatchDecision({
    state,
    plan,
    routing: { kind: "triggered", trigger },
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

type ExecuteBatchDecisionInputBase = {
  state: GraphTaskState;
  plan: GatingDispatchPlan;
  displayContent: string;
  createJob: (
    targetName: string,
    sourceAgentId: string,
    sourceContent: string,
    displayContent: string,
  ) => GraphDispatchJob;
};

type ExecuteBatchDecisionInput =
  | (ExecuteBatchDecisionInputBase & {
      routing: Extract<AgentRouting, { kind: "default" }>;
    })
  | (ExecuteBatchDecisionInputBase & {
      routing: Extract<AgentRouting, { kind: "triggered" }>;
    });

function createExecuteBatchDecision(input: ExecuteBatchDecisionInput): GraphRoutingDecision {
  const { plan } = input;
  if (plan.triggerTargets.length === 0) {
    return {
      type: "finished",
      finishReason: "no_dispatch_targets",
    };
  }
  const dispatchPlan = plan;
  const batchDisplayContent = input.displayContent || dispatchPlan.sourceContent;
  const dispatchTargets = [...dispatchPlan.readyTargets, ...dispatchPlan.queuedTargets];
  markAgentsScheduled(input.state, dispatchTargets);
  const batchBase = {
    source: { kind: "agent" as const, agentId: dispatchPlan.sourceAgentId },
    sourceContent: dispatchPlan.sourceContent,
    displayContent: batchDisplayContent,
    triggerTargets: [...dispatchTargets],
    jobs: dispatchTargets.map((targetName) =>
      input.createJob(targetName, dispatchPlan.sourceAgentId, dispatchPlan.sourceContent, batchDisplayContent)),
  };
  return {
    type: "execute_batch",
    batch: isTriggeredAgentRouting(input.routing)
      ? {
          ...batchBase,
          routing: input.routing,
        }
      : {
          ...batchBase,
          routing: input.routing,
        },
  };
}

function materializeGroupTargetsInPlan(
  state: GraphTaskState,
  planResult: GatingDispatchPlan,
  sourceContent: string,
): GatingDispatchPlan {
  const plan = planResult;
  const jobTargets = [...plan.readyTargets, ...plan.queuedTargets];
  if (jobTargets.length === 0) {
    return planResult;
  }

  const nextReadyTargets: string[] = [];
  const nextQueuedTargets: string[] = [];
  let changed = false;

  for (const targetName of jobTargets) {
    if (!isGroupNode(state, targetName)) {
      if (plan.readyTargets.includes(targetName)) {
        nextReadyTargets.push(targetName);
      } else {
        nextQueuedTargets.push(targetName);
      }
      continue;
    }

    changed = true;
    const entryTargets = materializeGroupNodeTargets(
      state,
      targetName,
      sourceContent,
      { kind: "agent", agentId: plan.sourceAgentId },
    );
    for (const entryTarget of entryTargets) {
      if (plan.readyTargets.includes(targetName)) {
        nextReadyTargets.push(entryTarget);
      } else {
        nextQueuedTargets.push(entryTarget);
      }
    }
  }

  if (!changed) {
    return planResult;
  }

  return {
    ...plan,
    triggerTargets: [...nextReadyTargets, ...nextQueuedTargets],
    readyTargets: nextReadyTargets,
    queuedTargets: nextQueuedTargets,
  };
}

function buildGroupActivationId(groupRuleId: string, sequence: number): string {
  return `activation:${buildGroupItemId(groupRuleId, sequence)}`;
}

function buildGroupActivationItemId(
  groupRuleId: string,
  sequence: number,
  index: number,
  total: number,
): string {
  const base = buildGroupItemId(groupRuleId, sequence);
  return total <= 1 ? base : `${base}-${index + 1}`;
}

function buildGroupItemTitle(sourceContent: string): string {
  const firstLine = sourceContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    throw new Error("group 上游输出缺少可展开的 finding 正文");
  }
  return firstLine;
}

type GroupMaterializeSource =
  | { kind: "user" }
  | { kind: "agent"; agentId: string };

function materializeGroupNodeTargets(
  state: GraphTaskState,
  targetName: string,
  sourceContent: string,
  source: GroupMaterializeSource,
): string[] {
  const groupRuleId = getGroupRuleIdForNode(state, targetName);
  const groupRule = getGroupRules(state.topology).find((candidate) => candidate.id === groupRuleId);
  if (!groupRule) {
    throw new Error(`group rule 不存在：${groupRuleId}`);
  }

  const sequence = getNextGroupSequence(state, groupRuleId);
  const activationId = buildGroupActivationId(groupRuleId, sequence);
  const items = [
    {
      id: buildGroupItemId(groupRuleId, sequence),
      title: buildGroupItemTitle(sourceContent),
    },
  ].map((item, index, itemsList) => ({
    ...item,
    id: buildGroupActivationItemId(groupRuleId, sequence, index, itemsList.length),
  }));
  const sourceRuntimeTemplateName = source.kind === "agent"
    ? resolveSourceTemplateName(state, source.agentId)
    : "";
  const reportRuntimeNodeId = (
    source.kind === "agent"
    && groupRule.report !== false
    && groupRule.report.templateName === sourceRuntimeTemplateName
  )
    ? source.agentId
    : undefined;

  const bundles = materializeRuntimeGroupAgentsForItems({
    state,
    groupRuleId,
    activationId,
    items,
    ...(source.kind === "agent"
      ? {
          sourceRuntimeNodeId: source.agentId,
          sourceRuntimeTemplateName,
          ...(reportRuntimeNodeId ? { reportRuntimeNodeId } : {}),
        }
      : {}),
  });
  state.groupActivations.push({
    id: activationId,
    groupNodeName: targetName,
    groupRuleId,
    sourceContent,
    bundleGroupIds: bundles.map((bundle) => bundle.groupId),
    completedBundleGroupIds: [],
    dispatched: false,
  });

  return bundles.flatMap((bundle) =>
    getGroupRuleEntryRuntimeNodeIds(state, bundle.groupId, groupRuleId)
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
        && edge.trigger === trigger
        && !isCompletedGroupEntryRuntimeTarget(state, edge.target, sourceAgentId)
      )
      .map((edge) => edge.target),
  )];
}

function isCompletedGroupEntryRuntimeTarget(
  state: GraphTaskState,
  targetAgentId: string,
  sourceAgentId: string,
): boolean {
  const runtimeNode = state.runtimeNodes.find((node) => node.id === targetAgentId);
  if (!runtimeNode || runtimeNode.sourceNodeId !== sourceAgentId) {
    return false;
  }
  const activation = state.groupActivations.find((candidate) =>
    candidate.bundleGroupIds.includes(runtimeNode.groupId)
  );
  return Boolean(activation && activation.dispatched);
}

function resumeCompletedGroupActivations(
  state: GraphTaskState,
  completedAgentId: string,
): GraphRoutingDecision {
  const bundle = state.groupBundles.find((candidate) =>
    candidate.nodes.some((node) => node.id === completedAgentId)
  );
  if (!bundle) {
    return {
      type: "finished",
      finishReason: "no_completed_group_activation",
    };
  }

  if (!isGroupBundleReady(state, bundle)) {
    return {
      type: "finished",
      finishReason: "group_bundle_pending",
    };
  }

  const activation = state.groupActivations.find((candidate) => candidate.id === bundle.activationId);
  if (!activation) {
    return {
      type: "finished",
      finishReason: "group_activation_missing",
    };
  }

  const activationResult = finalizeGroupActivationIfReady(state, activation.id, bundle.groupId);
  if (activationResult.kind === "not_ready") {
    return {
      type: "finished",
      finishReason: "group_activation_pending",
    };
  }
  return triggerHandoffDownstream(state, activation.groupNodeName, activationResult.content);
}

function buildGroupActivationContent(
  state: GraphTaskState,
  activationId: string,
): string {
  const bundles = state.groupBundles.filter((bundle) => bundle.activationId === activationId);
  const sections = bundles.map((bundle) => {
    const terminalNodeIds = findBundleTerminalNodeIds(bundle);
    const outputs = terminalNodeIds
      .map((nodeId) => resolveAgentContextContent(state, nodeId).trim())
      .filter(Boolean);
    if (outputs.length === 0) {
      throw new Error(`group activation ${activationId} 的条目 ${bundle.item.title} 缺少终局输出`);
    }
    const body = outputs.join("\n\n").trim();
    return [`[Item] ${bundle.item.title}`, body].filter(Boolean).join("\n");
  }).filter(Boolean);
  if (sections.length === 0) {
    throw new Error(`group activation ${activationId} 缺少可汇总的终局输出`);
  }
  return sections.join("\n\n").trim();
}

function resolveAgentContextContent(state: GraphTaskState, agentId: string): string {
  const content = state.agentContextByName[agentId];
  if (content) {
    return content;
  }
  return "";
}

function markCompletedGroupActivationAsDispatchedIfReady(
  state: GraphTaskState,
  completedAgentId: string,
): void {
  const bundle = state.groupBundles.find((candidate) =>
    candidate.nodes.some((node) => node.id === completedAgentId)
  );
  if (!bundle) {
    return;
  }

  const activation = state.groupActivations.find((candidate) => candidate.id === bundle.activationId);
  if (!activation || activation.dispatched || !isGroupBundleReady(state, bundle)) {
    return;
  }
  finalizeGroupActivationIfReady(state, activation.id, bundle.groupId);
}

function finalizeGroupActivationIfReady(
  state: GraphTaskState,
  activationId: string,
  completedBundleGroupId: string,
): GroupActivationResult {
  const activation = state.groupActivations.find((candidate) => candidate.id === activationId);
  if (!activation) {
    return { kind: "not_ready" };
  }
  if (!activation.completedBundleGroupIds.includes(completedBundleGroupId)) {
    activation.completedBundleGroupIds.push(completedBundleGroupId);
  }
  if (activation.dispatched || activation.completedBundleGroupIds.length < activation.bundleGroupIds.length) {
    return { kind: "not_ready" };
  }
  const aggregatedContent = buildGroupActivationContent(state, activation.id);
  activation.dispatched = true;
  state.agentStatusesByName[activation.groupNodeName] = "completed";
  state.agentContextByName[activation.groupNodeName] = aggregatedContent;
  return { kind: "activated", content: aggregatedContent };
}

function findBundleTerminalNodeIds(bundle: GraphTaskState["groupBundles"][number]): string[] {
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

function isGroupBundleReady(
  state: GraphTaskState,
  bundle: GraphTaskState["groupBundles"][number],
): boolean {
  if (bundle.nodes.every((node) => state.agentStatusesByName[node.id] === "completed")) {
    return true;
  }
  const bundleNodeIds = new Set(bundle.nodes.map((node) => node.id));
  return bundle.edges.some((edge) =>
    bundleNodeIds.has(edge.source)
    && !bundleNodeIds.has(edge.target)
    && state.agentStatusesByName[edge.source] === "completed"
  );
}

function buildGatingAgentStates(state: GraphTaskState): GatingAgentState[] {
  return buildEffectiveTopology(state).nodes.map((id) => ({
    id,
    status: resolveAgentStatus(state, id),
  }));
}

function resolveAgentStatus(state: GraphTaskState, agentId: string): AgentStatus {
  const status = state.agentStatusesByName[agentId];
  if (status) {
    return status;
  }
  return "idle";
}

function buildTriggeredLoopEdgeKey(sourceAgentId: string, targetAgentId: string, trigger: string): string {
  return `${sourceAgentId}->${targetAgentId}->${trigger}`;
}

type TriggerLoopLimitDecision =
  | { kind: "allowed" }
  | {
      kind: "failed";
      errorMessage: string;
      maxTriggerRounds: number;
    };

function enforceTriggeredLoopLimit(
  state: GraphTaskState,
  topology: TopologyRecord,
  sourceAgentId: string,
  targetAgentId: string,
  trigger: string,
): TriggerLoopLimitDecision {
  const maxTriggerRounds = getTriggerEdgeLoopLimit(
    topology,
    sourceAgentId,
    targetAgentId,
    trigger,
  );
  if (maxTriggerRounds === -1) {
    return { kind: "allowed" };
  }
  const edgeKey = buildTriggeredLoopEdgeKey(sourceAgentId, targetAgentId, trigger);
  const nextCount = resolveTriggerLoopCount(state, edgeKey) + 1;
  if (nextCount > maxTriggerRounds) {
    return {
      kind: "failed",
      errorMessage: `${sourceAgentId} -> ${targetAgentId} 已连续交流 ${maxTriggerRounds} 次，任务已结束`,
      maxTriggerRounds,
    };
  }
  state.triggerLoopCountByEdge[edgeKey] = nextCount;
  return { kind: "allowed" };
}

function resolveTriggerLoopCount(state: GraphTaskState, edgeKey: string): number {
  const count = state.triggerLoopCountByEdge[edgeKey];
  if (count) {
    return count;
  }
  return 0;
}

type TriggerLoopEscalation =
  | {
      kind: "triggered";
      trigger: string;
    }
  | {
      kind: "end";
      trigger: string;
    }
  | {
      kind: "none";
    };

function resolveTriggeredLoopEscalation(
  topology: TopologyRecord,
  sourceAgentId: string,
  currentTrigger: string,
  attemptedTriggers: ReadonlySet<string>,
): TriggerLoopEscalation {
  const edgeCandidates = topology.edges
    .filter((edge) =>
      edge.source === sourceAgentId
      && !isDefaultTopologyTrigger(normalizeTopologyEdgeTrigger(edge.trigger))
      && normalizeTopologyEdgeTrigger(edge.trigger) !== currentTrigger
      && !attemptedTriggers.has(normalizeTopologyEdgeTrigger(edge.trigger))
      && resolveTriggerRoutingKindForSource(topology, sourceAgentId, edge.trigger).kind === "triggered"
    )
    .map((edge) => ({
      kind: "triggered" as const,
      trigger: normalizeTopologyEdgeTrigger(edge.trigger),
    }));
  const endCandidates = getTopologyEndIncoming(topology)
    .filter((edge) =>
      edge.source === sourceAgentId
      && !isDefaultTopologyTrigger(normalizeTopologyEdgeTrigger(edge.trigger))
      && normalizeTopologyEdgeTrigger(edge.trigger) !== currentTrigger
      && !attemptedTriggers.has(normalizeTopologyEdgeTrigger(edge.trigger))
      && resolveTriggerRoutingKindForSource(topology, sourceAgentId, edge.trigger).kind === "triggered"
    )
    .map((edge) => ({
      kind: "end" as const,
      trigger: normalizeTopologyEdgeTrigger(edge.trigger),
    }));
  const candidateMap = new Map<string, TriggerLoopEscalation>();
  for (const candidate of [...edgeCandidates, ...endCandidates]) {
    candidateMap.set(`${candidate.kind}:${candidate.trigger}`, candidate);
  }
  const candidates = [...candidateMap.values()];

  if (candidates.length === 0) {
    return { kind: "none" };
  }
  if (candidates.length > 1) {
    throw new Error(
      `${sourceAgentId} 在回流超限后存在多个可升级 trigger，无法唯一决定：${candidates.map((candidate) => candidate.kind === "none" ? "none" : `${candidate.kind}:${candidate.trigger}`).join(" / ")}`,
    );
  }
  return requireSingleTriggerLoopEscalation(candidates, sourceAgentId);
}

function requireSingleTriggerLoopEscalation(
  candidates: TriggerLoopEscalation[],
  sourceAgentId: string,
): TriggerLoopEscalation {
  const candidate = candidates[0];
  if (!candidate) {
    throw new Error(`${sourceAgentId} 没有可用的超限转派 trigger`);
  }
  return candidate;
}

function getTopologyEndIncoming(topology: TopologyRecord): TopologyFlowEndIncoming[] {
  return topology.flow.end.incoming;
}

function buildTriggeredLoopEscalationDisplayContent(
  sourceAgentId: string,
  targetAgentId: string,
  maxTriggerRounds: number,
): string {
  return `${sourceAgentId} -> ${targetAgentId} 已连续交流 ${maxTriggerRounds} 次`;
}

function shouldFinishGraphTask(state: GraphTaskState): boolean {
  if (state.groupActivations.some((activation) => !activation.dispatched)) {
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
  result: GraphAgentResult,
): boolean {
  const incoming = getTopologyEndIncoming(state.topology).filter((edge) => edge.source === result.agentId);
  if (incoming.length === 0) {
    return false;
  }
  if (!incoming.some((edge) => endTriggerMatchesResult(edge, result))) {
    return false;
  }
  if (state.groupActivations.some((activation) => !activation.dispatched)) {
    return false;
  }
  return state.runningAgents.length === 0 && state.queuedAgents.length === 0;
}

function endTriggerMatchesResult(
  edge: { trigger: string },
  result: GraphAgentResult,
): boolean {
  const edgeTrigger = normalizeTopologyEdgeTrigger(edge.trigger);
  if (isDefaultTopologyTrigger(edgeTrigger)) {
    return !result.decisionAgent;
  }
  return result.decisionAgent
    && isTriggeredAgentRouting(result.routing)
    && result.routing.trigger === edgeTrigger;
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

function markAgentsScheduled(state: GraphTaskState, agentIds: string[]): void {
  const topology = buildEffectiveTopology(state);
  for (const agentId of agentIds) {
    for (const edge of topology.edges) {
      if (edge.source !== agentId) {
        continue;
      }
      delete state.lastSignatureByAgent[edge.target];
    }
    if (!state.runningAgents.includes(agentId)) {
      state.runningAgents.push(agentId);
    }
    state.agentStatusesByName[agentId] = "running";
  }
}

function unsetScheduledAgent(state: GraphTaskState, agentId: string): void {
  state.runningAgents = state.runningAgents.filter((current) => current !== agentId);
  state.queuedAgents = state.queuedAgents.filter((current) => current !== agentId);
}

function buildGroupItemId(groupRuleId: string, sequence: number): string {
  return `${groupRuleId}-${String(sequence).padStart(4, "0")}`;
}
