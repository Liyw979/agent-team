// 2026-05-26: 用户要求 UI 轮询 OpenCode 过程消息的间隔改为 3 秒，避免多 Agent 运行时查询过密。
import { test } from "bun:test";
import assert from "node:assert/strict";

import { getUiSnapshotPollingIntervalMs } from "./ui-snapshot-polling";

test("单进程单 task 模型下，UI 必须持续开启 ui snapshot 轮询", () => {
  assert.equal(getUiSnapshotPollingIntervalMs(), 3000);
});
