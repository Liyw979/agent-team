import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("gating-router 不应保留 finished 包装 helper", () => {
  const source = readFileSync(new URL("./gating-router.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /\bfunction\s+finishGraphTask\s*\(/u);
  assert.doesNotMatch(source, /\bfunction\s+finishGraphTaskFromPlan\s*\(/u);
});
