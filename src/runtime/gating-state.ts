import type {
  AgentStatus,
  RuntimeTopologyEdge,
  RuntimeTopologyNode,
  SpawnActivationRecord,
  SpawnBundleInstantiation,
  TaskStatus,
  TopologyRecord,
} from "@shared/types";

export interface GraphActionRequiredRequest {
  sourceMessageId: string;
  opinion: string;
  agentContextContent: string;
}

export interface GatingSourceRoundState {
  currentRound: number;
  decisionPassRound: Map<string, number>;
}

export interface GatingHandoffDispatchBatchState {
  dispatchKind: "handoff" | "approved";
  sourceAgentId: string;
  sourceContent: string;
  targets: string[];
  pendingTargets: string[];
  respondedTargets: string[];
  sourceRound: number;
  failedTargets: string[];
}

export interface GatingSchedulerRuntimeState {
  completedEdges: Set<string>;
  edgeTriggerVersion: Map<string, number>;
  lastSignatureByAgent: Map<string, string>;
  runningAgents: Set<string>;
  queuedAgents: Set<string>;
  sourceRoundStateByAgent: Map<string, GatingSourceRoundState>;
  activeHandoffBatchBySource: Map<string, GatingHandoffDispatchBatchState>;
}

export interface GraphSourceRoundState {
  currentRound: number;
  decisionPassRound: Record<string, number>;
}

export interface GraphHandoffBatchState {
  dispatchKind: "handoff" | "approved";
  sourceAgentId: string;
  sourceContent: string;
  targets: string[];
  pendingTargets: string[];
  respondedTargets: string[];
  sourceRound: number;
  failedTargets: string[];
}

export interface GraphTaskState {
  taskId: string;
  topology: TopologyRecord;
  runtimeNodes: RuntimeTopologyNode[];
  runtimeEdges: RuntimeTopologyEdge[];
  spawnBundles: SpawnBundleInstantiation[];
  spawnActivations: SpawnActivationRecord[];
  taskStatus: TaskStatus;
  finishReason: string | null;
  agentStatusesByName: Record<string, AgentStatus>;
  agentContextByName: Record<string, string>;
  completedEdges: string[];
  edgeTriggerVersion: Record<string, number>;
  lastSignatureByAgent: Record<string, string>;
  runningAgents: string[];
  queuedAgents: string[];
  sourceRoundStateByAgent: Record<string, GraphSourceRoundState>;
  activeHandoffBatchBySource: Record<string, GraphHandoffBatchState>;
  pendingActionRequiredRequestsByAgent: Record<string, GraphActionRequiredRequest>;
  pendingHandoffRepairTargetsBySource: Record<string, string[]>;
  actionRequiredLoopCountByEdge: Record<string, number>;
  spawnSequenceByRule: Record<string, number>;
  hasForwardedInitialTask: boolean;
}

export function createEmptyGraphTaskState(input: {
  taskId: string;
  topology: TopologyRecord;
}): GraphTaskState {
  return {
    taskId: input.taskId,
    topology: input.topology,
    runtimeNodes: [],
    runtimeEdges: [],
    spawnBundles: [],
    spawnActivations: [],
    taskStatus: "pending",
    finishReason: null,
    agentStatusesByName: Object.fromEntries(input.topology.nodes.map((name) => [name, "idle"])),
    agentContextByName: {},
    completedEdges: [],
    edgeTriggerVersion: {},
    lastSignatureByAgent: {},
    runningAgents: [],
    queuedAgents: [],
    sourceRoundStateByAgent: {},
    activeHandoffBatchBySource: {},
    pendingActionRequiredRequestsByAgent: {},
    pendingHandoffRepairTargetsBySource: {},
    actionRequiredLoopCountByEdge: {},
    spawnSequenceByRule: {},
    hasForwardedInitialTask: false,
  };
}

export function cloneGraphTaskState(state: GraphTaskState): GraphTaskState {
  const topology: TopologyRecord = {
    ...state.topology,
    nodes: [...state.topology.nodes],
    edges: state.topology.edges.map((edge) => ({ ...edge })),
    ...(state.topology.langgraph
      ? {
          langgraph: {
            start: {
              id: state.topology.langgraph.start.id,
              targets: [...state.topology.langgraph.start.targets],
            },
            end: state.topology.langgraph.end
              ? {
                  id: state.topology.langgraph.end.id,
                  sources: [...state.topology.langgraph.end.sources],
                  ...(state.topology.langgraph.end.incoming
                    ? {
                        incoming: state.topology.langgraph.end.incoming.map((edge) => ({ ...edge })),
                      }
                    : {}),
                }
              : null,
          },
        }
      : {}),
    ...(state.topology.nodeRecords
      ? { nodeRecords: state.topology.nodeRecords.map((node) => ({ ...node })) }
      : {}),
    ...(state.topology.spawnRules
      ? {
          spawnRules: state.topology.spawnRules.map((rule) => ({
            ...rule,
            spawnedAgents: rule.spawnedAgents.map((agent) => ({ ...agent })),
            edges: rule.edges.map((edge) => ({ ...edge })),
          })),
        }
      : {}),
  };

  return {
    ...state,
    topology,
    runtimeNodes: state.runtimeNodes.map((node) => ({ ...node })),
    runtimeEdges: state.runtimeEdges.map((edge) => ({ ...edge })),
    spawnBundles: state.spawnBundles.map((bundle) => ({
      ...bundle,
      item: { ...bundle.item },
      nodes: bundle.nodes.map((node) => ({ ...node })),
      edges: bundle.edges.map((edge) => ({ ...edge })),
    })),
    spawnActivations: state.spawnActivations.map((activation) => ({
      ...activation,
      bundleGroupIds: [...activation.bundleGroupIds],
      completedBundleGroupIds: [...activation.completedBundleGroupIds],
    })),
    agentStatusesByName: { ...state.agentStatusesByName },
    agentContextByName: { ...state.agentContextByName },
    completedEdges: [...state.completedEdges],
    edgeTriggerVersion: { ...state.edgeTriggerVersion },
    lastSignatureByAgent: { ...state.lastSignatureByAgent },
    runningAgents: [...state.runningAgents],
    queuedAgents: [...state.queuedAgents],
    sourceRoundStateByAgent: Object.fromEntries(
      Object.entries(state.sourceRoundStateByAgent).map(([agentId, roundState]) => [
        agentId,
        {
          currentRound: roundState.currentRound,
          decisionPassRound: { ...roundState.decisionPassRound },
        },
      ]),
    ),
    activeHandoffBatchBySource: Object.fromEntries(
      Object.entries(state.activeHandoffBatchBySource).map(([sourceAgentId, batch]) => [
        sourceAgentId,
        {
          dispatchKind: batch.dispatchKind,
          sourceAgentId: batch.sourceAgentId,
          sourceContent: batch.sourceContent,
          targets: [...batch.targets],
          pendingTargets: [...batch.pendingTargets],
          respondedTargets: [...batch.respondedTargets],
          sourceRound: batch.sourceRound,
          failedTargets: [...batch.failedTargets],
        },
      ]),
    ),
    pendingActionRequiredRequestsByAgent: Object.fromEntries(
      Object.entries(state.pendingActionRequiredRequestsByAgent).map(([agentId, request]) => [
        agentId,
        {
          sourceMessageId: request.sourceMessageId,
          opinion: request.opinion,
          agentContextContent: request.agentContextContent,
        },
      ]),
    ),
    pendingHandoffRepairTargetsBySource: Object.fromEntries(
      Object.entries(state.pendingHandoffRepairTargetsBySource).map(([sourceAgentId, targets]) => [
        sourceAgentId,
        [...targets],
      ]),
    ),
    actionRequiredLoopCountByEdge: { ...state.actionRequiredLoopCountByEdge },
    spawnSequenceByRule: { ...state.spawnSequenceByRule },
  };
}

export function graphStateToSchedulerRuntime(state: GraphTaskState): GatingSchedulerRuntimeState {
  return {
    completedEdges: new Set(state.completedEdges),
    edgeTriggerVersion: new Map(Object.entries(state.edgeTriggerVersion)),
    lastSignatureByAgent: new Map(Object.entries(state.lastSignatureByAgent)),
    runningAgents: new Set(state.runningAgents),
    queuedAgents: new Set(state.queuedAgents),
    sourceRoundStateByAgent: new Map(
      Object.entries(state.sourceRoundStateByAgent).map(([agentId, roundState]) => [
        agentId,
        {
          currentRound: roundState.currentRound,
          decisionPassRound: new Map(Object.entries(roundState.decisionPassRound)),
        } satisfies GatingSourceRoundState,
      ]),
    ),
    activeHandoffBatchBySource: new Map(
      Object.entries(state.activeHandoffBatchBySource).map(([sourceAgentId, batch]) => [
        sourceAgentId,
        {
          dispatchKind: batch.dispatchKind,
          sourceAgentId: batch.sourceAgentId,
          sourceContent: batch.sourceContent,
          targets: [...batch.targets],
          pendingTargets: [...batch.pendingTargets],
          respondedTargets: [...batch.respondedTargets],
          sourceRound: batch.sourceRound,
          failedTargets: [...batch.failedTargets],
        } satisfies GatingHandoffDispatchBatchState,
      ]),
    ),
  };
}

export function applySchedulerRuntimeToGraphState(
  state: GraphTaskState,
  runtime: GatingSchedulerRuntimeState,
): GraphTaskState {
  state.completedEdges = [...runtime.completedEdges];
  state.edgeTriggerVersion = Object.fromEntries(runtime.edgeTriggerVersion.entries());
  state.lastSignatureByAgent = Object.fromEntries(runtime.lastSignatureByAgent.entries());
  state.runningAgents = [...runtime.runningAgents];
  state.queuedAgents = [...runtime.queuedAgents];
  state.sourceRoundStateByAgent = Object.fromEntries(
    [...runtime.sourceRoundStateByAgent.entries()].map(([agentId, roundState]) => [
      agentId,
      {
        currentRound: roundState.currentRound,
        decisionPassRound: Object.fromEntries(roundState.decisionPassRound.entries()),
      },
    ]),
  );
  state.activeHandoffBatchBySource = Object.fromEntries(
    [...runtime.activeHandoffBatchBySource.entries()].map(([sourceAgentId, batch]) => [
      sourceAgentId,
        {
          dispatchKind: batch.dispatchKind,
          sourceAgentId: batch.sourceAgentId,
          sourceContent: batch.sourceContent,
        targets: [...batch.targets],
        pendingTargets: [...batch.pendingTargets],
        respondedTargets: [...batch.respondedTargets],
        sourceRound: batch.sourceRound,
        failedTargets: [...batch.failedTargets],
      },
    ]),
  );
  return state;
}
