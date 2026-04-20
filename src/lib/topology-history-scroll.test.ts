import test from "node:test";
import assert from "node:assert/strict";
import {
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
