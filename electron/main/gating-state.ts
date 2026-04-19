import type { AgentStatus, TaskStatus, TopologyRecord } from "@shared/types";

export interface GraphRevisionRequest {
  opinion: string | null;
  agentContextContent: string;
}

export interface GatingSourceRevisionState {
  currentRevision: number;
  reviewerPassRevision: Map<string, number>;
}

export interface GatingAssociationDispatchBatchState {
  sourceAgentId: string;
  sourceContent: string;
  targets: string[];
  pendingTargets: string[];
  respondedTargets: string[];
  sourceRevision: number;
  failedTargets: string[];
}

export interface GatingSchedulerRuntimeState {
  completedEdges: Set<string>;
  edgeTriggerVersion: Map<string, number>;
  lastSignatureByAgent: Map<string, string>;
  runningAgents: Set<string>;
  queuedAgents: Set<string>;
  sourceRevisionStateByAgent: Map<string, GatingSourceRevisionState>;
  activeAssociationBatchBySource: Map<string, GatingAssociationDispatchBatchState>;
}

export interface GraphSourceRevisionState {
  currentRevision: number;
  reviewerPassRevision: Record<string, number>;
}

export interface GraphAssociationBatchState {
  sourceAgentId: string;
  sourceContent: string;
  targets: string[];
  pendingTargets: string[];
  respondedTargets: string[];
  sourceRevision: number;
  failedTargets: string[];
}

export interface GraphTaskState {
  taskId: string;
  projectId: string;
  topology: TopologyRecord;
  taskStatus: TaskStatus;
  waitingReason: string | null;
  agentStatusesByName: Record<string, AgentStatus>;
  completedEdges: string[];
  edgeTriggerVersion: Record<string, number>;
  lastSignatureByAgent: Record<string, string>;
  runningAgents: string[];
  queuedAgents: string[];
  sourceRevisionStateByAgent: Record<string, GraphSourceRevisionState>;
  activeAssociationBatchBySource: Record<string, GraphAssociationBatchState>;
  pendingRevisionRequestsByAgent: Record<string, GraphRevisionRequest>;
  pendingAssociationRepairTargetsBySource: Record<string, string[]>;
  needsRevisionLoopCountByEdge: Record<string, number>;
  hasForwardedInitialTask: boolean;
}

export function createEmptyGraphTaskState(input: {
  taskId: string;
  projectId: string;
  topology: TopologyRecord;
}): GraphTaskState {
  return {
    taskId: input.taskId,
    projectId: input.projectId,
    topology: input.topology,
    taskStatus: "pending",
    waitingReason: null,
    agentStatusesByName: Object.fromEntries(input.topology.nodes.map((name) => [name, "idle"])),
    completedEdges: [],
    edgeTriggerVersion: {},
    lastSignatureByAgent: {},
    runningAgents: [],
    queuedAgents: [],
    sourceRevisionStateByAgent: {},
    activeAssociationBatchBySource: {},
    pendingRevisionRequestsByAgent: {},
    pendingAssociationRepairTargetsBySource: {},
    needsRevisionLoopCountByEdge: {},
    hasForwardedInitialTask: false,
  };
}

export function cloneGraphTaskState(state: GraphTaskState): GraphTaskState {
  return {
    ...state,
    topology: {
      ...state.topology,
      nodes: [...state.topology.nodes],
      edges: state.topology.edges.map((edge) => ({ ...edge })),
    },
    agentStatusesByName: { ...state.agentStatusesByName },
    completedEdges: [...state.completedEdges],
    edgeTriggerVersion: { ...state.edgeTriggerVersion },
    lastSignatureByAgent: { ...state.lastSignatureByAgent },
    runningAgents: [...state.runningAgents],
    queuedAgents: [...state.queuedAgents],
    sourceRevisionStateByAgent: Object.fromEntries(
      Object.entries(state.sourceRevisionStateByAgent).map(([agentName, revisionState]) => [
        agentName,
        {
          currentRevision: revisionState.currentRevision,
          reviewerPassRevision: { ...revisionState.reviewerPassRevision },
        },
      ]),
    ),
    activeAssociationBatchBySource: Object.fromEntries(
      Object.entries(state.activeAssociationBatchBySource).map(([sourceAgentId, batch]) => [
        sourceAgentId,
        {
          sourceAgentId: batch.sourceAgentId,
          sourceContent: batch.sourceContent,
          targets: [...batch.targets],
          pendingTargets: [...batch.pendingTargets],
          respondedTargets: [...batch.respondedTargets],
          sourceRevision: batch.sourceRevision,
          failedTargets: [...batch.failedTargets],
        },
      ]),
    ),
    pendingRevisionRequestsByAgent: Object.fromEntries(
      Object.entries(state.pendingRevisionRequestsByAgent).map(([agentName, request]) => [
        agentName,
        {
          opinion: request.opinion,
          agentContextContent: request.agentContextContent,
        },
      ]),
    ),
    pendingAssociationRepairTargetsBySource: Object.fromEntries(
      Object.entries(state.pendingAssociationRepairTargetsBySource).map(([sourceAgentId, targets]) => [
        sourceAgentId,
        [...targets],
      ]),
    ),
    needsRevisionLoopCountByEdge: { ...state.needsRevisionLoopCountByEdge },
  };
}

export function graphStateToSchedulerRuntime(state: GraphTaskState): GatingSchedulerRuntimeState {
  return {
    completedEdges: new Set(state.completedEdges),
    edgeTriggerVersion: new Map(Object.entries(state.edgeTriggerVersion)),
    lastSignatureByAgent: new Map(Object.entries(state.lastSignatureByAgent)),
    runningAgents: new Set(state.runningAgents),
    queuedAgents: new Set(state.queuedAgents),
    sourceRevisionStateByAgent: new Map(
      Object.entries(state.sourceRevisionStateByAgent).map(([agentName, revisionState]) => [
        agentName,
        {
          currentRevision: revisionState.currentRevision,
          reviewerPassRevision: new Map(Object.entries(revisionState.reviewerPassRevision)),
        } satisfies GatingSourceRevisionState,
      ]),
    ),
    activeAssociationBatchBySource: new Map(
      Object.entries(state.activeAssociationBatchBySource).map(([sourceAgentId, batch]) => [
        sourceAgentId,
        {
          sourceAgentId: batch.sourceAgentId,
          sourceContent: batch.sourceContent,
          targets: [...batch.targets],
          pendingTargets: [...batch.pendingTargets],
          respondedTargets: [...batch.respondedTargets],
          sourceRevision: batch.sourceRevision,
          failedTargets: [...batch.failedTargets],
        } satisfies GatingAssociationDispatchBatchState,
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
  state.sourceRevisionStateByAgent = Object.fromEntries(
    [...runtime.sourceRevisionStateByAgent.entries()].map(([agentName, revisionState]) => [
      agentName,
      {
        currentRevision: revisionState.currentRevision,
        reviewerPassRevision: Object.fromEntries(revisionState.reviewerPassRevision.entries()),
      },
    ]),
  );
  state.activeAssociationBatchBySource = Object.fromEntries(
    [...runtime.activeAssociationBatchBySource.entries()].map(([sourceAgentId, batch]) => [
      sourceAgentId,
      {
        sourceAgentId: batch.sourceAgentId,
        sourceContent: batch.sourceContent,
        targets: [...batch.targets],
        pendingTargets: [...batch.pendingTargets],
        respondedTargets: [...batch.respondedTargets],
        sourceRevision: batch.sourceRevision,
        failedTargets: [...batch.failedTargets],
      },
    ]),
  );
  return state;
}
