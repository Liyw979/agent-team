import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { renderAgentHistoryDetailToStaticHtml } from "./agent-history-markdown";

const AGENT_HISTORY_MARKDOWN_SOURCE = fs.readFileSync(
  new URL("./agent-history-markdown.tsx", import.meta.url),
  "utf8",
);

test("拓扑历史详情会把 Markdown 渲染成 HTML", () => {
  const html = renderAgentHistoryDetailToStaticHtml("**已验证**\n\n- 补充断言");

  assert.match(html, /<strong data-chat-markdown-role="strong">已验证<\/strong>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<li>补充断言<\/li>/);
});

test("拓扑历史 Markdown 保留拓扑自身字号，而不是被聊天 Markdown 的内联字号覆盖", () => {
  const html = renderAgentHistoryDetailToStaticHtml("已验证");

  assert.doesNotMatch(html, /--chat-markdown-font-size:/);
  assert.doesNotMatch(html, /--chat-markdown-line-height:/);
});

test("拓扑历史 markdown 必须继续走 inheritTypography，而不是重新复用消息记录的 typography 样式", () => {
  assert.match(AGENT_HISTORY_MARKDOWN_SOURCE, /<MarkdownMessage[\s\S]*content=\{content\}[\s\S]*className=\{className\}[\s\S]*inheritTypography/);
  assert.match(AGENT_HISTORY_MARKDOWN_SOURCE, /style=\{AGENT_HISTORY_MARKDOWN_STYLE\}/);
  assert.doesNotMatch(AGENT_HISTORY_MARKDOWN_SOURCE, /getChatMarkdownTypographyStyle/);
});

test("拓扑历史 markdown 需要自己的紧凑 spacing 变量，不能继续共用消息记录的列表缩进和 code padding", () => {
  const html = renderAgentHistoryDetailToStaticHtml("我认同。\n\n- `add_tool.py` 只有一行核心逻辑\n- 没有多余中间变量");

  assert.match(html, /--chat-markdown-block-spacing:0\.08em/);
  assert.match(html, /--chat-markdown-list-item-spacing:0\.02rem/);
  assert.match(html, /--chat-markdown-list-padding-left:0\.92rem/);
  assert.match(html, /--chat-markdown-inline-code-padding:0\.04rem 0\.22rem/);
  assert.match(html, /--chat-markdown-pre-padding:0\.18rem 0\.42rem/);
});
