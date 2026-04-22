import assert from "node:assert/strict";
import test from "node:test";

import { shouldScheduleEventStreamReconnect } from "./event-stream-lifecycle";

test("shouldScheduleEventStreamReconnect 在 Orchestrator 正在销毁时返回 false", () => {
  assert.equal(
    shouldScheduleEventStreamReconnect({
      hasProjectRecord: true,
      isDisposing: true,
    }),
    false,
  );
});

test("shouldScheduleEventStreamReconnect 仅在项目仍存在且未销毁时返回 true", () => {
  assert.equal(
    shouldScheduleEventStreamReconnect({
      hasProjectRecord: true,
      isDisposing: false,
    }),
    true,
  );
  assert.equal(
    shouldScheduleEventStreamReconnect({
      hasProjectRecord: false,
      isDisposing: false,
    }),
    false,
  );
});
