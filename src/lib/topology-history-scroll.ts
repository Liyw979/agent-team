type TopologyHistoryAutoScrollInput = {
  previousTailVersion: string | null;
  nextTailVersion: string | null;
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
  lastTailVersion: string | null;
}

export function shouldAutoScrollTopologyHistory(
  input: TopologyHistoryAutoScrollInput,
): boolean {
  if (!input.shouldStickToBottom) {
    return false;
  }

  return input.previousTailVersion !== input.nextTailVersion;
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
    lastTailVersion: null,
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
      state.lastTailVersion = null;
    },
    reset() {
      state.viewport = null;
      state.shouldStickToBottom = true;
      state.lastTailVersion = null;
    },
    sync(nextTailVersion: string | null): number | null {
      if (!state.viewport) {
        state.lastTailVersion = nextTailVersion;
        return null;
      }

      if (
        shouldAutoScrollTopologyHistory({
          previousTailVersion: state.lastTailVersion,
          nextTailVersion,
          shouldStickToBottom: state.shouldStickToBottom,
        })
      ) {
        const frameId = requestAnimationFrame(() => {
          if (!state.viewport) {
            return;
          }
          scrollTopologyHistoryToBottom(state.viewport);
        });
        state.lastTailVersion = nextTailVersion;
        return frameId;
      }

      state.lastTailVersion = nextTailVersion;
      return null;
    },
  };
}
