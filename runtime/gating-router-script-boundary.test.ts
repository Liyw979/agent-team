import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function readMainModuleSource(fileName: string): string {
  return readFileSync(path.join(import.meta.dirname, fileName), "utf8");
}

test("gating-router 状态流转回归场景优先迁移到 scheduler script 测试", () => {
  const source = readMainModuleSource("gating-router.test.ts");

  assert.equal(
    source.includes("同一 reviewer 连续第 5 次回流修复时会直接终止，避免无限循环"),
    false,
    "gating-router.test.ts 不应该再保留可迁移到 script 的循环上限场景",
  );
  assert.equal(
    source.includes("needs_revision 边支持单独配置更小的回流上限"),
    false,
    "gating-router.test.ts 不应该再保留可迁移到 script 的 maxRevisionRounds 场景",
  );
  assert.equal(
    source.includes("同一 reviewer 连续 4 次回流后，只要第 5 次改为通过，流程仍然允许继续"),
    false,
    "gating-router.test.ts 不应该再保留可迁移到 script 的回流通过边界场景",
  );
});
