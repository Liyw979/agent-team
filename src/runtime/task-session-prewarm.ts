import type { TaskAgentRecord, TopologyRecord } from "@shared/types";

export function resolveTaskAgentNamesToPrewarm(
  topology: Pick<TopologyRecord, "edges" | "langgraph" | "spawnRules">,
  taskAgents: ReadonlyArray<Pick<TaskAgentRecord, "name">>,
): string[] {
  const parentReachableAgentNames = new Set<string>([
    ...(topology.langgraph?.start.targets ?? []),
    ...topology.edges.flatMap((edge) => [edge.source, edge.target]),
  ]);
  const spawnTemplateAgentNames = new Set(
    topology.spawnRules?.flatMap((rule) => rule.spawnedAgents.map((agent) => agent.templateName)) ?? [],
  );

  return taskAgents
    .map((agent) => agent.name)
    .filter((agentName) => !spawnTemplateAgentNames.has(agentName) || parentReachableAgentNames.has(agentName));
}
