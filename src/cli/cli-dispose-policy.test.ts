import assert from "node:assert/strict";
import { test } from "bun:test";

import { resolveCliDisposeOptions } from "./cli-dispose-policy";

test("未观察到任务结束前，CLI 仍然保持保守关闭策略", () => {
  assert.deepEqual(
    resolveCliDisposeOptions({
      observedSettledTaskState: false,
    }),
    {
      awaitPendingTaskRuns: true,
      forceProcessExit: false,
      keepAliveUntilSignal: false,
      shouldDisposeContext: true,
    },
  );
});

test("task ui 在任务结束后会保持驻留，等待 Ctrl+C 时再清理", () => {
  assert.deepEqual(
    resolveCliDisposeOptions({
      observedSettledTaskState: true,
    }),
    {
      awaitPendingTaskRuns: true,
      forceProcessExit: false,
      keepAliveUntilSignal: true,
      shouldDisposeContext: false,
    },
  );
});
