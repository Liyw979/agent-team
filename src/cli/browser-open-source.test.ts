import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const CLI_SOURCE = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("task ui 打开浏览器时直接使用 open 包", () => {
  assert.match(CLI_SOURCE, /import open from "open";/);
  assert.match(CLI_SOURCE, /await open\(url\);/);
});
