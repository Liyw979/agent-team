import test from "node:test";
import assert from "node:assert/strict";

import { getChatMarkdownSpacing } from "./chat-markdown-spacing";

test("群聊 Markdown 段落间距缩小到当前配置的四分之一", () => {
  const spacing = getChatMarkdownSpacing();

  assert.equal(spacing.blockSpacingEm, 0.1625);
  assert.equal(spacing.listItemSpacingRem, 0.06);
});
