import type { TopologyRecord } from "@shared/types";

import type { GraphTaskState } from "./gating-state";

export function buildEffectiveTopology(state: GraphTaskState): TopologyRecord {
  const runtimeNodeIds = state.runtimeNodes.map((node) => node.id);
  const declaredNodeIds = [
    ...state.topology.nodes,
    ...(state.topology.nodeRecords?.map((node) => node.id) ?? []),
  ].filter((name, index, array) => array.indexOf(name) === index);
  const staticNodeIds = declaredNodeIds.filter((name) => !runtimeNodeIds.includes(name));
  return {
    ...state.topology,
    nodes: [...staticNodeIds, ...runtimeNodeIds],
    edges: [
      ...state.topology.edges.map((edge) => ({ ...edge })),
      ...state.runtimeEdges.map((edge) => ({ ...edge })),
    ],
    nodeRecords: [
      ...(state.topology.nodeRecords?.map((node) => ({ ...node })) ?? []),
      ...state.runtimeNodes.map((node) => ({
        id: node.id,
        kind: "agent" as const,
        templateName: node.templateName,
      })),
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

export function isSpawnNode(state: GraphTaskState, nodeId: string): boolean {
  return state.topology.nodeRecords?.some((node) => node.id === nodeId && node.kind === "spawn") ?? false;
}

export function getSpawnRuleIdForNode(state: GraphTaskState, nodeId: string): string | null {
  return state.topology.nodeRecords?.find((node) => node.id === nodeId && node.kind === "spawn")?.spawnRuleId ?? null;
}

export function getSpawnRuleEntryRuntimeNodeIds(state: GraphTaskState, groupId: string, spawnRuleId: string): string[] {
  const rule = state.topology.spawnRules?.find((candidate) => candidate.id === spawnRuleId);
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

export function getNextSpawnSequence(state: GraphTaskState, spawnRuleId: string): number {
  const next = (state.spawnSequenceByRule[spawnRuleId] ?? 0) + 1;
  state.spawnSequenceByRule[spawnRuleId] = next;
  return next;
}

export function buildSpawnItemTitle(sourceContent: string | undefined, fallbackIndex: number): string {
  const firstLine = (sourceContent ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ?? `spawn-item-${fallbackIndex}`;
}

export function buildSpawnItemId(spawnRuleId: string, sequence: number): string {
  return `${spawnRuleId}-${String(sequence).padStart(4, "0")}`;
}

export function ensureRuntimeNodeStatuses(state: GraphTaskState): void {
  for (const node of state.runtimeNodes) {
    if (!state.agentStatusesByName[node.id]) {
      state.agentStatusesByName[node.id] = "idle";
    }
  }
}
