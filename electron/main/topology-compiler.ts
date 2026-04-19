import type { TopologyEdgeTrigger, TopologyRecord } from "@shared/types";

export interface TopologyIndex {
  associationTargetsBySource: Record<string, string[]>;
  approvedTargetsBySource: Record<string, string[]>;
  needsRevisionTargetsBySource: Record<string, string[]>;
}

export function compileTopology(topology: TopologyRecord): TopologyIndex {
  return {
    associationTargetsBySource: buildTargets(topology, "association"),
    approvedTargetsBySource: buildTargets(topology, "approved"),
    needsRevisionTargetsBySource: buildTargets(topology, "needs_revision"),
  };
}

function buildTargets(
  topology: TopologyRecord,
  triggerOn: TopologyEdgeTrigger,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const edge of topology.edges) {
    if (edge.triggerOn !== triggerOn) {
      continue;
    }
    const current = result[edge.source] ?? [];
    if (!current.includes(edge.target)) {
      current.push(edge.target);
    }
    result[edge.source] = current;
  }
  return result;
}
