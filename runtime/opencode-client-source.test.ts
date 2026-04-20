import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const OPENCODE_CLIENT_SOURCE = fs.readFileSync(new URL("./opencode-client.ts", import.meta.url), "utf8");

test("OpenCode serve 启动进程时会把目标工作区作为 cwd 传入", () => {
  assert.match(OPENCODE_CLIENT_SOURCE, /spawn\(\s*[\s\S]*?\{\s*cwd: state\.projectPath,/);
});
