import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const TOPOLOGY_GRAPH_SOURCE = fs.readFileSync(
  new URL("./TopologyGraph.tsx", import.meta.url),
  "utf8",
);

test("agent 历史记录区应尽量贴近外层边框，避免上下左右留白过大", () => {
  assert.match(TOPOLOGY_GRAPH_SOURCE, /className="min-h-0 flex-1 px-2 py-2"/);
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /className="h-full space-y-1 overflow-y-auto"/,
  );
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /getTopologyHistoryItemButtonClassName\(\)/,
  );
  assert.doesNotMatch(
    TOPOLOGY_GRAPH_SOURCE,
    /className="min-h-0 flex-1 px-3 py-3"/,
  );
  assert.doesNotMatch(
    TOPOLOGY_GRAPH_SOURCE,
    /className="h-full space-y-1 overflow-y-auto pr-1"/,
  );
  assert.doesNotMatch(
    TOPOLOGY_GRAPH_SOURCE,
    /rounded-\[10px\] border px-3 py-2 text-left/,
  );
});

test("点击拓扑里的单条历史消息后，会弹出完整内容弹窗", () => {
  assert.match(TOPOLOGY_GRAPH_SOURCE, /selectedHistoryItem/);
  assert.match(TOPOLOGY_GRAPH_SOURCE, /setSelectedHistoryItem/);
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /event\.stopPropagation\(\);[\s\S]*setSelectedHistoryItem\(/,
  );
  assert.match(TOPOLOGY_GRAPH_SOURCE, /role="dialog"/);
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /<AgentHistoryMarkdown[\s\S]*content=\{selectedHistoryItem\.item\.detail\}/,
  );
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /<AgentHistoryMarkdown[\s\S]*content=\{item\.detailSnippet\}/,
  );
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /<article[\s\S]*className=\{`\$\{getTopologyHistoryItemButtonClassName\(\)\} \$\{getHistoryItemClassName\(item\)\}`\}/,
  );
});

test("拓扑历史卡片正文必须支持拖动选择文本，不能继续把整块内容包在 button 里", () => {
  assert.match(TOPOLOGY_GRAPH_SOURCE, /className="min-w-0 flex-1 select-text"/);
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /window\.getSelection\(\)\?\.toString\(\)\.trim\(\)/,
  );
  assert.match(TOPOLOGY_GRAPH_SOURCE, /onClick=\{\(event\) => \{/);
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /aria-label="查看历史详情"/);
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /<article[\s\S]*className="min-w-0 flex-1 select-text"[\s\S]*<AgentHistoryMarkdown/,
  );
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, />详情<\/button>/);
});

test("拓扑历史详情弹窗里的正文需要调整到 14px，不能继续使用 18px", () => {
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /<AgentHistoryMarkdown[\s\S]*className="text-\[14px\] leading-\[1\.35\] text-foreground\/84"/,
  );
  assert.doesNotMatch(
    TOPOLOGY_GRAPH_SOURCE,
    /<AgentHistoryMarkdown[\s\S]*className="text-\[14px\] leading-7 text-foreground\/84"/,
  );
  assert.doesNotMatch(
    TOPOLOGY_GRAPH_SOURCE,
    /<AgentHistoryMarkdown[\s\S]*className="text-\[10px\] leading-\[1\.35\] text-foreground\/84"/,
  );
  assert.doesNotMatch(
    TOPOLOGY_GRAPH_SOURCE,
    /<AgentHistoryMarkdown[\s\S]*className="text-\[11px\] leading-5 text-foreground\/84"/,
  );
  assert.doesNotMatch(
    TOPOLOGY_GRAPH_SOURCE,
    /<AgentHistoryMarkdown[\s\S]*className="text-\[18px\] leading-\[1\.35\] text-foreground\/84"/,
  );
});

test("拓扑历史正文要和消息记录使用不同字号规则，并统一使用 11px 正文", () => {
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /<span className="text-\[11px\] font-semibold">\s*\{item\.label\}\s*<\/span>/,
  );
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /<span className="text-\[11px\] opacity-70">\s*\{formatHistoryTimestamp\(item\.timestamp\)\}\s*<\/span>/,
  );
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /<AgentHistoryMarkdown[\s\S]*className="mt-1 text-\[11px\] leading-\[1\.35\] opacity-90 select-text"/,
  );
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /<AgentHistoryMarkdown[\s\S]*className="text-\[14px\] leading-\[1\.35\] text-foreground\/84"/,
  );
  assert.doesNotMatch(
    TOPOLOGY_GRAPH_SOURCE,
    /<AgentHistoryMarkdown[\s\S]*className="mt-1 text-\[10px\] leading-\[1\.35\] opacity-90"/,
  );
  assert.doesNotMatch(
    TOPOLOGY_GRAPH_SOURCE,
    /<AgentHistoryMarkdown[\s\S]*className="text-\[10px\] leading-\[1\.35\] text-foreground\/84"/,
  );
  assert.doesNotMatch(
    TOPOLOGY_GRAPH_SOURCE,
    /<AgentHistoryMarkdown[\s\S]*className="mt-1 text-\[11px\] leading-5 opacity-90"/,
  );
  assert.doesNotMatch(
    TOPOLOGY_GRAPH_SOURCE,
    /<AgentHistoryMarkdown[\s\S]*className="text-\[11px\] leading-5 text-foreground\/84"/,
  );
});

test("拓扑节点头部会在状态 icon 左侧补充全屏与 attach 按钮", () => {
  assert.match(TOPOLOGY_GRAPH_SOURCE, /getTopologyNodeHeaderActionOrder/);
  assert.match(TOPOLOGY_GRAPH_SOURCE, /showFullscreenButton: true/);
  assert.match(TOPOLOGY_GRAPH_SOURCE, /if \(action === "fullscreen"\)/);
  assert.match(TOPOLOGY_GRAPH_SOURCE, /setMaximizedAgentId\(node\.id\)/);
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /aria-label=\{`打开 \$\{node\.id\} 的 attach 终端`\}/,
  );
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /<span>\s*\{isAttachOpening \? "打开中" : "attach"\}\s*<\/span>/,
  );
  assert.match(TOPOLOGY_GRAPH_SOURCE, /headerActions\.map\(\(action\) => \{/);
});

test("拓扑里的单个 agent 可以进入全屏详情层，并展示完整历史", () => {
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /const \[maximizedAgentId, setMaximizedAgentId\] = useState<string \| null>\(null\)/,
  );
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /createPortal\(content, document\.body\)/,
  );
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /resolveFullscreenOverlayStrategy\(\{\s*ancestorCssEffects: \["backdrop-filter"\],\s*\}\)/,
  );
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /aria-label=\{`\$\{maximizedNode\.id} 全屏详情`\}/,
  );
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /className="fixed inset-0 z-\[60\] bg-black\/28"/,
  );
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /className="flex h-full w-full flex-col overflow-hidden bg-background"/,
  );
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /<AgentHistoryMarkdown[\s\S]*content=\{item\.detail\}[\s\S]*className="mt-1 text-\[13px\] leading-\[1\.5\] text-inherit opacity-95 select-text"/,
  );
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /onClick=\{\(\) => setMaximizedAgentId\(null\)\}/,
  );
  assert.doesNotMatch(
    TOPOLOGY_GRAPH_SOURCE,
    /className="fixed inset-0 z-40 bg-black\/28 px-4 py-4"/,
  );
  assert.doesNotMatch(
    TOPOLOGY_GRAPH_SOURCE,
    /当前展示 \{maximizedNode\.id\} 的完整历史轨迹。/,
  );
});

test("单个 agent 全屏详情里的消息留白需要压缩到接近一半，避免内容区过空", () => {
  assert.match(TOPOLOGY_GRAPH_SOURCE, /className="border-b px-3 py-2"/);
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /className="flex items-start justify-between gap-2"/,
  );
  assert.doesNotMatch(
    TOPOLOGY_GRAPH_SOURCE,
    /<p className="mt-1 text-sm text-foreground\/62">/,
  );
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /className="min-h-0 flex-1 overflow-y-auto px-2\.5 py-2"/,
  );
  assert.match(TOPOLOGY_GRAPH_SOURCE, /className="space-y-1\.5"/);
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /className=\{`rounded-\[12px\] border px-2 py-1\.5 \$\{getHistoryItemClassName\(item\)\}`\}/,
  );
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /<AgentHistoryMarkdown[\s\S]*content=\{item\.detail\}[\s\S]*className="mt-1 text-\[13px\] leading-\[1\.5\] text-inherit opacity-95 select-text"/,
  );
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /className="border-b px-6 py-4"/);
  assert.doesNotMatch(
    TOPOLOGY_GRAPH_SOURCE,
    /className="min-h-0 flex-1 overflow-y-auto px-5 py-4"/,
  );
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /className="space-y-3"/);
  assert.doesNotMatch(
    TOPOLOGY_GRAPH_SOURCE,
    /rounded-\[12px\] border px-4 py-3/,
  );
});

test("拓扑里的空历史节点不应再展示待启动占位记录", () => {
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /待启动/);
});

test("拓扑只展示运行过的 agent，并基于 runCount 过滤后的节点重新布局", () => {
  assert.match(TOPOLOGY_GRAPH_SOURCE, /const orderedNodeIds = useMemo\(/);
  assert.match(TOPOLOGY_GRAPH_SOURCE, /const rawHistoryByAgent = useMemo\(/);
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /\.filter\(\(agent\) => agent\.runCount > 0\)/,
  );
  assert.match(TOPOLOGY_GRAPH_SOURCE, /const visibleNodeIds = orderedNodeIds/);
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /getTopologyCanvasViewportMeasurementKey\(/,
  );
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /hasRenderableCanvas: Boolean\(topology && visibleNodeIds\.length > 0\)/,
  );
  assert.match(TOPOLOGY_GRAPH_SOURCE, /}, \[canvasViewportMeasurementKey\]\);/);
  assert.match(TOPOLOGY_GRAPH_SOURCE, /nodes: visibleNodeIds/);
  assert.doesNotMatch(
    TOPOLOGY_GRAPH_SOURCE,
    /filterTopologyAgentIdsWithDisplayableHistory/,
  );
});

test("拓扑节点头部的 attach 按钮需要保持更小的胶囊尺寸", () => {
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /className="inline-flex h-6 items-center justify-center gap-1 rounded-full border border-\[#d8cdbd\] bg-\[#fffaf2\] px-2 text-\[10px\] font-semibold text-foreground\/76/,
  );
  assert.match(TOPOLOGY_GRAPH_SOURCE, /className="h-3 w-3"/);
  assert.doesNotMatch(
    TOPOLOGY_GRAPH_SOURCE,
    /className="inline-flex h-7 items-center justify-center gap-1 rounded-full border border-\[#d8cdbd\] bg-\[#fffaf2\] px-2\.5 text-\[11px\] font-semibold text-foreground\/76/,
  );
});

test("拓扑节点状态徽标只从 snapshot task.agents 派生，不再依赖 runtimeSnapshots", () => {
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /runtimeSnapshots/);
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /getTopologyAgentStatusBadgePresentation\(\s*topology!,\s*agentId,\s*resolveTopologyNodeDisplayStatus\(\{/,
  );
  assert.match(TOPOLOGY_GRAPH_SOURCE, /taskAgentStatus", taskAgent\?\.status/);
});

test("运行中状态 icon 必须显式围绕 SVG 自身中心旋转，避免 Windows 上按 viewBox 原点旋转", () => {
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /className="h-3\.5 w-3\.5 animate-spin motion-reduce:animate-none origin-center \[transform-box:fill-box\]"/,
  );
  assert.doesNotMatch(
    TOPOLOGY_GRAPH_SOURCE,
    /className="h-3\.5 w-3\.5 animate-spin motion-reduce:animate-none"(?! origin-center \[transform-box:fill-box\])/,
  );
});

test("拓扑视口不能再被固定的最小高度撑出面板", () => {
  assert.match(
    TOPOLOGY_GRAPH_SOURCE,
    /className="h-full min-h-0 w-full overflow-auto"/,
  );
  assert.doesNotMatch(
    TOPOLOGY_GRAPH_SOURCE,
    /className="h-full min-h-\[350px\] w-full overflow-auto"/,
  );
});

test("拓扑面板内容区需要使用更贴边的专属内边距，不能继续复用通用 px-5 py-2", () => {
  assert.match(TOPOLOGY_GRAPH_SOURCE, /getTopologyPanelBodyClassName/);
  assert.doesNotMatch(
    TOPOLOGY_GRAPH_SOURCE,
    /className=\{`relative flex-1 min-h-0 \$\{PANEL_SECTION_BODY_CLASS\}`\}/,
  );
});
