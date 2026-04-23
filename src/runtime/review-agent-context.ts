import { isReviewAgentInTopology, type TopologyRecord } from "@shared/types";

import type { GraphTaskState } from "./gating-state";
import { buildEffectiveTopology } from "./runtime-topology-graph";

export function resolveExecutionReviewAgent(input: {
  state: GraphTaskState | null;
  topology: Pick<TopologyRecord, "edges"> & Partial<Pick<TopologyRecord, "langgraph">>;
  runtimeAgentId: string;
  executableAgentId: string;
}): boolean {
  const effectiveTopology = input.state ? buildEffectiveTopology(input.state) : input.topology;

  return (
    isReviewAgentInTopology(effectiveTopology, input.runtimeAgentId)
    || isReviewAgentInTopology(effectiveTopology, input.executableAgentId)
    || isReviewAgentInTopology(input.topology, input.runtimeAgentId)
    || isReviewAgentInTopology(input.topology, input.executableAgentId)
  );
}
