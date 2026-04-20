import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const INDEX_HTML_SOURCE = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("页面 title 使用 Agent-Teams", () => {
  assert.match(INDEX_HTML_SOURCE, /<title>Agent-Teams<\/title>/);
  assert.doesNotMatch(INDEX_HTML_SOURCE, /<title>OpenCode Agent 编排工具<\/title>/);
});
