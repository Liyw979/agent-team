import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function readMainModuleSource(fileName: string): string {
  return readFileSync(path.join(import.meta.dirname, fileName), "utf8");
}

function extractTestTitles(source: string): string[] {
  return [...source.matchAll(/test\("([^"]+)"/g)].map((match) => match[1] ?? "");
}

test("scheduler script harness 仍保留 expectedDecisions 能力供对照", () => {
  const source = readMainModuleSource("scheduler-script-harness.ts");

  assert.equal(
    source.includes("expectedDecisions"),
    true,
    "scheduler-script-harness.ts 仍需保留 expectedDecisions，作为旧 harness 行为对照基线",
  );
});

test("emulator 迁移脚本测试直接走 scheduler-script-emulator 而不是 harness", () => {
  const source = readMainModuleSource("scheduler-script-emulator-migration.test.ts");

  assert.equal(
    source.includes('from "./scheduler-script-emulator"'),
    true,
    "迁移后的顺序脚本测试必须直接调用 scheduler-script-emulator",
  );
  assert.equal(
    source.includes('from "./scheduler-script-harness"'),
    false,
    "迁移后的顺序脚本测试不能再通过 scheduler-script-harness 间接运行",
  );
});

test("emulator 迁移脚本测试和 harness 对照测试保持相同数量与标题顺序", () => {
  const harnessTitles = extractTestTitles(readMainModuleSource("scheduler-script-harness.test.ts"));
  const emulatorTitles = extractTestTitles(readMainModuleSource("scheduler-script-emulator-migration.test.ts"));

  assert.deepEqual(
    emulatorTitles,
    harnessTitles,
    "scheduler-script-emulator-migration.test.ts 必须和 scheduler-script-harness.test.ts 保持一一对应，方便逐条对比",
  );
});
