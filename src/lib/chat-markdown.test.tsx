import test from "node:test";
import assert from "node:assert/strict";

import { renderMarkdownToStaticHtml } from "./chat-markdown";

test("renderMarkdownToStaticHtml 会把标题列表和代码块渲染成 HTML", () => {
  const html = renderMarkdownToStaticHtml("## 已完成\n\n- 补充测试\n- 修复渲染\n\n```ts\nconst done = true;\n```");

  assert.match(html, /<h2>已完成<\/h2>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<li>补充测试<\/li>/);
  assert.match(html, /<pre>/);
  assert.match(html, /<code/);
  assert.match(html, /--chat-markdown-block-spacing:0\.1625em/);
  assert.match(html, /--chat-markdown-list-item-spacing:0\.06rem/);
  assert.match(html, /--chat-markdown-font-size:0\.875rem/);
  assert.match(html, /--chat-markdown-heading-font-size:1em/);
  assert.match(html, /--chat-markdown-code-font-size:1em/);
});
