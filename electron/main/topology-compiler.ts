import type { TopologyEdgeTrigger, TopologyRecord } from "@shared/types";

export interface TopologyIndex {
  associationTargetsBySource: Record<string, string[]>;
  reviewPassTargetsBySource: Record<string, string[]>;
  reviewFailTargetsBySource: Record<string, string[]>;
}

export function compileTopology(topology: TopologyRecord): TopologyIndex {
  return {
    associationTargetsBySource: buildTargets(topology, "association"),
    reviewPassTargetsBySource: buildTargets(topology, "review_pass"),
    reviewFailTargetsBySource: buildTargets(topology, "review_fail"),
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
