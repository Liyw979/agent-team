import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const TOPOLOGY_GRAPH_SOURCE = fs.readFileSync(new URL("./TopologyGraph.tsx", import.meta.url), "utf8");

test("agent 历史记录区应尽量贴近外层边框，避免上下左右留白过大", () => {
  assert.match(TOPOLOGY_GRAPH_SOURCE, /className="min-h-0 flex-1 px-2 py-2"/);
  assert.match(TOPOLOGY_GRAPH_SOURCE, /className="h-full space-y-1 overflow-y-auto"/);
  assert.match(TOPOLOGY_GRAPH_SOURCE, /getTopologyHistoryItemButtonClassName\(\)/);
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /className="min-h-0 flex-1 px-3 py-3"/);
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /className="h-full space-y-1 overflow-y-auto pr-1"/);
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /rounded-\[10px\] border px-3 py-2 text-left/);
});

test("点击拓扑里的单条历史消息后，会弹出完整内容弹窗", () => {
  assert.match(TOPOLOGY_GRAPH_SOURCE, /selectedHistoryItem/);
  assert.match(TOPOLOGY_GRAPH_SOURCE, /setSelectedHistoryItem/);
  assert.match(TOPOLOGY_GRAPH_SOURCE, /event\.stopPropagation\(\);[\s\S]*setSelectedHistoryItem\(/);
  assert.match(TOPOLOGY_GRAPH_SOURCE, /role="dialog"/);
  assert.match(TOPOLOGY_GRAPH_SOURCE, /<AgentHistoryMarkdown[\s\S]*content=\{selectedHistoryItem\.item\.detail\}/);
  assert.match(TOPOLOGY_GRAPH_SOURCE, /<AgentHistoryMarkdown[\s\S]*content=\{item\.detail\}/);
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /<button[\s\S]*<article/);
});
