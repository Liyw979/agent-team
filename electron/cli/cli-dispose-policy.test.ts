import assert from "node:assert/strict";
import test from "node:test";

import { resolveCliDisposeOptions } from "./cli-dispose-policy";

test("task run 在已经观察到任务结束后，不再等待后台 task promise 收尾", () => {
  assert.deepEqual(
    resolveCliDisposeOptions({
      commandKind: "task.run",
      observedSettledTaskState: true,
    }),
    {
      awaitPendingTaskRuns: false,
      forceProcessExit: true,
    },
  );
});

test("task show 在已经观察到任务结束后，也不再等待后台 task promise 收尾", () => {
  assert.deepEqual(
    resolveCliDisposeOptions({
      commandKind: "task.show",
      observedSettledTaskState: true,
    }),
    {
      awaitPendingTaskRuns: false,
      forceProcessExit: true,
    },
  );
});

test("未观察到任务结束前，CLI 仍然保持保守关闭策略", () => {
  assert.deepEqual(
    resolveCliDisposeOptions({
      commandKind: "task.run",
      observedSettledTaskState: false,
    }),
    {
      awaitPendingTaskRuns: true,
      forceProcessExit: false,
    },
  );
});

test("task chat 即使进入 settled，也不能强制退出进程", () => {
  assert.deepEqual(
    resolveCliDisposeOptions({
      commandKind: "task.chat",
      observedSettledTaskState: true,
    }),
    {
      awaitPendingTaskRuns: true,
      forceProcessExit: false,
    },
  );
});
