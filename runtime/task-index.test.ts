import test from "node:test";
import assert from "node:assert/strict";

import {
  findTaskLocatorCwd,
  removeTaskLocatorEntry,
  upsertTaskLocatorEntry,
  type TaskLocatorEntry,
} from "./task-index";

test("findTaskLocatorCwd 可以按 taskId 脱离当前 cwd 直接找到任务工作区", () => {
  const entries: TaskLocatorEntry[] = [
    { taskId: "task-a", cwd: "/tmp/workspace-a" },
    { taskId: "task-b", cwd: "/tmp/workspace-b" },
  ];

  assert.equal(findTaskLocatorCwd(entries, "task-b"), "/tmp/workspace-b");
  assert.equal(findTaskLocatorCwd(entries, "missing-task"), null);
});

test("upsertTaskLocatorEntry 会按 taskId 覆盖旧工作区，避免同一任务残留脏索引", () => {
  const entries: TaskLocatorEntry[] = [
    { taskId: "task-a", cwd: "/tmp/workspace-a" },
  ];

  assert.deepEqual(
    upsertTaskLocatorEntry(entries, { taskId: "task-a", cwd: "/tmp/workspace-a-next" }),
    [{ taskId: "task-a", cwd: "/tmp/workspace-a-next" }],
  );
});

test("removeTaskLocatorEntry 会删除指定 taskId 的索引", () => {
  const entries: TaskLocatorEntry[] = [
    { taskId: "task-a", cwd: "/tmp/workspace-a" },
    { taskId: "task-b", cwd: "/tmp/workspace-b" },
  ];

  assert.deepEqual(removeTaskLocatorEntry(entries, "task-a"), [
    { taskId: "task-b", cwd: "/tmp/workspace-b" },
  ]);
});
