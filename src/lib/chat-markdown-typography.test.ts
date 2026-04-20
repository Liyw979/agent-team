import test from "node:test";
import assert from "node:assert/strict";

import { getChatMarkdownTypography, isChatMarkdownFontSizeUnified } from "./chat-markdown-typography";

test("群聊 Markdown 字号配置统一正文、标题和代码字号", () => {
  const typography = getChatMarkdownTypography();

  assert.equal(isChatMarkdownFontSizeUnified(typography), true);
});
