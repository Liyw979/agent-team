import { getTopologyEdgeId, type TopologyEdge, type TopologyRecord } from "@shared/types";

import type {
  GatingAssociationDispatchBatchState,
  GatingSchedulerRuntimeState,
  GatingSourceRevisionState,
} from "./gating-state";

export interface GatingAgentState {
  name: string;
  status: "idle" | "running" | "completed" | "failed" | "needs_revision";
}

export interface GatingDispatchPlan {
  sourceAgentId: string;
  sourceContent: string;
  displayTargets: string[];
  triggerTargets: string[];
  readyTargets: string[];
  queuedTargets: string[];
}

export interface GatingBatchContinuation {
  matchedBatch: boolean;
  sourceAgentId: string;
  sourceContent: string;
  pendingTargets: string[];
  repairReviewerAgentId: string | null;
  redispatchTargets: string[];
}

export function createGatingSchedulerRuntimeState(): GatingSchedulerRuntimeState {
  return {
    completedEdges: new Set(),
    edgeTriggerVersion: new Map(),
    lastSignatureByAgent: new Map(),
    runningAgents: new Set(),
    queuedAgents: new Set(),
    sourceRevisionStateByAgent: new Map(),
    activeAssociationBatchBySource: new Map(),
  };
}

export class GatingScheduler {
  constructor(
    private readonly topology: TopologyRecord,
    private readonly runtime: GatingSchedulerRuntimeState,
  ) {}

  invalidateDownstreamTriggerSignatures(agentName: string) {
    const downstreamTargets = this.getOutgoingEdges(agentName, "association")
      .concat(this.getOutgoingEdges(agentName, "approved"))
      .map((edge) => edge.target);

    for (const targetName of downstreamTargets) {
      this.runtime.lastSignatureByAgent.delete(targetName);
    }
  }

  markAgentRunning(agentName: string) {
    this.runtime.runningAgents.add(agentName);
  }

  markAgentSettled(agentName: string) {
    this.runtime.runningAgents.delete(agentName);
    this.runtime.queuedAgents.delete(agentName);
  }

  planAssociationDispatch(
    sourceAgentId: string,
    sourceContent: string,
    agentStates: GatingAgentState[],
    options: {
      excludeTargets?: Set<string>;
      restrictTargets?: Set<string>;
      advanceSourceRevision?: boolean;
    } = {},
  ): GatingDispatchPlan | null {
    const outgoing = this.getOutgoingEdges(sourceAgentId, "association");
    const excludeTargets = options.excludeTargets ?? new Set<string>();
    const restrictTargets = options.restrictTargets;
    const advanceSourceRevision = options.advanceSourceRevision ?? true;

    const selectedOutgoing = outgoing.filter(
      (edge) =>
        !excludeTargets.has(edge.target)
        && (!restrictTargets || restrictTargets.has(edge.target)),
    );
    if (selectedOutgoing.length === 0) {
      return null;
    }

    const completed = new Set(this.runtime.completedEdges);
    for (const edge of selectedOutgoing) {
      const edgeId = getTopologyEdgeId(edge);
      completed.add(edgeId);
      this.runtime.completedEdges.add(edgeId);
      this.runtime.edgeTriggerVersion.set(edgeId, (this.runtime.edgeTriggerVersion.get(edgeId) ?? 0) + 1);
    }

    const targetNames = this.uniqueTargetNames(selectedOutgoing);
    const sourceState = this.getOrCreateSourceRevisionState(sourceAgentId);
    if (advanceSourceRevision) {
      sourceState.currentRevision += 1;
    }

    const batch: GatingAssociationDispatchBatchState = {
      sourceAgentId,
      sourceContent,
      targets: targetNames,
      pendingTargets: [],
      respondedTargets: [],
      sourceRevision: sourceState.currentRevision,
      failedTargets: [],
    };

    const dispatchTargets = this.claimBatchTargets(batch, completed, agentStates);
    if (dispatchTargets.readyTargets.length === 0 && dispatchTargets.queuedTargets.length === 0) {
      return null;
    }

    this.runtime.activeAssociationBatchBySource.set(sourceAgentId, batch);

    return {
      sourceAgentId,
      sourceContent,
      displayTargets: targetNames,
      triggerTargets: [...targetNames],
      readyTargets: dispatchTargets.readyTargets,
      queuedTargets: dispatchTargets.queuedTargets,
    };
  }

  planApprovedDispatch(
    sourceAgentId: string,
    sourceContent: string,
    agentStates: GatingAgentState[],
  ): GatingDispatchPlan | null {
    const outgoing = this.getOutgoingEdges(sourceAgentId, "approved");
    const completed = new Set(this.runtime.completedEdges);

    for (const edge of outgoing) {
      const edgeId = getTopologyEdgeId(edge);
      completed.add(edgeId);
      this.runtime.completedEdges.add(edgeId);
      this.runtime.edgeTriggerVersion.set(edgeId, (this.runtime.edgeTriggerVersion.get(edgeId) ?? 0) + 1);
    }

    const readyTargets: string[] = [];
    for (const edge of outgoing) {
      if (this.canScheduleTarget(completed, edge.target, agentStates, "approved")) {
        readyTargets.push(edge.target);
        this.runtime.lastSignatureByAgent.set(
          edge.target,
          this.buildTriggerSignature(completed, edge.target),
        );
      }
    }

    return readyTargets.length > 0
      ? {
          sourceAgentId,
          sourceContent,
          displayTargets: [...readyTargets],
          triggerTargets: [...readyTargets],
          readyTargets: [...readyTargets],
          queuedTargets: [],
        }
      : null;
  }

  recordAssociationBatchResponse(
    responderAgentId: string,
    outcome: "approved" | "fail",
    agentStates: GatingAgentState[],
  ): GatingBatchContinuation | null {
    for (const [sourceAgentId, batch] of this.runtime.activeAssociationBatchBySource.entries()) {
      if (!batch.pendingTargets.includes(responderAgentId)) {
        continue;
      }

      const sourceState = this.getOrCreateSourceRevisionState(sourceAgentId);
      if (outcome === "approved") {
        sourceState.reviewerPassRevision.set(responderAgentId, batch.sourceRevision);
      } else if (!batch.failedTargets.includes(responderAgentId)) {
        batch.failedTargets.push(responderAgentId);
      }
      batch.pendingTargets = batch.pendingTargets.filter((targetName) => targetName !== responderAgentId);
      if (!batch.respondedTargets.includes(responderAgentId)) {
        batch.respondedTargets.push(responderAgentId);
      }

      if (batch.pendingTargets.length > 0) {
        return {
          matchedBatch: true,
          sourceAgentId,
          sourceContent: batch.sourceContent,
          pendingTargets: [...batch.pendingTargets],
          repairReviewerAgentId: null,
          redispatchTargets: [],
        };
      }

      this.runtime.activeAssociationBatchBySource.delete(sourceAgentId);
      if (batch.failedTargets.length > 0) {
        return {
          matchedBatch: true,
          sourceAgentId,
          sourceContent: batch.sourceContent,
          pendingTargets: [],
          repairReviewerAgentId: batch.targets.find((targetName) => batch.failedTargets.includes(targetName)) ?? null,
          redispatchTargets: [],
        };
      }

      if (batch.targets.length === 1) {
        const staleTargets = this.getAssociationTargetsForBatch(sourceAgentId, batch).filter(
          (targetName) => sourceState.reviewerPassRevision.get(targetName) !== batch.sourceRevision,
        );
        return {
          matchedBatch: true,
          sourceAgentId,
          sourceContent: batch.sourceContent,
          pendingTargets: [],
          repairReviewerAgentId: null,
          redispatchTargets: staleTargets,
        };
      }

      return {
        matchedBatch: true,
        sourceAgentId,
        sourceContent: batch.sourceContent,
        pendingTargets: [],
        repairReviewerAgentId: null,
        redispatchTargets: [],
      };
    }

    return null;
  }

  hasSatisfiedIncomingAssociation(agentName: string): boolean {
    const incomingEdges = this.getIncomingEdges(agentName, "association")
      .concat(this.getIncomingEdges(agentName, "approved"));
    return incomingEdges.every((edge) => this.runtime.completedEdges.has(getTopologyEdgeId(edge)));
  }

  hasSatisfiedOutgoingAssociation(agentName: string): boolean {
    const outgoingEdges = this.getOutgoingEdges(agentName, "association")
      .concat(this.getOutgoingEdges(agentName, "approved"));
    return outgoingEdges.every((edge) => this.runtime.completedEdges.has(getTopologyEdgeId(edge)));
  }

  private claimBatchTargets(
    batch: GatingAssociationDispatchBatchState,
    completedEdges: Set<string>,
    agentStates: GatingAgentState[],
  ): {
    readyTargets: string[];
    queuedTargets: string[];
  } {
    const readyTargets: string[] = [];
    const queuedTargets: string[] = [];

    for (const targetName of batch.targets) {
      if (!this.canScheduleTarget(completedEdges, targetName, agentStates, "association")) {
        continue;
      }

      this.runtime.lastSignatureByAgent.set(
        targetName,
        this.buildTriggerSignature(completedEdges, targetName),
      );
      if (!batch.pendingTargets.includes(targetName)) {
        batch.pendingTargets.push(targetName);
      }

      if (this.runtime.runningAgents.has(targetName)) {
        queuedTargets.push(targetName);
      } else {
        readyTargets.push(targetName);
      }
    }

    return {
      readyTargets,
      queuedTargets,
    };
  }

  private getOrCreateSourceRevisionState(sourceAgentId: string): GatingSourceRevisionState {
    let state = this.runtime.sourceRevisionStateByAgent.get(sourceAgentId);
    if (!state) {
      state = {
        currentRevision: 0,
        reviewerPassRevision: new Map(),
      };
      this.runtime.sourceRevisionStateByAgent.set(sourceAgentId, state);
    }
    return state;
  }

  private getAssociationTargets(sourceAgentId: string): string[] {
    return this.uniqueTargetNames(this.getOutgoingEdges(sourceAgentId, "association"));
  }

  private getAssociationTargetsForBatch(
    sourceAgentId: string,
    batch: GatingAssociationDispatchBatchState,
  ): string[] {
    const outgoingTargets = this.getAssociationTargets(sourceAgentId);
    if (outgoingTargets.length === 0) {
      return [];
    }

    const spawnNodeIds = new Set(
      (this.topology.nodeRecords ?? [])
        .filter((node) => node.kind === "spawn")
        .map((node) => node.id),
    );
    const hasSpawnTarget = outgoingTargets.some((targetName) => spawnNodeIds.has(targetName));
    if (!hasSpawnTarget) {
      return outgoingTargets;
    }

    return this.uniqueTargetNames(
      outgoingTargets.flatMap((targetName) => (
        spawnNodeIds.has(targetName) ? batch.targets : [targetName]
      )).map((target) => ({ target })),
    );
  }

  private canScheduleTarget(
    completedEdges: Set<string>,
    targetName: string,
    agentStates: GatingAgentState[],
    triggerKind: "association" | "approved",
  ): boolean {
    const agent = agentStates.find((item) => item.name === targetName);
    if (!agent) {
      return false;
    }

    const incomingAssociationEdges = this.getIncomingEdges(targetName, "association");
    if (incomingAssociationEdges.some((edge) => !completedEdges.has(getTopologyEdgeId(edge)))) {
      return false;
    }

    const incomingApprovedEdges = this.getIncomingEdges(targetName, "approved");
    if (
      triggerKind === "association"
      && incomingApprovedEdges.some((edge) => !completedEdges.has(getTopologyEdgeId(edge)))
    ) {
      return false;
    }
    if (
      triggerKind === "approved"
      && incomingApprovedEdges.length > 0
      && !incomingApprovedEdges.some((edge) => completedEdges.has(getTopologyEdgeId(edge)))
    ) {
      return false;
    }

    const signature = this.buildTriggerSignature(completedEdges, targetName);
    if (
      this.runtime.lastSignatureByAgent.get(targetName) === signature &&
      agent.status !== "failed" &&
      agent.status !== "needs_revision"
    ) {
      return false;
    }

    return true;
  }

  private buildTriggerSignature(completedEdges: Set<string>, targetName: string): string {
    const relevantEdgeIds = this.topology.edges
      .filter(
        (edge) =>
          edge.target === targetName &&
          (edge.triggerOn === "association" || edge.triggerOn === "approved") &&
          completedEdges.has(getTopologyEdgeId(edge)),
      )
      .map((edge) => {
        const edgeId = getTopologyEdgeId(edge);
        return `${edgeId}@${this.runtime.edgeTriggerVersion.get(edgeId) ?? 0}`;
      })
      .sort();
    return relevantEdgeIds.join("|") || `direct:${targetName}`;
  }

  private getOutgoingEdges(sourceAgentId: string, triggerOn: TopologyEdge["triggerOn"]): TopologyEdge[] {
    return this.topology.edges.filter((edge) => edge.source === sourceAgentId && edge.triggerOn === triggerOn);
  }

  private getIncomingEdges(targetAgentId: string, triggerOn: TopologyEdge["triggerOn"]): TopologyEdge[] {
    return this.topology.edges.filter((edge) => edge.target === targetAgentId && edge.triggerOn === triggerOn);
  }

  private uniqueTargetNames(edges: Array<Pick<TopologyEdge, "target">>): string[] {
    const targets: string[] = [];
    for (const edge of edges) {
      if (!targets.includes(edge.target)) {
        targets.push(edge.target);
      }
    }
    return targets;
  }
}
