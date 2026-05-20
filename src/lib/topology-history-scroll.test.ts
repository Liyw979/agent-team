import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createTopologyHistoryAutoScrollTracker,
  scrollTopologyHistoryToBottom,
  shouldAutoScrollTopologyHistory,
  shouldStickTopologyHistoryToBottom,
} from "./topology-history-scroll";

test("新历史项追加且视口原本贴近底部时，拓扑历史区必须自动滚到底部", () => {
  assert.equal(
    shouldAutoScrollTopologyHistory({
      previousLastItemId: "history-1",
      nextLastItemId: "history-2",
      shouldStickToBottom: true,
    }),
    true,
  );
});

test("用户已经离开底部查看旧记录时，不应强行把拓扑历史区拉回到底部", () => {
  assert.equal(
    shouldAutoScrollTopologyHistory({
      previousLastItemId: "history-1",
      nextLastItemId: "history-2",
      shouldStickToBottom: false,
    }),
    false,
  );
});

test("拓扑历史区距离底部 48px 以内时，继续视为应追随底部", () => {
  assert.equal(
    shouldStickTopologyHistoryToBottom({
      scrollHeight: 500,
      clientHeight: 200,
      scrollTop: 252,
    }),
    true,
  );
});

test("createTopologyHistoryAutoScrollTracker 会把新追加的历史记录滚到底部", () => {
  const tracker = createTopologyHistoryAutoScrollTracker();
  const scrollToOptions: ScrollToOptions[] = [];
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
  tracker.bindViewport({
    get scrollHeight() {
      return 640;
    },
    get clientHeight() {
      return 180;
    },
    scrollTo(options: ScrollToOptions) {
      scrollToOptions.push(options);
    },
  } as HTMLDivElement);

  try {
    const frameId = tracker.sync("history-2");
    assert.equal(frameId, 1);
    assert.deepEqual(scrollToOptions, [{
      top: 460,
      behavior: "smooth",
    }]);
  } finally {
    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
    globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
  }
});

test("createTopologyHistoryAutoScrollTracker 会在重置追随状态后继续自动贴底，并在 reset 后允许解绑 viewport", () => {
  const tracker = createTopologyHistoryAutoScrollTracker();
  const scrollToOptions: ScrollToOptions[] = [];
  tracker.bindViewport({
    get scrollHeight() {
      return 900;
    },
    get clientHeight() {
      return 200;
    },
    scrollTo(options: ScrollToOptions) {
      scrollToOptions.push(options);
    },
  } as HTMLDivElement);

  tracker.updateStickState({
    scrollHeight: 900,
    clientHeight: 200,
    scrollTop: 100,
  });
  assert.equal(tracker.sync("history-2"), null);
  assert.deepEqual(scrollToOptions, []);

  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;

  try {
    tracker.reinitialize();
    assert.equal(tracker.sync("history-3"), 1);
    assert.deepEqual(scrollToOptions, [{
      top: 700,
      behavior: "smooth",
    }]);

    tracker.reset();
    assert.equal(tracker.sync("history-4"), null);
    assert.deepEqual(scrollToOptions, [{
      top: 700,
      behavior: "smooth",
    }]);
  } finally {
    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
    globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
  }
});

test("scrollTopologyHistoryToBottom 使用原生 smooth scroll 滚动到底部", () => {
  const scrollToOptions: ScrollToOptions[] = [];
  scrollTopologyHistoryToBottom({
    get scrollHeight() {
      return 520;
    },
    get clientHeight() {
      return 120;
    },
    scrollTo(options: ScrollToOptions) {
      scrollToOptions.push(options);
    },
  } as HTMLDivElement);

  assert.deepEqual(scrollToOptions, [{
    top: 400,
    behavior: "smooth",
  }]);
});
