import test from "node:test";
import assert from "node:assert/strict";

import { getTopologyHistoryItemButtonClassName } from "./topology-history-layout";

test("拓扑历史卡片应当横向铺满整个节点内容区", () => {
  const className = getTopologyHistoryItemButtonClassName();

  assert.match(className, /\bw-full\b/);
});
