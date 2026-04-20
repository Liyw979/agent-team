import assert from "node:assert/strict";
import test from "node:test";

import {
  getUiHostStatePath,
  isUiHostStateReusable,
  normalizeUiHostStateRecord,
} from "./ui-host-state";

test("getUiHostStatePath 会把运行态持久化到工作区 .agentflow/ui-host.json", () => {
  assert.equal(
    getUiHostStatePath("/tmp/demo"),
    "/tmp/demo/.agentflow/ui-host.json",
  );
});

test("normalizeUiHostStateRecord 只接受完整且可复用的 host 记录", () => {
  assert.deepEqual(
    normalizeUiHostStateRecord({
      pid: 123,
      port: 4310,
      cwd: "/tmp/demo",
      taskId: "task-1",
      startedAt: "2026-04-20T00:00:00.000Z",
      version: "0.1.0",
    }),
    {
      pid: 123,
      port: 4310,
      cwd: "/tmp/demo",
      taskId: "task-1",
      startedAt: "2026-04-20T00:00:00.000Z",
      version: "0.1.0",
    },
  );

  assert.equal(normalizeUiHostStateRecord({ port: 4310 }), null);
});

test("isUiHostStateReusable 只在 cwd/taskId/version 匹配时复用已存在 host", () => {
  const record = {
    pid: 123,
    port: 4310,
    cwd: "/tmp/demo",
    taskId: "task-1",
    startedAt: "2026-04-20T00:00:00.000Z",
    version: "0.1.0",
  } as const;

  assert.equal(
    isUiHostStateReusable(record, {
      cwd: "/tmp/demo",
      taskId: "task-1",
      version: "0.1.0",
    }),
    true,
  );
  assert.equal(
    isUiHostStateReusable(record, {
      cwd: "/tmp/demo",
      taskId: "task-2",
      version: "0.1.0",
    }),
    false,
  );
  assert.equal(
    isUiHostStateReusable(record, {
      cwd: "/tmp/demo",
      taskId: "task-1",
      version: "0.2.0",
    }),
    false,
  );
});
