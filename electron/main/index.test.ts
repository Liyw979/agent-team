import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const MAIN_SOURCE = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("主进程在 before-quit 时会调用 orchestrator.dispose", () => {
  assert.match(MAIN_SOURCE, /app\.on\("before-quit"/);
  assert.match(MAIN_SOURCE, /orchestrator\.dispose\(\)/);
});
