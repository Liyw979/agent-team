import test from "node:test";
import assert from "node:assert/strict";

import { stripTrailingFollowUpOffer } from "./chat-messages";

test("stripTrailingFollowUpOffer 会移除尾部继续协助提议", () => {
  const content = `已把重复校验收成一条统一路径。

验证结果：
\`10 passed\`

如果你愿意，我可以继续把函数和测试再压到一个更极简、但仍可读的版本。`;

  assert.equal(
    stripTrailingFollowUpOffer(content),
    `已把重复校验收成一条统一路径。

验证结果：
\`10 passed\``,
  );
});

test("stripTrailingFollowUpOffer 不会误删普通正文", () => {
  const content = `下面是将你的原始 User Story 润色后的可执行需求说明，供实现方直接推进。

## 备注
如果你希望，我会把需求文档整理成接口定义。`;

  assert.equal(stripTrailingFollowUpOffer(content), content);
});
