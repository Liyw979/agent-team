import { isReviewAgentInTopology, type TopologyRecord } from "@shared/types";

import type { GraphTaskState } from "./gating-state";
import { buildEffectiveTopology } from "./runtime-topology-graph";

export function resolveExecutionReviewAgent(input: {
  state: GraphTaskState | null;
  topology: Pick<TopologyRecord, "edges">;
  runtimeAgentName: string;
  executableAgentName: string;
}): boolean {
  const effectiveTopology = input.state ? buildEffectiveTopology(input.state) : input.topology;

  return (
    isReviewAgentInTopology(effectiveTopology, input.runtimeAgentName)
    || isReviewAgentInTopology(effectiveTopology, input.executableAgentName)
    || isReviewAgentInTopology(input.topology, input.runtimeAgentName)
    || isReviewAgentInTopology(input.topology, input.executableAgentName)
  );
}
