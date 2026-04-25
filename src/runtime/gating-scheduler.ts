import { getTopologyEdgeId, type TopologyEdge, type TopologyRecord } from "@shared/types";

import type {
  GatingHandoffDispatchBatchState,
  GatingSchedulerRuntimeState,
  GatingSourceRevisionState,
} from "./gating-state";

export interface GatingAgentState {
  id: string;
  status: "idle" | "running" | "completed" | "failed" | "continue";
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
  repairDecisionAgentId: string | null;
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
    activeHandoffBatchBySource: new Map(),
  };
}

export class GatingScheduler {
  constructor(
    private readonly topology: TopologyRecord,
    private readonly runtime: GatingSchedulerRuntimeState,
  ) {}

  invalidateDownstreamTriggerSignatures(agentId: string) {
    const downstreamTargets = this.getOutgoingEdges(agentId, "transfer")
      .concat(this.getOutgoingEdges(agentId, "complete"))
      .map((edge) => edge.target);

    for (const targetName of downstreamTargets) {
      this.runtime.lastSignatureByAgent.delete(targetName);
    }
  }

  markAgentRunning(agentId: string) {
    this.runtime.runningAgents.add(agentId);
  }

  markAgentSettled(agentId: string) {
    this.runtime.runningAgents.delete(agentId);
    this.runtime.queuedAgents.delete(agentId);
  }

  planHandoffDispatch(
    sourceAgentId: string,
    sourceContent: string,
    agentStates: GatingAgentState[],
    options: {
      excludeTargets?: Set<string>;
      restrictTargets?: Set<string>;
      advanceSourceRevision?: boolean;
    } = {},
  ): GatingDispatchPlan | null {
    const outgoing = this.getOutgoingEdges(sourceAgentId, "transfer");
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

    const batch: GatingHandoffDispatchBatchState = {
      dispatchKind: "handoff",
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

    this.runtime.activeHandoffBatchBySource.set(sourceAgentId, batch);

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
    const outgoing = this.getOutgoingEdges(sourceAgentId, "complete");
    const completed = new Set(this.runtime.completedEdges);

    for (const edge of outgoing) {
      const edgeId = getTopologyEdgeId(edge);
      completed.add(edgeId);
      this.runtime.completedEdges.add(edgeId);
      this.runtime.edgeTriggerVersion.set(edgeId, (this.runtime.edgeTriggerVersion.get(edgeId) ?? 0) + 1);
    }

    const readyTargets: string[] = [];
    for (const edge of outgoing) {
      if (this.canScheduleTarget(completed, edge.target, agentStates, "complete")) {
        readyTargets.push(edge.target);
        this.runtime.lastSignatureByAgent.set(
          edge.target,
          this.buildTriggerSignature(completed, edge.target),
        );
      }
    }

    if (readyTargets.length > 0) {
      const sourceState = this.getOrCreateSourceRevisionState(sourceAgentId);
      const batch: GatingHandoffDispatchBatchState = {
        dispatchKind: "approved",
        sourceAgentId,
        sourceContent,
        targets: [...readyTargets],
        pendingTargets: [...readyTargets],
        respondedTargets: [],
        sourceRevision: sourceState.currentRevision,
        failedTargets: [],
      };
      this.runtime.activeHandoffBatchBySource.set(sourceAgentId, batch);
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

  recordHandoffBatchResponse(
    responderAgentId: string,
    outcome: "complete" | "fail",
  ): GatingBatchContinuation | null {
    for (const [sourceAgentId, batch] of this.runtime.activeHandoffBatchBySource.entries()) {
      if (!batch.pendingTargets.includes(responderAgentId)) {
        continue;
      }

      const sourceState = this.getOrCreateSourceRevisionState(sourceAgentId);
      if (outcome === "complete") {
        sourceState.decisionPassRevision.set(responderAgentId, batch.sourceRevision);
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
          repairDecisionAgentId: null,
          redispatchTargets: [],
        };
      }

      this.runtime.activeHandoffBatchBySource.delete(sourceAgentId);
      if (batch.failedTargets.length > 0) {
        return {
          matchedBatch: true,
          sourceAgentId,
          sourceContent: batch.sourceContent,
          pendingTargets: [],
          repairDecisionAgentId: batch.targets.find((targetName) => batch.failedTargets.includes(targetName)) ?? null,
          redispatchTargets: [],
        };
      }

      if (batch.dispatchKind === "handoff" && batch.targets.length === 1) {
        const staleTargets = this.getHandoffTargetsForBatch(sourceAgentId, batch).filter(
          (targetName) => sourceState.decisionPassRevision.get(targetName) !== batch.sourceRevision,
        );
        return {
          matchedBatch: true,
          sourceAgentId,
          sourceContent: batch.sourceContent,
          pendingTargets: [],
          repairDecisionAgentId: null,
          redispatchTargets: staleTargets,
        };
      }

      return {
        matchedBatch: true,
        sourceAgentId,
        sourceContent: batch.sourceContent,
        pendingTargets: [],
        repairDecisionAgentId: null,
        redispatchTargets: [],
      };
    }

    return null;
  }

  hasSatisfiedIncomingHandoff(agentId: string): boolean {
    const incomingEdges = this.getIncomingEdges(agentId, "transfer")
      .concat(this.getIncomingEdges(agentId, "complete"));
    return incomingEdges.every((edge) => this.runtime.completedEdges.has(getTopologyEdgeId(edge)));
  }

  hasSatisfiedOutgoingHandoff(agentId: string): boolean {
    const outgoingEdges = this.getOutgoingEdges(agentId, "transfer")
      .concat(this.getOutgoingEdges(agentId, "complete"));
    return outgoingEdges.every((edge) => this.runtime.completedEdges.has(getTopologyEdgeId(edge)));
  }

  private claimBatchTargets(
    batch: GatingHandoffDispatchBatchState,
    completedEdges: Set<string>,
    agentStates: GatingAgentState[],
  ): {
    readyTargets: string[];
    queuedTargets: string[];
  } {
    const readyTargets: string[] = [];
    const queuedTargets: string[] = [];

    for (const targetName of batch.targets) {
      if (!this.canScheduleTarget(completedEdges, targetName, agentStates, "transfer")) {
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
        decisionPassRevision: new Map(),
      };
      this.runtime.sourceRevisionStateByAgent.set(sourceAgentId, state);
    }
    return state;
  }

  private getHandoffTargets(sourceAgentId: string): string[] {
    return this.uniqueTargetNames(this.getOutgoingEdges(sourceAgentId, "transfer"));
  }

  private getHandoffTargetsForBatch(
    sourceAgentId: string,
    batch: GatingHandoffDispatchBatchState,
  ): string[] {
    const outgoingTargets = this.getHandoffTargets(sourceAgentId);
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
    triggerKind: "transfer" | "complete",
  ): boolean {
    const agent = agentStates.find((item) => item.id === targetName);
    if (!agent) {
      return false;
    }

    const incomingHandoffEdges = this.getIncomingEdges(targetName, "transfer");
    if (incomingHandoffEdges.some((edge) => !this.isIncomingEdgeSatisfied(edge, completedEdges))) {
      return false;
    }

    const incomingApprovedEdges = this.getIncomingEdges(targetName, "complete");
    if (
      triggerKind === "transfer"
      && incomingApprovedEdges.some((edge) => !this.isIncomingEdgeSatisfied(edge, completedEdges))
    ) {
      return false;
    }
    if (
      triggerKind === "complete"
      && incomingApprovedEdges.length > 0
      && !incomingApprovedEdges.some((edge) => this.isIncomingEdgeSatisfied(edge, completedEdges))
    ) {
      return false;
    }

    const signature = this.buildTriggerSignature(completedEdges, targetName);
    if (
      this.runtime.lastSignatureByAgent.get(targetName) === signature &&
      agent.status !== "failed" &&
      agent.status !== "continue"
    ) {
      return false;
    }

    return true;
  }

  private isIncomingEdgeSatisfied(edge: TopologyEdge, completedEdges: Set<string>): boolean {
    if (completedEdges.has(getTopologyEdgeId(edge))) {
      return true;
    }

    return this.isSpawnReportEdgeSatisfiedByRuntimeReport(edge, completedEdges);
  }

  private isSpawnReportEdgeSatisfiedByRuntimeReport(edge: TopologyEdge, completedEdges: Set<string>): boolean {
    const spawnRule = (this.topology.spawnRules ?? []).find((rule) => {
      const spawnNodeName = rule.spawnNodeName
        || this.topology.nodeRecords?.find((node) => node.spawnRuleId === rule.id)?.id
        || "";
      return (
        spawnNodeName === edge.source
        && rule.reportToTemplateName === edge.target
        && (rule.reportToTriggerOn ?? "complete") === edge.triggerOn
      );
    });
    if (!spawnRule) {
      return false;
    }

    const terminalRoles = spawnRule.spawnedAgents
      .map((agent) => agent.role)
      .filter((role) => !spawnRule.edges.some((candidate) => candidate.sourceRole === role));
    const terminalTemplateNames = new Set(
      spawnRule.spawnedAgents
        .filter((agent) => terminalRoles.includes(agent.role))
        .map((agent) => agent.templateName),
    );
    if (terminalTemplateNames.size === 0) {
      return false;
    }

    return this.topology.edges.some((candidate) => {
      if (
        candidate.source === edge.source
        || candidate.target !== edge.target
        || candidate.triggerOn !== edge.triggerOn
        || !completedEdges.has(getTopologyEdgeId(candidate))
      ) {
        return false;
      }

      const sourceNode = this.topology.nodeRecords?.find((node) => node.id === candidate.source);
      return sourceNode ? terminalTemplateNames.has(sourceNode.templateName) : false;
    });
  }

  private buildTriggerSignature(completedEdges: Set<string>, targetName: string): string {
    const relevantEdgeIds = this.topology.edges
      .filter(
        (edge) =>
          edge.target === targetName &&
          (edge.triggerOn === "transfer" || edge.triggerOn === "complete") &&
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
