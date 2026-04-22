import test from "node:test";
import assert from "node:assert/strict";

import { shouldRefreshForRuntimeEvent } from "./runtime-event-refresh";

test("shouldRefreshForRuntimeEvent 在同一 task 的 spawn 新 session 到达时仍然会触发刷新", () => {
  assert.equal(shouldRefreshForRuntimeEvent({
    currentTaskId: "task-1",
    payload: {
      taskId: "task-1",
      sessionId: "ses-new-spawn",
      timestamp: "2026-04-22T06:10:00.000Z",
    },
  }), true);
});

test("shouldRefreshForRuntimeEvent 会忽略其它 task 的 runtime 更新事件", () => {
  assert.equal(shouldRefreshForRuntimeEvent({
    currentTaskId: "task-1",
    payload: {
      taskId: "task-2",
      sessionId: "ses-other-task",
      timestamp: "2026-04-22T06:10:00.000Z",
    },
  }), false);
});
