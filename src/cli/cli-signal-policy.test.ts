import assert from "node:assert/strict";
import { test } from "bun:test";

import { resolveCliSignalPlan } from "./cli-signal-policy";

test("Ctrl+C 会为当前 CLI 会话触发 opencode 清理并快速退出", () => {
  assert.deepEqual(
    resolveCliSignalPlan({
      signal: "SIGINT",
    }),
    {
      shouldCleanupOpencode: true,
      awaitPendingTaskRuns: false,
      exitCode: 130,
    },
  );
});
