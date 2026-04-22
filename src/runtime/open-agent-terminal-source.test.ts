import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ORCHESTRATOR_SOURCE = fs.readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");

test("openAgentTerminal 会通过服务端终端启动器拉起 attach 会话", () => {
  assert.match(ORCHESTRATOR_SOURCE, /await this\.launchAgentTerminal\(/);
});
