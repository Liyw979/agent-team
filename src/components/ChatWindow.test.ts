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

test("聊天消息头部的 attach 按钮需要比 agent 名称更紧凑", () => {
  assert.match(
    CHAT_WINDOW_SOURCE,
    /className="inline-flex h-6 items-center justify-center gap-1 rounded-full border border-\[#d8cdbd\] bg-\[#fffaf2\] px-2 text-\[10px\] font-semibold text-foreground\/76/,
  );
  assert.match(CHAT_WINDOW_SOURCE, /className="h-3 w-3"/);
  assert.doesNotMatch(CHAT_WINDOW_SOURCE, /className="inline-flex h-7 items-center justify-center gap-1 rounded-full border border-\[#d8cdbd\] bg-\[#fffaf2\] px-2\.5 text-\[11px\] font-semibold text-foreground\/76/);
  assert.doesNotMatch(CHAT_WINDOW_SOURCE, /className="h-3\.5 w-3\.5"/);
});
