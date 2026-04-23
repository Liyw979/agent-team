import type { TaskAgentRecord, TopologyRecord } from "@shared/types";

export function resolveTaskAgentIdsToPrewarm(
  topology: Pick<TopologyRecord, "edges" | "langgraph" | "spawnRules">,
  taskAgents: ReadonlyArray<Pick<TaskAgentRecord, "id">>,
): string[] {
  const parentReachableAgentIds = new Set<string>([
    ...(topology.langgraph?.start.targets ?? []),
    ...topology.edges.flatMap((edge) => [edge.source, edge.target]),
  ]);
  const spawnTemplateAgentIds = new Set(
    topology.spawnRules?.flatMap((rule) => rule.spawnedAgents.map((agent) => agent.templateName)) ?? [],
  );

  return taskAgents
    .map((agent) => agent.id)
    .filter((agentId) => !spawnTemplateAgentIds.has(agentId) || parentReachableAgentIds.has(agentId));
}
