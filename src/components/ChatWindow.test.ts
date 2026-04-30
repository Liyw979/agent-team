import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const CHAT_WINDOW_SOURCE = fs.readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("聊天消息头部会为 agent 消息补充 attach 按钮", () => {
  assert.match(CHAT_WINDOW_SOURCE, /resolveChatMessageAttachButtonState/);
  assert.match(CHAT_WINDOW_SOURCE, /aria-label=\{`打开 \$\{attachButtonState\.agentId\} 的 attach 终端`\}/);
  assert.match(CHAT_WINDOW_SOURCE, /<span>\{attachButtonState\.label\}<\/span>/);
  assert.match(CHAT_WINDOW_SOURCE, /onOpenAgentTerminal=\{onOpenAgentTerminal\}/);
});

test("聊天气泡头部的名称、时间、状态图标、attach 文案字号统一为 13px", () => {
  assert.match(
    CHAT_WINDOW_SOURCE,
    /className=\{cn\(\s*"inline-flex h-6 max-w-full shrink-0 items-center rounded-\[8px\] px-2 text-center text-\[13px\] font-semibold leading-\[1\.2\] tracking-\[0\.02em\]"/,
  );
  assert.match(
    CHAT_WINDOW_SOURCE,
    /className="inline-flex h-6 shrink-0 items-center text-\[13px\] leading-\[1\.2\] opacity-80"/,
  );
  assert.match(
    CHAT_WINDOW_SOURCE,
    /className="inline-flex h-6 items-center justify-center gap-1 rounded-full border border-\[#d8cdbd\] bg-\[#fffaf2\] px-2 text-\[13px\] font-semibold text-foreground\/76/,
  );
  assert.match(
    CHAT_WINDOW_SOURCE,
    /className="inline-flex h-6 items-center justify-center gap-1 rounded-full border border-\[#d8cdbd\] bg-\[#fffaf2\] px-2 text-\[13px\] font-semibold text-foreground\/76/,
  );
  assert.doesNotMatch(CHAT_WINDOW_SOURCE, /text-\[14px\]/);
  assert.doesNotMatch(CHAT_WINDOW_SOURCE, /text-\[10px\]/);
});

test("聊天区会把可见 @ 派发构造成执行气泡，并完全基于消息流派生", () => {
  assert.doesNotMatch(CHAT_WINDOW_SOURCE, /runtimeSnapshots/);
  assert.match(CHAT_WINDOW_SOURCE, /buildChatFeedItems\(\{/);
  assert.match(CHAT_WINDOW_SOURCE, /messages: task\?\.messages \?\? \[\]/);
  assert.match(CHAT_WINDOW_SOURCE, /item\.type === "execution" && item\.status !== "settled"/);
});

test("聊天执行气泡会限制最大高度，并在内部独立滚动", () => {
  assert.match(CHAT_WINDOW_SOURCE, /CHAT_EXECUTION_BUBBLE_MAX_HEIGHT_PX = 300/);
  assert.match(CHAT_WINDOW_SOURCE, /className="min-h-0 space-y-1 overflow-y-auto rounded-\[8px\] border border-black\/8 bg-white\/55 px-2 py-2"/);
  assert.match(CHAT_WINDOW_SOURCE, /maxHeight: `\$\{CHAT_EXECUTION_BUBBLE_MAX_HEIGHT_PX\}px`/);
  assert.match(CHAT_WINDOW_SOURCE, /shouldStickTopologyHistoryToBottom/);
  assert.match(CHAT_WINDOW_SOURCE, /shouldAutoScrollTopologyHistory/);
  assert.match(CHAT_WINDOW_SOURCE, /viewport\.scrollTop = viewport\.scrollHeight/);
});

test("聊天执行气泡不会把运行状态直接渲染成普通文本", () => {
  assert.doesNotMatch(CHAT_WINDOW_SOURCE, />\s*运行中\s*</);
  assert.doesNotMatch(CHAT_WINDOW_SOURCE, />\s*结果同步中\s*</);
  assert.doesNotMatch(CHAT_WINDOW_SOURCE, />\s*执行失败\s*</);
});
