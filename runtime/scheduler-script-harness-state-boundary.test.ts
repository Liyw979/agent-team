import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function readMainModuleSource(fileName: string): string {
  return readFileSync(path.join(import.meta.dirname, fileName), "utf8");
}

test("scheduler script harness 支持在脚本测试里断言中间状态与调度决策", () => {
  const source = readMainModuleSource("scheduler-script-harness.ts");

  assert.equal(
    source.includes("expectedDecisions"),
    true,
    "scheduler-script-harness.ts 需要支持 expectedDecisions，才能把 waiting/finished/execute_batch 这类状态流转从 router 测试迁到 script 测试",
  );
});
