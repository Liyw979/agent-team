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
  assert.match(TOPOLOGY_GRAPH_SOURCE, /<AgentHistoryMarkdown[\s\S]*content=\{item\.previewDetail\}/);
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /<button[\s\S]*<article/);
});

test("拓扑历史卡片正文必须支持拖动选择文本，不能继续把整块内容包在 button 里", () => {
  assert.match(TOPOLOGY_GRAPH_SOURCE, /className="min-w-0 flex-1 select-text"/);
  assert.match(TOPOLOGY_GRAPH_SOURCE, /window\.getSelection\(\)\?\.toString\(\)\.trim\(\)/);
  assert.match(TOPOLOGY_GRAPH_SOURCE, /onClick=\{\(event\) => \{/);
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /aria-label="查看历史详情"/);
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /<article[\s\S]*className="min-w-0 flex-1 select-text"[\s\S]*<AgentHistoryMarkdown/,
  );
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, />详情<\/button>/);
});

test("拓扑历史详情弹窗里的正文需要调整到 14px，不能继续使用 18px", () => {
  assert.match(TOPOLOGY_GRAPH_SOURCE, /<AgentHistoryMarkdown[\s\S]*className="text-\[14px\] leading-\[1\.35\] text-foreground\/84"/);
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /<AgentHistoryMarkdown[\s\S]*className="text-\[14px\] leading-7 text-foreground\/84"/);
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /<AgentHistoryMarkdown[\s\S]*className="text-\[10px\] leading-\[1\.35\] text-foreground\/84"/);
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /<AgentHistoryMarkdown[\s\S]*className="text-\[11px\] leading-5 text-foreground\/84"/);
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /<AgentHistoryMarkdown[\s\S]*className="text-\[18px\] leading-\[1\.35\] text-foreground\/84"/);
});

test("拓扑历史正文要和消息记录使用不同字号规则，并统一使用 11px 正文", () => {
  assert.match(TOPOLOGY_GRAPH_SOURCE, /<span className="text-\[11px\] font-semibold">\{item\.label\}<\/span>/);
  assert.match(TOPOLOGY_GRAPH_SOURCE, /<span className="text-\[11px\] opacity-70">\{formatHistoryTimestamp\(item\.timestamp\)\}<\/span>/);
  assert.match(TOPOLOGY_GRAPH_SOURCE, /<AgentHistoryMarkdown[\s\S]*className="mt-1 text-\[11px\] leading-\[1\.35\] opacity-90 select-text"/);
  assert.match(TOPOLOGY_GRAPH_SOURCE, /<AgentHistoryMarkdown[\s\S]*className="text-\[14px\] leading-\[1\.35\] text-foreground\/84"/);
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /<AgentHistoryMarkdown[\s\S]*className="mt-1 text-\[10px\] leading-\[1\.35\] opacity-90"/);
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /<AgentHistoryMarkdown[\s\S]*className="text-\[10px\] leading-\[1\.35\] text-foreground\/84"/);
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /<AgentHistoryMarkdown[\s\S]*className="mt-1 text-\[11px\] leading-5 opacity-90"/);
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /<AgentHistoryMarkdown[\s\S]*className="text-\[11px\] leading-5 text-foreground\/84"/);
});
