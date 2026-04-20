import type { SpawnItemPayload } from "@shared/types";

import type { GraphTaskState } from "./gating-state";
import { instantiateSpawnBundles } from "./runtime-topology";
import { ensureRuntimeAgentStatuses } from "./runtime-topology-graph";

export function spawnRuntimeAgentsForItems(input: {
  state: GraphTaskState;
  spawnRuleId: string;
  items: SpawnItemPayload[];
}): GraphTaskState {
  const bundles = instantiateSpawnBundles({
    topology: input.state.topology,
    spawnRuleId: input.spawnRuleId,
    items: input.items,
  });

  for (const bundle of bundles) {
    if (input.state.spawnBundles.some((existing) => existing.groupId === bundle.groupId)) {
      continue;
    }
    input.state.spawnBundles.push(bundle);
    input.state.runtimeNodes.push(...bundle.nodes);
    input.state.runtimeEdges.push(...bundle.edges);
  }

  ensureRuntimeAgentStatuses(input.state);
  return input.state;
}
