import type { TopologyRecord } from "@shared/types";

import type { GraphTaskState } from "./gating-state";

export function buildEffectiveTopology(state: GraphTaskState): TopologyRecord {
  const runtimeNodeIds = state.runtimeNodes.map((node) => node.id);
  const staticNodeIds = state.topology.nodes.filter((name) => !runtimeNodeIds.includes(name));
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
        kind: node.kind,
        templateName: node.templateName,
        spawnRuleId: node.spawnRuleId,
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
  return buildEffectiveTopology(state).nodeRecords?.some((node) => node.id === nodeId && node.kind === "spawn") ?? false;
}

export function getSpawnRuleIdForNode(state: GraphTaskState, nodeId: string): string | null {
  return buildEffectiveTopology(state).nodeRecords?.find((node) => node.id === nodeId && node.kind === "spawn")?.spawnRuleId ?? null;
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

export function getRuntimeNode(state: GraphTaskState, runtimeAgentId: string) {
  return state.runtimeNodes.find((node) => node.id === runtimeAgentId) ?? null;
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

function ensureRuntimeNodeStatuses(state: GraphTaskState): void {
  for (const node of state.runtimeNodes) {
    if (!state.agentStatusesByName[node.id]) {
      state.agentStatusesByName[node.id] = "idle";
    }
  }
}
