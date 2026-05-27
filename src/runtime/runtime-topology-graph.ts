import {
  getTopologyNodeRecords,
  type TopologyAgentNodeRecord,
  type TopologyGroupNodeRecord,
  type TopologyRecord,
} from "@shared/types";

import type { GraphTaskState } from "./gating-state";

export function buildEffectiveTopology(state: GraphTaskState): TopologyRecord {
  const runtimeNodeIds = state.runtimeNodes.map((node) => node.id);
  const staticNodeIds = state.topology.nodes.filter((name) => !runtimeNodeIds.includes(name));
  const topologyNodeRecords = getTopologyNodeRecords(state.topology);
  const runtimeNodeRecords = state.runtimeNodes.map((node) => {
    const templateNode = topologyNodeRecords.find(
      (item) => item.id === node.templateName || item.templateName === node.templateName,
    );
      if (node.kind === "group") {
        const baseGroupNode =
          templateNode?.kind === "group"
          ? templateNode
          : ({
              id: node.templateName,
              kind: "group",
              templateName: node.templateName,
              initialMessageRouting: { mode: "inherit" as const },
              groupRuleId: node.groupRuleId,
            } satisfies TopologyGroupNodeRecord);
        const runtimeGroupNode: TopologyGroupNodeRecord = {
          id: node.id,
          kind: "group",
          templateName: node.templateName,
          initialMessageRouting: baseGroupNode.initialMessageRouting,
          groupRuleId: node.groupRuleId,
        };
        return runtimeGroupNode;
      }
    const baseAgentNode =
      templateNode?.kind === "agent"
        ? templateNode
        : ({
            id: node.templateName,
            kind: "agent",
            templateName: node.templateName,
            initialMessageRouting: { mode: "inherit" as const },
            prompt: "",
            writable: false,
          } satisfies TopologyAgentNodeRecord);
    const runtimeAgentNode: TopologyAgentNodeRecord = {
      id: node.id,
      kind: "agent",
      templateName: node.templateName,
      initialMessageRouting: baseAgentNode.initialMessageRouting,
      prompt: baseAgentNode.prompt,
      writable: baseAgentNode.writable,
    };
    return runtimeAgentNode;
  });

  return {
    ...state.topology,
    nodes: [...staticNodeIds, ...runtimeNodeIds],
    edges: [
      ...state.topology.edges.map((edge) => ({ ...edge })),
      ...state.runtimeEdges.map((edge) => ({ ...edge })),
    ],
    nodeRecords: [
      ...topologyNodeRecords.map((node) => ({ ...node })),
      ...runtimeNodeRecords,
    ],
  };
}

export function ensureRuntimeAgentStatuses(state: GraphTaskState): void {
  for (const nodeId of buildEffectiveTopology(state).nodes) {
    if (!state.agentStatusesByName[nodeId]) {
      state.agentStatusesByName[nodeId] = "idle";
    }
  }
}

export function isGroupNode(state: GraphTaskState, nodeId: string): boolean {
  const nodeRecords = getTopologyNodeRecords(buildEffectiveTopology(state));
  return nodeRecords.some((node) => node.id === nodeId && node.kind === "group");
}

export function getGroupRuleIdForNode(state: GraphTaskState, nodeId: string): string | null {
  const nodeRecords = getTopologyNodeRecords(buildEffectiveTopology(state));
  const groupNode = nodeRecords.find((node): node is TopologyGroupNodeRecord => node.id === nodeId && node.kind === "group");
  return groupNode ? groupNode.groupRuleId : null;
}

export function getGroupRuleEntryRuntimeNodeIds(state: GraphTaskState, groupId: string, groupRuleId: string): string[] {
  const rule = state.topology.groupRules?.find((candidate) => candidate.id === groupRuleId);
  if (!rule) {
    return [];
  }
  return state.runtimeNodes
    .filter((node) => node.groupId === groupId && node.role === rule.entryRole)
    .map((node) => node.id);
}

export function getRuntimeTemplateName(state: GraphTaskState, runtimeAgentId: string): string | null {
  return state.runtimeNodes.find((node) => node.id === runtimeAgentId)?.templateName ?? null;
}

export function getNextGroupSequence(state: GraphTaskState, groupRuleId: string): number {
  const next = (state.groupSequenceByRule[groupRuleId] ?? 0) + 1;
  state.groupSequenceByRule[groupRuleId] = next;
  return next;
}
