import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const STYLES_SOURCE = fs.readFileSync(new URL("./styles.css", import.meta.url), "utf8");

test("运行时 chat markdown 的 strong 样式必须显式加粗，不能继续继承正文权重", () => {
  assert.match(STYLES_SOURCE, /\.chat-markdown strong \{[\s\S]*font-weight: 700;/);
  assert.doesNotMatch(STYLES_SOURCE, /\.chat-markdown strong \{[\s\S]*font-weight: inherit;/);
});

test("运行时 chat markdown 在 inheritTypography 模式下必须回退到外层字号和行高", () => {
  assert.doesNotMatch(STYLES_SOURCE, /\.chat-markdown \{[^}]*font-size: var\(--chat-markdown-font-size, inherit\);/);
  assert.doesNotMatch(STYLES_SOURCE, /\.chat-markdown \{[^}]*line-height: var\(--chat-markdown-line-height, inherit\);/);
  assert.match(
    STYLES_SOURCE,
    /\.chat-markdown :is\(h1, h2, h3, h4, h5, h6, p, li, blockquote, th, td\) \{[\s\S]*font-size: var\(--chat-markdown-font-size, inherit\);/,
  );
  assert.match(
    STYLES_SOURCE,
    /\.chat-markdown :is\(h1, h2, h3, h4, h5, h6, p, li, blockquote, th, td\) \{[\s\S]*line-height: var\(--chat-markdown-line-height, inherit\);/,
  );
});

test("运行时 chat markdown 必须支持拓扑专用的更紧凑列表和 code 间距变量", () => {
  assert.match(STYLES_SOURCE, /padding-left: var\(--chat-markdown-list-padding-left, 1\.35rem\);/);
  assert.match(STYLES_SOURCE, /padding: var\(--chat-markdown-pre-padding, 0\.3rem 0\.65rem\);/);
  assert.match(STYLES_SOURCE, /padding: var\(--chat-markdown-inline-code-padding, 0\.12rem 0\.35rem\);/);
});
