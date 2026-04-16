import { getTopologyEdgeId, type TopologyEdge, type TopologyRecord } from "@shared/types";

export interface SchedulerAgentState {
  name: string;
  status: "idle" | "running" | "completed" | "failed" | "needs_revision";
}

export interface SourceRevisionState {
  currentRevision: number;
  reviewerPassRevision: Map<string, number>;
}

export interface AssociationDispatchBatchState {
  sourceAgentId: string;
  sourceContent: string;
  targets: string[];
  nextTargetIndex: number;
  pendingTarget: string | null;
  sourceRevision: number;
  failedTargets: string[];
}

export interface SchedulerRuntimeState {
  completedEdges: Set<string>;
  edgeTriggerVersion: Map<string, number>;
  lastSignatureByAgent: Map<string, string>;
  runningAgents: Set<string>;
  queuedAgents: Set<string>;
  sourceRevisionStateByAgent: Map<string, SourceRevisionState>;
  activeAssociationBatchBySource: Map<string, AssociationDispatchBatchState>;
}

export interface SchedulerDispatchPlan {
  sourceAgentId: string;
  sourceContent: string;
  displayTargets: string[];
  triggerTargets: string[];
  readyTargets: string[];
  queuedTargets: string[];
}

export interface SchedulerBatchContinuation {
  matchedBatch: boolean;
  sourceAgentId: string;
  sourceContent: string;
  nextTargetToDispatch: string | null;
  repairReviewerAgentId: string | null;
  redispatchTargets: string[];
}

export function createSchedulerRuntimeState(): SchedulerRuntimeState {
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

export class OrchestratorScheduler {
  constructor(
    private readonly topology: TopologyRecord,
    private readonly runtime: SchedulerRuntimeState,
  ) {}

  invalidateDownstreamTriggerSignatures(agentName: string) {
    const downstreamTargets = this.getOutgoingEdges(agentName, "association")
      .concat(this.getOutgoingEdges(agentName, "review_pass"))
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
    agentStates: SchedulerAgentState[],
    options: {
      excludeTargets?: Set<string>;
      restrictTargets?: Set<string>;
      advanceSourceRevision?: boolean;
    } = {},
  ): SchedulerDispatchPlan | null {
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

    const batch: AssociationDispatchBatchState = {
      sourceAgentId,
      sourceContent,
      targets: targetNames,
      nextTargetIndex: 0,
      pendingTarget: null,
      sourceRevision: sourceState.currentRevision,
      failedTargets: [],
    };

    const firstTarget = this.claimNextBatchTarget(batch, completed, agentStates);
    if (!firstTarget) {
      return null;
    }

    this.runtime.activeAssociationBatchBySource.set(sourceAgentId, batch);
    if (this.runtime.runningAgents.has(firstTarget)) {
      this.runtime.queuedAgents.add(firstTarget);
    }

    return {
      sourceAgentId,
      sourceContent,
      displayTargets: targetNames,
      triggerTargets: [...targetNames],
      readyTargets: this.runtime.runningAgents.has(firstTarget) ? [] : [firstTarget],
      queuedTargets: this.runtime.runningAgents.has(firstTarget) ? [firstTarget] : [],
    };
  }

  planReviewPassDispatch(
    sourceAgentId: string,
    sourceContent: string,
    agentStates: SchedulerAgentState[],
  ): SchedulerDispatchPlan | null {
    const outgoing = this.getOutgoingEdges(sourceAgentId, "review_pass");
    const completed = new Set(this.runtime.completedEdges);

    for (const edge of outgoing) {
      const edgeId = getTopologyEdgeId(edge);
      completed.add(edgeId);
      this.runtime.completedEdges.add(edgeId);
      this.runtime.edgeTriggerVersion.set(edgeId, (this.runtime.edgeTriggerVersion.get(edgeId) ?? 0) + 1);
    }

    const readyTargets: string[] = [];
    for (const edge of outgoing) {
      if (this.canScheduleTarget(completed, edge.target, agentStates)) {
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
    outcome: "pass" | "fail",
    agentStates: SchedulerAgentState[],
  ): SchedulerBatchContinuation | null {
    const completed = new Set(this.runtime.completedEdges);
    for (const [sourceAgentId, batch] of this.runtime.activeAssociationBatchBySource.entries()) {
      if (batch.pendingTarget !== responderAgentId) {
        continue;
      }

      const sourceState = this.getOrCreateSourceRevisionState(sourceAgentId);
      if (outcome === "pass") {
        sourceState.reviewerPassRevision.set(responderAgentId, batch.sourceRevision);
      } else if (!batch.failedTargets.includes(responderAgentId)) {
        batch.failedTargets.push(responderAgentId);
      }
      batch.pendingTarget = null;

      const nextTarget = this.claimNextBatchTarget(batch, completed, agentStates);
      if (nextTarget) {
        if (this.runtime.runningAgents.has(nextTarget)) {
          this.runtime.queuedAgents.add(nextTarget);
        }
        return {
          matchedBatch: true,
          sourceAgentId,
          sourceContent: batch.sourceContent,
          nextTargetToDispatch: nextTarget,
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
          nextTargetToDispatch: null,
          repairReviewerAgentId: batch.failedTargets[0] ?? null,
          redispatchTargets: [],
        };
      }

      if (batch.targets.length === 1) {
        const staleTargets = this.getAssociationTargets(sourceAgentId).filter(
          (targetName) => sourceState.reviewerPassRevision.get(targetName) !== batch.sourceRevision,
        );
        return {
          matchedBatch: true,
          sourceAgentId,
          sourceContent: batch.sourceContent,
          nextTargetToDispatch: null,
          repairReviewerAgentId: null,
          redispatchTargets: staleTargets,
        };
      }

      return {
        matchedBatch: true,
        sourceAgentId,
        sourceContent: batch.sourceContent,
        nextTargetToDispatch: null,
        repairReviewerAgentId: null,
        redispatchTargets: [],
      };
    }

    return null;
  }

  hasSatisfiedIncomingAssociation(agentName: string): boolean {
    const incomingEdges = this.getIncomingEdges(agentName, "association")
      .concat(this.getIncomingEdges(agentName, "review_pass"));
    return incomingEdges.every((edge) => this.runtime.completedEdges.has(getTopologyEdgeId(edge)));
  }

  hasSatisfiedOutgoingAssociation(agentName: string): boolean {
    const outgoingEdges = this.getOutgoingEdges(agentName, "association")
      .concat(this.getOutgoingEdges(agentName, "review_pass"));
    return outgoingEdges.every((edge) => this.runtime.completedEdges.has(getTopologyEdgeId(edge)));
  }

  private claimNextBatchTarget(
    batch: AssociationDispatchBatchState,
    completedEdges: Set<string>,
    agentStates: SchedulerAgentState[],
  ): string | null {
    const nextTarget = batch.targets[batch.nextTargetIndex];
    if (!nextTarget) {
      return null;
    }
    if (!this.canScheduleTarget(completedEdges, nextTarget, agentStates)) {
      return null;
    }

    batch.pendingTarget = nextTarget;
    batch.nextTargetIndex += 1;
    this.runtime.lastSignatureByAgent.set(
      nextTarget,
      this.buildTriggerSignature(completedEdges, nextTarget),
    );
    return nextTarget;
  }

  private getOrCreateSourceRevisionState(sourceAgentId: string): SourceRevisionState {
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

  private canScheduleTarget(
    completedEdges: Set<string>,
    targetName: string,
    agentStates: SchedulerAgentState[],
  ): boolean {
    const agent = agentStates.find((item) => item.name === targetName);
    if (!agent) {
      return false;
    }

    const incomingSuccessEdges = this.getIncomingEdges(targetName, "association")
      .concat(this.getIncomingEdges(targetName, "review_pass"));
    if (incomingSuccessEdges.some((edge) => !completedEdges.has(getTopologyEdgeId(edge)))) {
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
          (edge.triggerOn === "association" || edge.triggerOn === "review_pass") &&
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
