import assert from "node:assert/strict";
import test from "node:test";

import { isOpenCodeServeCommand } from "./opencode-process-cleanup";

test("isOpenCodeServeCommand 只匹配 opencode serve 进程", () => {
  assert.equal(isOpenCodeServeCommand("opencode serve"), true);
  assert.equal(isOpenCodeServeCommand("node /tmp/foo.js"), false);
  assert.equal(isOpenCodeServeCommand("opencode attach http://127.0.0.1:43127 --session abc"), false);
});
