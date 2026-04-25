import test from "node:test";
import assert from "node:assert/strict";

import type { AgentHistoryItem } from "./agent-history";
import {
  filterTopologyAgentIdsWithDisplayableHistory,
  selectTopologyHistoryItemsForDisplay,
} from "./topology-history-items";

function createHistoryItem(index: number): AgentHistoryItem {
  return {
    id: `history-${index}`,
    label: index === 0 ? "思考" : "工具",
    detailSnippet: index === 0 ? "Prioritizing instructions" : `tool-${index}`,
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

test("selectTopologyHistoryItemsForDisplay 会过滤掉空消息生成的占位记录", () => {
  const items: AgentHistoryItem[] = [
    {
      id: "history-empty",
      label: "已完成",
      detailSnippet: "暂无详细记录",
      detail: "暂无详细记录",
      timestamp: "2026-04-24T00:00:10.000Z",
      sortTimestamp: "2026-04-24T00:00:10.000Z",
      tone: "success",
    },
    createHistoryItem(1),
  ];

  assert.deepEqual(
    selectTopologyHistoryItemsForDisplay(items).map((item) => item.id),
    ["history-1"],
  );
});

test("filterTopologyAgentIdsWithDisplayableHistory 会隐藏没有可展示消息记录的 agent 列", () => {
  const historyByAgent = new Map<string, AgentHistoryItem[]>([
    ["线索发现", [createHistoryItem(0)]],
    ["线索完备性评估", []],
    ["漏洞挑战-1", [createHistoryItem(1)]],
    ["漏洞论证", []],
    ["讨论总结", []],
  ]);

  assert.deepEqual(
    filterTopologyAgentIdsWithDisplayableHistory(
      ["线索发现", "线索完备性评估", "漏洞挑战-1", "漏洞论证", "讨论总结"],
      historyByAgent,
    ),
    ["线索发现", "漏洞挑战-1"],
  );
});
