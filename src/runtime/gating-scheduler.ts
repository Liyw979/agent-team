import {
  DEFAULT_TOPOLOGY_TRIGGER,
  getTopologyEdgeId,
  getTopologyNodeRecords,
  resolveTriggerRoutingKindForSource,
  type TopologyEdge,
  type TopologyRecord,
} from "@shared/types";

import type {
  GatingHandoffDispatchBatchState,
  GatingSchedulerRuntimeState,
  GatingSourceRoundState,
} from "./gating-state";

export interface GatingAgentState {
  id: string;
  status: "idle" | "running" | "completed" | "failed";
}

export interface GatingDispatchPlan {
  sourceAgentId: string;
  sourceContent: string;
  /** Targets selected by topology routing before readiness is split into ready and queued. */
  triggerTargets: string[];
  /** Targets whose topology dependencies are satisfied and whose agent is not running. */
  readyTargets: string[];
  /** Targets whose topology dependencies are satisfied but whose agent is already running. */
  queuedTargets: string[];
}

export function createGatingSchedulerRuntimeState(): GatingSchedulerRuntimeState {
  return {
    completedEdges: new Set(),
    edgeTriggerVersion: new Map(),
    lastSignatureByAgent: new Map(),
    runningAgents: new Set(),
    queuedAgents: new Set(),
    sourceRoundStateByAgent: new Map(),
    activeHandoffBatchBySource: new Map(),
  };
}

export class GatingScheduler {
  constructor(
    private readonly topology: TopologyRecord,
    private readonly runtime: GatingSchedulerRuntimeState,
  ) {}

  invalidateDownstreamTriggerSignatures(agentId: string) {
    const downstreamTargets = this.topology.edges
      .filter((edge) => edge.source === agentId)
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
      advanceSourceRound?: boolean;
    } = {},
  ): GatingDispatchPlan | null {
    const outgoing = this.getOutgoingEdges(sourceAgentId, DEFAULT_TOPOLOGY_TRIGGER);
    const excludeTargets = options.excludeTargets ?? new Set<string>();
    const restrictTargets = options.restrictTargets;
    const advanceSourceRound = options.advanceSourceRound ?? true;

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
    const sourceState = this.getOrCreateSourceRoundState(sourceAgentId);
    if (advanceSourceRound) {
      sourceState.currentRound += 1;
    }

    const batch: GatingHandoffDispatchBatchState = {
      dispatchKind: "handoff",
      sourceAgentId,
      sourceContent,
      targets: targetNames,
      pendingTargets: [],
      respondedTargets: [],
      sourceRound: sourceState.currentRound,
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
      triggerTargets: [...targetNames],
      readyTargets: dispatchTargets.readyTargets,
      queuedTargets: dispatchTargets.queuedTargets,
    };
  }

  planTriggeredDispatch(
    sourceAgentId: string,
    sourceContent: string,
    agentStates: GatingAgentState[],
    options: {
      restrictTargets?: Set<string>;
      trigger: string;
    },
  ): GatingDispatchPlan | null {
    const restrictTargets = options.restrictTargets;
    const trigger = options.trigger;
    const outgoing = this.getOutgoingEdges(sourceAgentId, trigger).filter(
      (edge) => !restrictTargets || restrictTargets.has(edge.target),
    );
    const completed = new Set(this.runtime.completedEdges);

    for (const edge of outgoing) {
      const edgeId = getTopologyEdgeId(edge);
      completed.add(edgeId);
      this.runtime.completedEdges.add(edgeId);
      this.runtime.edgeTriggerVersion.set(edgeId, (this.runtime.edgeTriggerVersion.get(edgeId) ?? 0) + 1);
    }

    const readyTargets: string[] = [];
    for (const edge of outgoing) {
      if (this.canScheduleTarget(completed, edge.target, agentStates, trigger)) {
        readyTargets.push(edge.target);
        this.runtime.lastSignatureByAgent.set(
          edge.target,
          this.buildTriggerSignature(completed, edge.target),
        );
      }
    }

    if (readyTargets.length > 0) {
      const sourceState = this.getOrCreateSourceRoundState(sourceAgentId);
      const batch: GatingHandoffDispatchBatchState = {
        dispatchKind: "triggered",
        sourceAgentId,
        sourceContent,
        targets: [...readyTargets],
        pendingTargets: [...readyTargets],
        respondedTargets: [],
        sourceRound: sourceState.currentRound,
        failedTargets: [],
      };
      this.runtime.activeHandoffBatchBySource.set(sourceAgentId, batch);
    }

    return readyTargets.length > 0
      ? {
          sourceAgentId,
          sourceContent,
          triggerTargets: [...readyTargets],
          readyTargets: [...readyTargets],
          queuedTargets: [],
        }
      : null;
  }

  hasSatisfiedIncomingHandoff(agentId: string): boolean {
    const incomingEdges = this.topology.edges.filter((edge) => edge.target === agentId);
    return incomingEdges.every((edge) => this.runtime.completedEdges.has(getTopologyEdgeId(edge)));
  }

  hasSatisfiedOutgoingHandoff(agentId: string): boolean {
    const outgoingEdges = this.topology.edges.filter((edge) => edge.source === agentId);
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
      if (!this.canScheduleTarget(completedEdges, targetName, agentStates, DEFAULT_TOPOLOGY_TRIGGER)) {
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

  private getOrCreateSourceRoundState(sourceAgentId: string): GatingSourceRoundState {
    let state = this.runtime.sourceRoundStateByAgent.get(sourceAgentId);
    if (!state) {
      state = {
        currentRound: 0,
        decisionPassRound: new Map(),
      };
      this.runtime.sourceRoundStateByAgent.set(sourceAgentId, state);
    }
    return state;
  }

  private canScheduleTarget(
    completedEdges: Set<string>,
    targetName: string,
    agentStates: GatingAgentState[],
    triggerKind: string,
  ): boolean {
    const agent = agentStates.find((item) => item.id === targetName);
    if (!agent) {
      return false;
    }

    if (triggerKind === DEFAULT_TOPOLOGY_TRIGGER) {
      const incomingHandoffEdges = this.getIncomingEdges(targetName, DEFAULT_TOPOLOGY_TRIGGER);
      if (incomingHandoffEdges.some((edge) => !this.isIncomingEdgeSatisfied(edge, completedEdges))) {
        return false;
      }
    }

    const allIncomingTriggeredEdges = this.topology.edges.filter((edge) =>
      edge.target === targetName
      && resolveTriggerRoutingKindForSource(this.topology, edge.source, edge.trigger).kind === "triggered"
    );
    const incomingTriggeredEdges = triggerKind === DEFAULT_TOPOLOGY_TRIGGER
      ? []
      : this.topology.edges.filter((edge) =>
          edge.target === targetName
          && edge.trigger === triggerKind
        );
    if (
      triggerKind === DEFAULT_TOPOLOGY_TRIGGER
      && allIncomingTriggeredEdges.some((edge) =>
        this.hasSettledAgentState(edge.source, agentStates)
        && !this.isIncomingEdgeSatisfied(edge, completedEdges)
      )
    ) {
      return false;
    }
    if (
      triggerKind !== DEFAULT_TOPOLOGY_TRIGGER
      && incomingTriggeredEdges.length > 0
      && !this.hasSatisfiedTriggeredEdgesForTarget(incomingTriggeredEdges, completedEdges)
    ) {
      return false;
    }

    const signature = this.buildTriggerSignature(completedEdges, targetName);
    return !(this.runtime.lastSignatureByAgent.get(targetName) === signature &&
      agent.status !== "failed");


  }

  private hasSatisfiedTriggeredEdgesForTarget(
    incomingTriggeredEdges: TopologyEdge[],
    completedEdges: Set<string>,
  ): boolean {
    if (incomingTriggeredEdges.length === 0) {
      return true;
    }

    return incomingTriggeredEdges.some((edge) => this.isIncomingEdgeSatisfied(edge, completedEdges));
  }

  private hasSettledAgentState(agentId: string, agentStates: GatingAgentState[]): boolean {
    const agentState = agentStates.find((agent) => agent.id === agentId);
    if (!agentState) {
      return false;
    }
    return agentState.status !== "idle" && agentState.status !== "running";
  }

  private isIncomingEdgeSatisfied(edge: TopologyEdge, completedEdges: Set<string>): boolean {
    if (completedEdges.has(getTopologyEdgeId(edge))) {
      return true;
    }

    return this.isGroupReportEdgeSatisfiedByRuntimeReport(edge, completedEdges);
  }

  private isGroupReportEdgeSatisfiedByRuntimeReport(edge: TopologyEdge, completedEdges: Set<string>): boolean {
    const groupRule = this.topology.groupRules?.find((rule) => {
      const groupNodeName = rule.groupNodeName
        || getTopologyNodeRecords(this.topology).find((node) => node.kind === "group" && node.groupRuleId === rule.id)?.id
        || "";
      return (
        groupNodeName === edge.source
        && rule.report !== false
        && rule.report.templateName === edge.target
        && rule.report.trigger === edge.trigger
      );
    });
    if (!groupRule) {
      return false;
    }

    const terminalRoles = groupRule.members
      .map((agent) => agent.role)
      .filter((role) => !groupRule.edges.some((candidate) => candidate.sourceRole === role));
    const terminalTemplateNames = new Set(
      groupRule.members
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
        || candidate.trigger !== edge.trigger
        || !completedEdges.has(getTopologyEdgeId(candidate))
      ) {
        return false;
      }

      const sourceNode = getTopologyNodeRecords(this.topology).find((node) => node.id === candidate.source);
      return sourceNode ? terminalTemplateNames.has(sourceNode.templateName) : false;
    });
  }

  private buildTriggerSignature(completedEdges: Set<string>, targetName: string): string {
    const relevantEdgeIds = this.topology.edges
      .filter(
        (edge) =>
          edge.target === targetName &&
          completedEdges.has(getTopologyEdgeId(edge)),
      )
      .map((edge) => {
        const edgeId = getTopologyEdgeId(edge);
        return `${edgeId}@${this.runtime.edgeTriggerVersion.get(edgeId) ?? 0}`;
      })
      .sort();
    return relevantEdgeIds.join("|") || `direct:${targetName}`;
  }

  private getOutgoingEdges(sourceAgentId: string, trigger: TopologyEdge["trigger"]): TopologyEdge[] {
    return this.topology.edges.filter((edge) => edge.source === sourceAgentId && edge.trigger === trigger);
  }

  private getIncomingEdges(targetAgentId: string, trigger: TopologyEdge["trigger"]): TopologyEdge[] {
    return this.topology.edges.filter((edge) => edge.target === targetAgentId && edge.trigger === trigger);
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
