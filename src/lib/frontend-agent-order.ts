import type { AgentRecord, TaskAgentRecord, TopologyRecord } from "@shared/types";

export function orderAgentsForFrontend<T extends { id: string }>(
  agents: T[],
  topology: Pick<TopologyRecord, "nodes"> | null | undefined,
): T[] {
  const order = topology?.nodes ?? [];
  if (order.length === 0) {
    return [...agents];
  }

  const agentByName = new Map(agents.map((agent) => [agent.id, agent]));
  const consumed = new Set<string>();
  const ordered: T[] = [];

  for (const name of order) {
    const matched = agentByName.get(name);
    if (!matched || consumed.has(name)) {
      continue;
    }
    ordered.push(matched);
    consumed.add(name);
  }

  for (const agent of agents) {
    if (consumed.has(agent.id)) {
      continue;
    }
    ordered.push(agent);
    consumed.add(agent.id);
  }

  return ordered;
}

export function buildAvailableAgentIdsForFrontend(
  agents: AgentRecord[],
  topology: Pick<TopologyRecord, "nodes"> | null | undefined,
): string[] {
  return orderAgentsForFrontend(agents, topology).map((agent) => agent.id);
}

export function resolveDefaultSelectedAgentIdForFrontend(input: {
  selectedAgentId: string | null;
  workspaceAgents: AgentRecord[];
  taskAgents: TaskAgentRecord[];
  topology: Pick<TopologyRecord, "nodes"> | null | undefined;
}): string | null {
  const preserved = input.taskAgents.find((agent) => agent.id === input.selectedAgentId)?.id;
  if (preserved) {
    return preserved;
  }

  return orderAgentsForFrontend(input.workspaceAgents, input.topology)[0]?.id ?? null;
}
