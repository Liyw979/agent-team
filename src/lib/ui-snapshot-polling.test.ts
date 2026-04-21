import test from "node:test";
import assert from "node:assert/strict";

import { getUiSnapshotPollingIntervalMs } from "./ui-snapshot-polling";

test("存在 taskId 时，UI 必须开启 ui snapshot 轮询兜底，避免跨进程 web-host 收不到任务事件时群聊停在初始快照", () => {
  assert.equal(getUiSnapshotPollingIntervalMs("531a6e8a-8fdd-4ba9-9751-cd8a9d498507"), 1000);
});

test("缺少 taskId 时，不应启动 ui snapshot 轮询", () => {
  assert.equal(getUiSnapshotPollingIntervalMs(""), null);
  assert.equal(getUiSnapshotPollingIntervalMs("   "), null);
});
