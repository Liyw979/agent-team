import test from "node:test";
import assert from "node:assert/strict";

import type { AgentHistoryItem } from "./agent-history";
import { selectTopologyHistoryItemsForDisplay } from "./topology-history-items";

function createHistoryItem(index: number): AgentHistoryItem {
  return {
    id: `history-${index}`,
    label: index === 0 ? "思考" : "工具",
    previewDetail: index === 0 ? "Prioritizing instructions" : `tool-${index}`,
    detail: index === 0 ? "Prioritizing instructions" : `tool-${index}`,
    timestamp: `2026-04-24T00:00:${String(index).padStart(2, "0")}.000Z`,
    sortTimestamp: `2026-04-24T00:00:${String(index).padStart(2, "0")}.000Z`,
    tone: index === 0 ? "runtime-thinking" : "runtime-tool",
  };
}

test("selectTopologyHistoryItemsForDisplay 不会丢掉早期 OpenCode thinking", () => {
  const items = Array.from({ length: 8 }, (_, index) => createHistoryItem(index));

  assert.equal(
    selectTopologyHistoryItemsForDisplay(items).some((item) => item.detail === "Prioritizing instructions"),
    true,
  );
});
