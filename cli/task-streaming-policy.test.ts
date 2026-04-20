import assert from "node:assert/strict";
import test from "node:test";

import { resolveCliTaskStreamingPlan } from "./task-streaming-policy";

test("task headless 会打印完整群聊并展示 attach 命令", () => {
  assert.deepEqual(
    resolveCliTaskStreamingPlan({
      commandKind: "task.headless",
      isResume: false,
    }),
    {
      enabled: true,
      includeHistory: true,
      printAttach: true,
    },
  );
});

test("task ui 新建任务时也会打印完整群聊，避免终端静默", () => {
  assert.deepEqual(
    resolveCliTaskStreamingPlan({
      commandKind: "task.ui",
      isResume: false,
    }),
    {
      enabled: true,
      includeHistory: true,
      printAttach: true,
    },
  );
});

test("task ui 恢复已有任务时只打印命令启动后的新增消息", () => {
  assert.deepEqual(
    resolveCliTaskStreamingPlan({
      commandKind: "task.ui",
      isResume: true,
    }),
    {
      enabled: true,
      includeHistory: false,
      printAttach: false,
    },
  );
});
