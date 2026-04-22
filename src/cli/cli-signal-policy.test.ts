import assert from "node:assert/strict";
import test from "node:test";

import { resolveCliSignalPlan } from "./cli-signal-policy";

test("Ctrl+C 会为当前 CLI 会话触发 opencode 清理并快速退出", () => {
  assert.deepEqual(
    resolveCliSignalPlan({
      commandKind: "task.ui",
      signal: "SIGINT",
    }),
    {
      shouldCleanupOpencode: true,
      awaitPendingTaskRuns: false,
      exitCode: 130,
    },
  );
});
