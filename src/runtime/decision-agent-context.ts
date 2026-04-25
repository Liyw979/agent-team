import { isDecisionAgentInTopology, type TopologyRecord } from "@shared/types";

import type { GraphTaskState } from "./gating-state";
import { buildEffectiveTopology } from "./runtime-topology-graph";

export function resolveExecutionDecisionAgent(input: {
  state: GraphTaskState | null;
  topology: Pick<TopologyRecord, "edges"> & Partial<Pick<TopologyRecord, "langgraph">>;
  runtimeAgentId: string;
  executableAgentId: string;
}): boolean {
  const effectiveTopology = input.state ? buildEffectiveTopology(input.state) : input.topology;

  return (
    isDecisionAgentInTopology(effectiveTopology, input.runtimeAgentId)
    || isDecisionAgentInTopology(effectiveTopology, input.executableAgentId)
    || isDecisionAgentInTopology(input.topology, input.runtimeAgentId)
    || isDecisionAgentInTopology(input.topology, input.executableAgentId)
  );
}
