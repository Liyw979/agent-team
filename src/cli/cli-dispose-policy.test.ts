import assert from "node:assert/strict";
import test from "node:test";

import { resolveCliDisposeOptions } from "./cli-dispose-policy";

test("task headless 在已经观察到任务结束后，不再等待后台 task promise 收尾", () => {
  assert.deepEqual(
    resolveCliDisposeOptions({
      commandKind: "task.headless",
      observedSettledTaskState: true,
    }),
    {
      awaitPendingTaskRuns: false,
      forceProcessExit: true,
      keepAliveUntilSignal: false,
      shouldDisposeContext: true,
    },
  );
});

test("未观察到任务结束前，CLI 仍然保持保守关闭策略", () => {
  assert.deepEqual(
    resolveCliDisposeOptions({
      commandKind: "task.headless",
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
      commandKind: "task.ui",
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
