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
