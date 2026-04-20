import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const APP_SOURCE = fs.readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

test("App 已裁成单 Task 展示面板", () => {
  assert.doesNotMatch(APP_SOURCE, /SidebarList/);
  assert.doesNotMatch(APP_SOURCE, /AgentConfigModal/);
  assert.doesNotMatch(APP_SOURCE, /saveTopology/);
  assert.doesNotMatch(APP_SOURCE, /createProject|deleteProject|deleteTask/);
});

test("App 保留聊天输入与 attach 按钮", () => {
  assert.match(APP_SOURCE, /<ChatWindow/);
  assert.match(APP_SOURCE, /"attach"/);
  assert.match(APP_SOURCE, />团队</);
  assert.doesNotMatch(APP_SOURCE, />当前 Agent</);
  assert.doesNotMatch(APP_SOURCE, /纯展示面板，不提供配置入口/);
  assert.doesNotMatch(APP_SOURCE, />成员</);
  assert.match(APP_SOURCE, /setSelectedAgentId/);
  assert.doesNotMatch(APP_SOURCE, /openLangGraphStudio/);
  assert.doesNotMatch(APP_SOURCE, /LangGraph UI/);
});

test("团队成员卡片里的 prompt 只显示单行缩略，悬停时展示完整 prompt", () => {
  assert.match(APP_SOURCE, /title=\{promptPreview\}/);
  assert.match(APP_SOURCE, /promptPreview\.replace\(\/\\s\+\/gu, ""\)/);
  assert.match(APP_SOURCE, /calculateAgentCardPromptLineCount/);
  assert.match(APP_SOURCE, /WebkitLineClamp: promptLineCount/);
  assert.match(APP_SOURCE, /color: color\.mutedText/);
  assert.match(APP_SOURCE, /className="min-w-0 overflow-hidden break-all text-\[13px\] leading-\[18px\]"/);
  assert.match(APP_SOURCE, /className="mt-1 min-w-0 text-\[13px\] leading-5"/);
  assert.doesNotMatch(APP_SOURCE, /className="min-w-0 truncate text-\[0\.9rem\] leading-5 text-foreground\/78"/);
  assert.doesNotMatch(APP_SOURCE, /className="min-w-0 overflow-hidden break-all text-\[0\.9rem\] leading-\[18px\] text-foreground\/78"/);
  assert.doesNotMatch(APP_SOURCE, /className="min-w-0 overflow-hidden break-all text-\[0\.9rem\] leading-\[18px\]"/);
  assert.doesNotMatch(APP_SOURCE, /className="mt-1 min-w-0 text-\[0\.9rem\] leading-5"/);
});

test("团队成员卡片保留消息统计，并把 agent 名称改成和聊天记录一致的有色标题条", () => {
  assert.doesNotMatch(APP_SOURCE, /className="space-y-3"/);
  assert.doesNotMatch(APP_SOURCE, /className="space-y-1\.5"/);
  assert.match(APP_SOURCE, /calculateAgentCardListGap/);
  assert.match(APP_SOURCE, /style=\{\{ gap: `\$\{agentCardGapPx}px` \}\}/);
  assert.match(APP_SOURCE, /getAgentColorToken/);
  assert.match(APP_SOURCE, /background: color\.solid/);
  assert.match(APP_SOURCE, /color: color\.badgeText/);
  assert.match(APP_SOURCE, /className="inline-flex max-w-full shrink-0 rounded-\[8px\] px-2 py-px text-center text-\[14px\] font-semibold leading-\[1\.2\] tracking-\[0\.02em\]"/);
  assert.match(APP_SOURCE, /className="flex items-center justify-between gap-3"/);
  assert.match(APP_SOURCE, /className="rounded-full border border-\[#d8cdbd\] bg-\[#fffaf2\] px-2\.5 py-0\.5 text-\[0\.78rem\] font-semibold text-foreground\/76"/);
  assert.match(APP_SOURCE, /className="rounded-\[8px\] border px-3 py-2 text-left shadow-sm transition"/);
});

test("团队面板头部不再显示总数徽标，成员卡片右侧改成消息数量统计而不是 runs 文本", () => {
  assert.doesNotMatch(APP_SOURCE, /rounded-full bg-\[#c96f3b\] px-2\.5 py-0\.5 text-xs font-semibold text-white/);
  assert.match(APP_SOURCE, /<p className=\{PANEL_HEADER_TITLE_CLASS\}>团队<\/p>/);
  assert.match(APP_SOURCE, /messageCount: taskMessages\.filter\(\(message\) => message\.sender === agent\.name\)\.length/);
  assert.match(APP_SOURCE, /<span className="rounded-full border border-\[#d8cdbd\] bg-\[#fffaf2\] px-2\.5 py-0\.5 text-\[0\.78rem\] font-semibold text-foreground\/76">\{agent\.messageCount\}<\/span>/);
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

test("App 不再从 bootstrap.project 读取当前工作区", () => {
  assert.doesNotMatch(APP_SOURCE, /bootstrap\?\.project/);
  assert.doesNotMatch(APP_SOURCE, /project\.project\.id/);
  assert.doesNotMatch(APP_SOURCE, /ProjectSnapshot/);
});

test("App 改走浏览器 fetch 与 EventSource，而不是旧的桌面桥接 API", () => {
  assert.match(APP_SOURCE, /from "\.\/lib\/web-api"/);
  assert.match(APP_SOURCE, /bootstrapTask/);
  assert.match(APP_SOURCE, /subscribeAgentFlowEvents/);
  assert.doesNotMatch(APP_SOURCE, /launchParams\.cwd/);
  assert.doesNotMatch(APP_SOURCE, /cwd: launchParams\.cwd/);
  assert.doesNotMatch(APP_SOURCE, /window\.agentFlow/);
});
