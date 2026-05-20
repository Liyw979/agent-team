type TopologyHistoryAutoScrollInput = {
  previousLastItemId: string | null;
  nextLastItemId: string | null;
  shouldStickToBottom: boolean;
};

type TopologyHistoryViewportMetrics = {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
};

interface TopologyHistoryAutoScrollTrackerState {
  viewport: HTMLDivElement | null;
  shouldStickToBottom: boolean;
  lastItemId: string | null;
}

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

export function scrollTopologyHistoryToBottom(element: HTMLDivElement) {
  element.scrollTo({
    top: Math.max(0, element.scrollHeight - element.clientHeight),
    behavior: "smooth",
  });
}

export function createTopologyHistoryAutoScrollTracker() {
  const state: TopologyHistoryAutoScrollTrackerState = {
    viewport: null,
    shouldStickToBottom: true,
    lastItemId: null,
  };

  return {
    bindViewport(viewport: HTMLDivElement | null) {
      state.viewport = viewport;
    },
    updateStickState(metrics: TopologyHistoryViewportMetrics) {
      state.shouldStickToBottom = shouldStickTopologyHistoryToBottom(metrics);
    },
    reinitialize() {
      state.shouldStickToBottom = true;
      state.lastItemId = null;
    },
    reset() {
      state.viewport = null;
      state.shouldStickToBottom = true;
      state.lastItemId = null;
    },
    sync(nextLastItemId: string | null): number | null {
      if (!state.viewport) {
        state.lastItemId = nextLastItemId;
        return null;
      }

      if (
        shouldAutoScrollTopologyHistory({
          previousLastItemId: state.lastItemId,
          nextLastItemId,
          shouldStickToBottom: state.shouldStickToBottom,
        })
      ) {
        const frameId = requestAnimationFrame(() => {
          if (!state.viewport) {
            return;
          }
          scrollTopologyHistoryToBottom(state.viewport);
        });
        state.lastItemId = nextLastItemId;
        return frameId;
      }

      state.lastItemId = nextLastItemId;
      return null;
    },
  };
}
