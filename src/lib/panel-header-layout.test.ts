import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const APP_SOURCE = fs.readFileSync(path.join(import.meta.dirname, "../App.tsx"), "utf8");
const CHAT_WINDOW_SOURCE = fs.readFileSync(
  path.join(import.meta.dirname, "../components/ChatWindow.tsx"),
  "utf8",
);
const TOPOLOGY_GRAPH_SOURCE = fs.readFileSync(
  path.join(import.meta.dirname, "../components/TopologyGraph.tsx"),
  "utf8",
);
const PANEL_HEADER_SOURCE = fs.readFileSync(
  path.join(import.meta.dirname, "./panel-header.ts"),
  "utf8",
);

test("消息、团队、拓扑三块面板复用完全一致的头部样式", () => {
  assert.match(PANEL_HEADER_SOURCE, /PANEL_SURFACE_CLASS/);
  assert.match(PANEL_HEADER_SOURCE, /PANEL_HEADER_LEADING_CLASS/);
  assert.match(APP_SOURCE, /PANEL_HEADER_CLASS/);
  assert.match(APP_SOURCE, /PANEL_HEADER_TITLE_CLASS/);
  assert.match(APP_SOURCE, /PANEL_SECTION_BODY_CLASS/);
  assert.match(APP_SOURCE, /PANEL_SURFACE_CLASS/);
  assert.match(APP_SOURCE, /PANEL_HEADER_LEADING_CLASS/);
  assert.match(CHAT_WINDOW_SOURCE, /PANEL_HEADER_CLASS/);
  assert.match(CHAT_WINDOW_SOURCE, /PANEL_HEADER_TITLE_CLASS/);
  assert.match(CHAT_WINDOW_SOURCE, /PANEL_SECTION_BODY_CLASS/);
  assert.match(CHAT_WINDOW_SOURCE, /PANEL_SURFACE_CLASS/);
  assert.match(CHAT_WINDOW_SOURCE, /PANEL_HEADER_LEADING_CLASS/);
  assert.match(TOPOLOGY_GRAPH_SOURCE, /PANEL_HEADER_CLASS/);
  assert.match(TOPOLOGY_GRAPH_SOURCE, /PANEL_HEADER_TITLE_CLASS/);
  assert.match(TOPOLOGY_GRAPH_SOURCE, /PANEL_SURFACE_CLASS/);
  assert.match(TOPOLOGY_GRAPH_SOURCE, /PANEL_HEADER_LEADING_CLASS/);
});

test("消息、团队、拓扑三块标题文案所在行的高度必须一致，并以消息标题行为准", () => {
  assert.doesNotMatch(PANEL_HEADER_SOURCE, /min-h-\[30px\]/);
  assert.match(PANEL_HEADER_SOURCE, /PANEL_HEADER_CLASS =\s+"flex shrink-0 min-h-\[40px\] items-center justify-between gap-3 border-b border-border\/60 px-5"/);
  assert.match(PANEL_HEADER_SOURCE, /PANEL_HEADER_LEADING_CLASS = "flex items-center gap-2\.5"/);
});

test("统一头部样式把标题字号下调 20%，并统一上下间距与分割线", () => {
  assert.doesNotMatch(PANEL_HEADER_SOURCE, /pb-2 pt-2\.5/);
  assert.match(PANEL_HEADER_SOURCE, /min-h-\[40px\]/);
  assert.match(PANEL_HEADER_SOURCE, /border-b border-border\/60/);
  assert.match(PANEL_HEADER_SOURCE, /text-\[1\.16rem\]/);
  assert.match(PANEL_HEADER_SOURCE, /items-center/);
});

test("标题文案本身使用固定高度并垂直居中，避免不同汉字字形造成到分割线的视觉距离不一致", () => {
  assert.doesNotMatch(PANEL_HEADER_SOURCE, /PANEL_HEADER_TITLE_CLASS =\s+"flex min-h-6 items-center font-display text-\[1\.16rem\] font-bold text-primary"/);
  assert.match(PANEL_HEADER_SOURCE, /PANEL_HEADER_TITLE_CLASS =\s+"font-display text-\[1\.16rem\] font-bold leading-none text-primary"/);
});

test("消息、团队面板继续复用统一内容区间距，拓扑面板则使用更贴边的专属内边距", () => {
  assert.match(PANEL_HEADER_SOURCE, /PANEL_SECTION_BODY_CLASS/);
  assert.match(PANEL_HEADER_SOURCE, /px-5 py-2/);
  assert.doesNotMatch(CHAT_WINDOW_SOURCE, /px-5 py-3/);
  assert.doesNotMatch(APP_SOURCE, /px-5 py-4/);
  assert.match(TOPOLOGY_GRAPH_SOURCE, /getTopologyPanelBodyClassName/);
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /className=\{`relative flex-1 min-h-0 \$\{PANEL_SECTION_BODY_CLASS\}`\}/);
});

test("群聊消息记录之间的间隔再缩小 50%", () => {
  assert.doesNotMatch(CHAT_WINDOW_SOURCE, /className=\{`flex-1 min-h-0 space-y-3 overflow-y-auto \$\{PANEL_SECTION_BODY_CLASS\}`\}/);
  assert.match(CHAT_WINDOW_SOURCE, /className=\{`flex-1 min-h-0 space-y-1\.5 overflow-y-auto \$\{PANEL_SECTION_BODY_CLASS\}`\}/);
});

test("团队列表与群聊列表的垂直间隔必须完全一致", () => {
  assert.doesNotMatch(APP_SOURCE, /className="space-y-3"/);
  assert.doesNotMatch(APP_SOURCE, /className="space-y-1\.5"/);
  assert.match(APP_SOURCE, /style=\{\{ gap: `\$\{agentCardGapPx}px` \}\}/);
  assert.match(APP_SOURCE, /calculateAgentCardPanelLayout/);
  assert.match(CHAT_WINDOW_SOURCE, /className=\{`flex-1 min-h-0 space-y-1\.5 overflow-y-auto \$\{PANEL_SECTION_BODY_CLASS\}`\}/);
});
