import assert from "node:assert/strict";
import test from "node:test";

import { isOpenCodeServeCommand } from "./opencode-process-cleanup";

test("isOpenCodeServeCommand 只匹配 opencode serve 进程", () => {
  assert.equal(isOpenCodeServeCommand("opencode serve --port 4096 --hostname 127.0.0.1"), true);
  assert.equal(isOpenCodeServeCommand("node /tmp/foo.js"), false);
  assert.equal(isOpenCodeServeCommand("opencode attach http://127.0.0.1:4096 --session abc"), false);
});
