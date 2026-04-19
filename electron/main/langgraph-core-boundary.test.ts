import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function readMainModuleSource(fileName: string): string {
  return readFileSync(path.join(import.meta.dirname, fileName), "utf8");
}

test("LangGraph 核心模块不再直接依赖旧 orchestrator-scheduler", () => {
  const graphModules = [
    "gating-state.ts",
    "gating-router.ts",
  ];

  for (const fileName of graphModules) {
    const source = readMainModuleSource(fileName);
    assert.equal(
      source.includes("\"./orchestrator-scheduler\"") || source.includes("'./orchestrator-scheduler'"),
      false,
      `${fileName} 仍然直接依赖 ./orchestrator-scheduler`,
    );
  }
});
