import assert from "node:assert/strict";
import { test } from "bun:test";

import { renderOpenCodeCleanupReport } from "./opencode-cleanup-report";

test("renderOpenCodeCleanupReport 会输出被清理的 OpenCode 实例 PID", () => {
  assert.equal(
    renderOpenCodeCleanupReport([43127, 5120, 43127]),
    "已清理 OpenCode 实例 PID: 43127, 5120\n",
  );
});

test("renderOpenCodeCleanupReport 在没有实例可清理时不输出内容", () => {
  assert.equal(
    renderOpenCodeCleanupReport([]),
    "",
  );
});
