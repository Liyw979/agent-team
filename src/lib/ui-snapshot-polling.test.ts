import { test } from "bun:test";
import assert from "node:assert/strict";

import { getUiSnapshotPollingIntervalMs } from "./ui-snapshot-polling";

test("单进程单 task 模型下，UI 必须持续开启 ui snapshot 轮询", () => {
  assert.equal(getUiSnapshotPollingIntervalMs(), 500);
});
