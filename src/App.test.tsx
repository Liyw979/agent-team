import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const APP_SOURCE = fs.readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const LEGACY_SUBSCRIBE_NAME = ["subscribe", "Agent", "Flow", "Events"].join("");
const LEGACY_BRIDGE_NAME = ["window", "agent", "Flow"].join(".");

test("App 已裁成单 Task 展示面板", () => {
  assert.doesNotMatch(APP_SOURCE, /SidebarList/);
  assert.doesNotMatch(APP_SOURCE, /AgentConfigModal/);
  assert.doesNotMatch(APP_SOURCE, /saveTopology/);
  assert.doesNotMatch(APP_SOURCE, /createProject|deleteProject|deleteTask/);
});

test("App 保留聊天输入，但团队面板不再提供 attach 按钮", () => {
  assert.match(APP_SOURCE, /<ChatWindow/);
  assert.match(APP_SOURCE, /resolveAppPanelVisibility/);
  assert.match(APP_SOURCE, /panelMode/);
  assert.doesNotMatch(APP_SOURCE, /buildAgentPanelAttachButtonState/);
  assert.doesNotMatch(APP_SOURCE, /aria-label=\{`打开 \$\{agent\.name\} 的 attach 终端`\}/);
  assert.match(APP_SOURCE, />团队</);
  assert.doesNotMatch(APP_SOURCE, />当前 Agent</);
  assert.doesNotMatch(APP_SOURCE, /纯展示面板，不提供配置入口/);
  assert.doesNotMatch(APP_SOURCE, />成员</);
  assert.match(APP_SOURCE, /setSelectedAgentId/);
  assert.doesNotMatch(APP_SOURCE, /openLangGraphStudio/);
  assert.doesNotMatch(APP_SOURCE, /LangGraph UI/);
});

test("团队成员卡片里的 prompt 会按可用高度自动计算摘要行数，悬停时展示完整 prompt", () => {
  assert.match(APP_SOURCE, /buildAgentPromptPreviewText/);
  assert.match(APP_SOURCE, /title=\{agent\.promptPreview\}/);
  assert.match(APP_SOURCE, /agent\.promptPreview\.replace\(\/\\s\+\/gu, ""\)/);
  assert.match(APP_SOURCE, /calculateAgentCardPanelLayout/);
  assert.match(APP_SOURCE, /WebkitLineClamp: promptLineCount/);
  assert.match(APP_SOURCE, /color: color\.mutedText/);
  assert.match(APP_SOURCE, /className="min-w-0 overflow-hidden break-all text-\[13px\] leading-\[18px\]"/);
  assert.match(APP_SOURCE, /className="mt-1 min-w-0 text-\[13px\] leading-5"/);
  assert.doesNotMatch(APP_SOURCE, /className="min-w-0 truncate text-\[0\.9rem\] leading-5 text-foreground\/78"/);
  assert.doesNotMatch(APP_SOURCE, /className="min-w-0 overflow-hidden break-all text-\[0\.9rem\] leading-\[18px\] text-foreground\/78"/);
  assert.doesNotMatch(APP_SOURCE, /className="min-w-0 overflow-hidden break-all text-\[0\.9rem] leading-\[18px]"/);
  assert.doesNotMatch(APP_SOURCE, /className="mt-1 min-w-0 text-\[0\.9rem] leading-5"/);
});

test("点击团队成员卡片会打开 Prompt 详情弹窗", () => {
  assert.match(APP_SOURCE, /buildAgentPromptDialogState/);
  assert.match(APP_SOURCE, /setSelectedAgentPromptDialog/);
  assert.match(APP_SOURCE, /aria-label=\{`\$\{selectedAgentPromptDialog\.agentId} Prompt 详情`}/);
  assert.match(APP_SOURCE, /aria-label="关闭 Prompt 详情"/);
  assert.match(APP_SOURCE, /<MarkdownMessage/);
  assert.match(APP_SOURCE, /handleOpenAgentPromptDialog\(agent\)/);
  assert.match(APP_SOURCE, /selectedAgentPromptDialog\.promptSourceLabel/);
  assert.doesNotMatch(APP_SOURCE, /\{selectedAgentPromptDialog\.badge\}/);
  assert.doesNotMatch(APP_SOURCE, />系统 Prompt</);
});

test("团队成员卡片不再显示消息统计，并把 agent 名称改成和聊天记录一致的有色标题条", () => {
  assert.doesNotMatch(APP_SOURCE, /className="space-y-3"/);
  assert.doesNotMatch(APP_SOURCE, /className="space-y-1\.5"/);
  assert.match(APP_SOURCE, /calculateAgentCardPanelLayout/);
  assert.match(APP_SOURCE, /style=\{\{ gap: `\$\{agentCardGapPx}px` \}\}/);
  assert.match(APP_SOURCE, /getAgentColorToken/);
  assert.doesNotMatch(APP_SOURCE, /buildAgentPanelAttachButtonState/);
  assert.match(APP_SOURCE, /background: color\.solid/);
  assert.match(APP_SOURCE, /color: color\.badgeText/);
  assert.match(APP_SOURCE, /className="inline-flex max-w-full shrink-0 rounded-\[8px\] px-2 py-px text-center text-\[14px\] font-semibold leading-\[1\.2\] tracking-\[0\.02em\]"/);
  assert.doesNotMatch(APP_SOURCE, /className="min-w-0 flex items-center gap-2"/);
  assert.doesNotMatch(APP_SOURCE, /rounded-full border border-\[#d8cdbd\] bg-\[#fffaf2\] px-2\.5 py-0\.5 text-\[0\.78rem\] font-semibold text-foreground\/76/);
  assert.match(APP_SOURCE, /className="rounded-\[8px\] border px-3 py-2 text-left shadow-sm transition"/);
});

test("团队面板头部不再显示总数徽标，成员卡片右侧也不再显示消息数量统计", () => {
  assert.doesNotMatch(APP_SOURCE, /rounded-full bg-\[#c96f3b\] px-2\.5 py-0\.5 text-xs font-semibold text-white/);
  assert.match(APP_SOURCE, /<p className=\{PANEL_HEADER_TITLE_CLASS\}>团队<\/p>/);
  assert.doesNotMatch(APP_SOURCE, /messageCount: taskMessages\.filter\(\(message\) => message\.sender === agent\.name\)\.length/);
  assert.doesNotMatch(APP_SOURCE, /<span className="rounded-full border border-\[#d8cdbd\] bg-\[#fffaf2\] px-2\.5 py-0\.5 text-\[0\.78rem\] font-semibold text-foreground\/76">\{agent\.messageCount\}<\/span>/);
  assert.doesNotMatch(APP_SOURCE, /runs: \{agent\.runCount\}/);
});

test("团队列表和消息列表使用完全一致的垂直间距，避免看起来上下不对齐", () => {
  assert.match(APP_SOURCE, /style=\{\{ gap: `\$\{agentCardGapPx}px` \}\}/);
  assert.doesNotMatch(APP_SOURCE, /className="space-y-1\.5"/);
});

test("团队卡片选中时不再额外高亮，边框粗细和聊天记录保持一致", () => {
  assert.doesNotMatch(APP_SOURCE, /boxShadow: selected \? "0 0 0 2px rgba\(23, 32, 25, 0\.08\) inset" : undefined/);
  assert.doesNotMatch(APP_SOURCE, /border-\[2px\]/);
  assert.doesNotMatch(APP_SOURCE, /className="rounded-\[16px\] border px-5 py-3\.5 text-left transition"/);
  assert.match(APP_SOURCE, /className="rounded-\[8px\] border px-3 py-2 text-left shadow-sm transition"/);
});

test("App 不再从 uiSnapshot.project 读取当前工作区", () => {
  assert.doesNotMatch(APP_SOURCE, /uiSnapshot\?\.project/);
  assert.doesNotMatch(APP_SOURCE, /project\.project\.id/);
  assert.doesNotMatch(APP_SOURCE, /ProjectSnapshot/);
});

test("App 改走浏览器 fetch 与 EventSource，而不是旧的桌面桥接 API", () => {
  assert.match(APP_SOURCE, /from "\.\/lib\/web-api"/);
  assert.match(APP_SOURCE, /fetchUiSnapshot/);
  assert.match(APP_SOURCE, /subscribeAgentTeamEvents/);
  assert.doesNotMatch(APP_SOURCE, new RegExp(LEGACY_SUBSCRIBE_NAME));
  assert.doesNotMatch(APP_SOURCE, /launchParams\.cwd/);
  assert.doesNotMatch(APP_SOURCE, /cwd: launchParams\.cwd/);
  assert.doesNotMatch(APP_SOURCE, new RegExp(LEGACY_BRIDGE_NAME.replace(".", "\\.")));
});

test("App 会按 taskId 过滤 runtime-updated，而不是按旧 session 集合忽略 spawn 新实例", () => {
  assert.match(APP_SOURCE, /shouldRefreshForRuntimeEvent/);
  assert.match(APP_SOURCE, /currentTaskId: currentUiSnapshot\.task\.task\.id/);
  assert.doesNotMatch(APP_SOURCE, /sessionIds = new Set/);
  assert.doesNotMatch(APP_SOURCE, /!sessionIds\.has\(payload\.sessionId\)/);
});

test("App 的 ui snapshot 刷新链路会先经过最新请求门禁，不能把任意返回结果直接写回 state", () => {
  assert.match(APP_SOURCE, /decideUiSnapshotRefreshAcceptance/);
  assert.match(APP_SOURCE, /latestAcceptedUiSnapshotRequestIdRef/);
  assert.match(APP_SOURCE, /nextUiSnapshotRequestIdRef/);
  assert.match(APP_SOURCE, /if \(!acceptance\.accepted \|\| !acceptance\.payload\)/);
});

test("App 必须为 ui snapshot 提供定时轮询兜底，避免浏览器刷新后停在初始快照", () => {
  assert.match(APP_SOURCE, /getUiSnapshotPollingIntervalMs/);
  assert.match(APP_SOURCE, /setInterval\(\(\) => \{\s*void refreshUiSnapshot\(\);\s*\}, uiSnapshotPollingIntervalMs\)/);
});

test("应用主区域不能继续保留 20px 的固定外边距", () => {
  assert.match(APP_SOURCE, /getAppShellClassName/);
  assert.match(APP_SOURCE, /className=\{`min-h-0 flex-1 overflow-hidden \$\{appShellClassName\}`\}/);
  assert.doesNotMatch(APP_SOURCE, /<main className="min-h-0 flex-1 overflow-hidden px-5 py-5">/);
});

test("主布局间距缩小 50%，但团队面板宽度回退到原值", () => {
  assert.match(APP_SOURCE, /getAppWorkspaceLayoutMetrics/);
  assert.match(APP_SOURCE, /style=\{\{ gap: `\$\{workspaceLayoutMetrics\.panelGapPx\}px` \}\}/);
  assert.match(
    APP_SOURCE,
    /gridTemplateColumns: `minmax\(0, 1fr\) minmax\(\$\{workspaceLayoutMetrics\.teamPanelMinWidthPx\}px, \$\{workspaceLayoutMetrics\.teamPanelMaxWidthPx\}px\)`/,
  );
  assert.doesNotMatch(APP_SOURCE, /gap-\[10px\]/);
  assert.doesNotMatch(APP_SOURCE, /grid-cols-\[minmax\(0,1fr\)_minmax\(408px,456px\)\]/);
});

test("消息全屏模式会切到只显示消息面板的单栏布局", () => {
  assert.match(
    APP_SOURCE,
    /panelVisibility\.showChatPanel && !panelVisibility\.showTopologyPanel && !panelVisibility\.showTeamPanel/,
  );
  assert.match(APP_SOURCE, /current === "chat-only" \? "default" : "chat-only"/);
});

test("拓扑全屏模式会切到只显示拓扑面板的单栏布局", () => {
  assert.match(
    APP_SOURCE,
    /!panelVisibility\.showChatPanel && panelVisibility\.showTopologyPanel && !panelVisibility\.showTeamPanel/,
  );
  assert.match(APP_SOURCE, /current === "topology-only" \? "default" : "topology-only"/);
});
