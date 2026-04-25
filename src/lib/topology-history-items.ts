import {
  EMPTY_AGENT_HISTORY_DETAIL,
  type AgentHistoryItem,
} from "./agent-history";

export function selectTopologyHistoryItemsForDisplay(items: AgentHistoryItem[]): AgentHistoryItem[] {
  return items.filter((item) => item.detail !== EMPTY_AGENT_HISTORY_DETAIL);
}

export function filterTopologyAgentIdsWithDisplayableHistory(
  orderedNodeIds: string[],
  historyByAgent: ReadonlyMap<string, AgentHistoryItem[]>,
): string[] {
  return orderedNodeIds.filter((agentId) => (historyByAgent.get(agentId)?.length ?? 0) > 0);
}
