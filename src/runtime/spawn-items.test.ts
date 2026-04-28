import assert from "node:assert/strict";
import test from "node:test";

import { extractSpawnItemsFromContent } from "./spawn-items";

test("extractSpawnItemsFromContent 默认读取 JSON 里的 items 数组", () => {
  const parsed = extractSpawnItemsFromContent(`{"items":[{"title":"路径穿越"},{"title":"鉴权缺失"}]}`);

  assert.deepEqual(parsed.items, [
    { id: "item-1", title: "路径穿越" },
    { id: "item-2", title: "鉴权缺失" },
  ]);
});

test("extractSpawnItemsFromContent 支持 JSON5 语法与代码块", () => {
  const parsed = extractSpawnItemsFromContent(`
\`\`\`json5
{
  items: [
    { id: "finding-1", title: "路径穿越" },
    { title: "鉴权缺失" },
  ],
}
\`\`\`
`);

  assert.deepEqual(parsed.items, [
    { id: "finding-1", title: "路径穿越" },
    { id: "item-2", title: "鉴权缺失" },
  ]);
});

test("extractSpawnItemsFromContent 只读取固定 items 字段", () => {
  assert.throws(
    () => extractSpawnItemsFromContent(`{"summary":"无 findings"}`),
    /items/,
  );
});

test("extractSpawnItemsFromContent 在目标字段不是数组时返回明确错误", () => {
  assert.throws(
    () => extractSpawnItemsFromContent(`{"items":{"title":"不是数组"}}`),
    /数组/,
  );
});
