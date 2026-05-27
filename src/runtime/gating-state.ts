import type {
  AgentStatus,
  RuntimeTopologyEdge,
  RuntimeTopologyNode,
  GroupActivationRecord,
  GroupBundleInstantiation,
  TaskStatus,
  TopologyRecord,
} from "@shared/types";
import { getTopologyNodeRecords } from "@shared/types";

export interface GatingSourceRoundState {
  currentRound: number;
  decisionPassRound: Map<string, number>;
}

export interface GatingHandoffDispatchBatchState {
  dispatchKind: "handoff" | "triggered";
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
  dispatchKind: "handoff" | "triggered";
  sourceAgentId: string;
  sourceContent: string;
  targets: string[];
  pendingTargets: string[];
  respondedTargets: string[];
  sourceRound: number;
  failedTargets: string[];
}

export interface GraphTaskState {
  topology: TopologyRecord;
  runtimeNodes: RuntimeTopologyNode[];
  runtimeEdges: RuntimeTopologyEdge[];
  groupBundles: GroupBundleInstantiation[];
  groupActivations: GroupActivationRecord[];
  taskStatus: TaskStatus;
  finishReason: string;
  agentStatusesByName: Record<string, AgentStatus>;
  agentContextByName: Record<string, string>;
  forwardedAgentMessageByName: Record<string, string>;
  completedEdges: string[];
  edgeTriggerVersion: Record<string, number>;
  lastSignatureByAgent: Record<string, string>;
  runningAgents: string[];
  queuedAgents: string[];
  sourceRoundStateByAgent: Record<string, GraphSourceRoundState>;
  activeHandoffBatchBySource: Record<string, GraphHandoffBatchState>;
  triggerLoopCountByEdge: Record<string, number>;
  groupSequenceByRule: Record<string, number>;
  hasForwardedInitialTask: boolean;
}

export function createEmptyGraphTaskState(input: {
  topology: TopologyRecord;
}): GraphTaskState {
  const topology = input.topology;
  return {
    topology,
    runtimeNodes: [],
    runtimeEdges: [],
    groupBundles: [],
    groupActivations: [],
    taskStatus: "pending",
    finishReason: "idle",
    agentStatusesByName: Object.fromEntries(topology.nodes.map((name) => [name, "idle"])),
    agentContextByName: {},
    forwardedAgentMessageByName: {},
    completedEdges: [],
    edgeTriggerVersion: {},
    lastSignatureByAgent: {},
    runningAgents: [],
    queuedAgents: [],
    sourceRoundStateByAgent: {},
    activeHandoffBatchBySource: {},
    triggerLoopCountByEdge: {},
    groupSequenceByRule: {},
    hasForwardedInitialTask: false,
  };
}

export function cloneGraphTaskState(state: GraphTaskState): GraphTaskState {
  const topology: TopologyRecord = {
    ...state.topology,
    nodes: [...state.topology.nodes],
    edges: state.topology.edges.map((edge) => ({ ...edge })),
    flow: {
      start: {
        id: state.topology.flow.start.id,
        targets: [...state.topology.flow.start.targets],
      },
      end: {
        id: state.topology.flow.end.id,
        sources: [...state.topology.flow.end.sources],
        incoming: state.topology.flow.end.incoming.map((edge) => ({ ...edge })),
      },
    },
    nodeRecords: getTopologyNodeRecords(state.topology).map((node) => ({ ...node })),
    ...(state.topology.groupRules
      ? {
          groupRules: state.topology.groupRules.map((rule) => ({
            ...rule,
            members: rule.members.map((agent) => ({ ...agent })),
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
    groupBundles: state.groupBundles.map((bundle) => ({
      ...bundle,
      item: { ...bundle.item },
      nodes: bundle.nodes.map((node) => ({ ...node })),
      edges: bundle.edges.map((edge) => ({ ...edge })),
    })),
    groupActivations: state.groupActivations.map((activation) => ({
      ...activation,
      bundleGroupIds: [...activation.bundleGroupIds],
      completedBundleGroupIds: [...activation.completedBundleGroupIds],
    })),
    agentStatusesByName: { ...state.agentStatusesByName },
    agentContextByName: { ...state.agentContextByName },
    forwardedAgentMessageByName: { ...state.forwardedAgentMessageByName },
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
    triggerLoopCountByEdge: { ...state.triggerLoopCountByEdge },
    groupSequenceByRule: { ...state.groupSequenceByRule },
    hasForwardedInitialTask: state.hasForwardedInitialTask,
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
