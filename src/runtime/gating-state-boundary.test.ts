import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function readMainModuleSource(fileName: string): string {
  return readFileSync(path.join(import.meta.dirname, fileName), "utf8");
}

test("gating-scheduler 不再声明运行时 state 类型", () => {
  const source = readMainModuleSource("gating-scheduler.ts");

  assert.equal(
    source.includes("export interface GatingSourceRevisionState"),
    false,
    "gating-scheduler.ts 不应该再声明 GatingSourceRevisionState",
  );
  assert.equal(
    source.includes("export interface GatingHandoffDispatchBatchState"),
    false,
    "gating-scheduler.ts 不应该再声明 GatingHandoffDispatchBatchState",
  );
  assert.equal(
    source.includes("export interface GatingSchedulerRuntimeState"),
    false,
    "gating-scheduler.ts 不应该再声明 GatingSchedulerRuntimeState",
  );
});
