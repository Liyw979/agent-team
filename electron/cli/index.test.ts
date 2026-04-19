import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const CLI_SOURCE = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("CLI 不再兼容旧的 review relation 别名", () => {
  assert.doesNotMatch(CLI_SOURCE, /relation === "review"/);
});
