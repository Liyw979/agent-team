import test from "node:test";
import assert from "node:assert/strict";

import {
  getChatMarkdownTypography,
  getChatMarkdownTypographyStyle,
  getMessageMarkdownTypography,
  isChatMarkdownFontSizeUnified,
} from "./chat-markdown-typography";

test("群聊 Markdown 字号配置统一正文、标题和代码字号", () => {
  const typography = getChatMarkdownTypography();

  assert.equal(typography.bodyFontSizeRem, 0.8125);
  assert.equal(typography.codeFontSizeEm, 1);
  assert.equal(isChatMarkdownFontSizeUnified(typography), true);
  assert.equal(typography.lineHeightEm, 1.36);
});

test("群聊 Markdown typography 样式只服务消息记录，不应再要求拓扑历史共用同一套字号变量", () => {
  const style = getChatMarkdownTypographyStyle();
  const messageTypography = getMessageMarkdownTypography();

  assert.equal(style["--chat-markdown-font-size"], "0.8125rem");
  assert.equal(style["--chat-markdown-line-height"], "1.36em");
  assert.equal(messageTypography.bodyFontSizeRem, 0.8125);
  assert.equal(messageTypography.lineHeightEm, 1.36);
});
