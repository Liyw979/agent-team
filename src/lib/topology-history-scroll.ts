export type TopologyHistoryAutoScrollInput = {
  previousLastItemId: string | null;
  nextLastItemId: string | null;
  shouldStickToBottom: boolean;
};

export type TopologyHistoryViewportMetrics = {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
};

export function shouldAutoScrollTopologyHistory(
  input: TopologyHistoryAutoScrollInput,
): boolean {
  if (!input.shouldStickToBottom) {
    return false;
  }

  return input.previousLastItemId !== input.nextLastItemId;
}

export function shouldStickTopologyHistoryToBottom(
  metrics: TopologyHistoryViewportMetrics,
): boolean {
  const distanceToBottom =
    metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop;
  return distanceToBottom <= 48;
}
