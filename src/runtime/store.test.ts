import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { StoreService } from "./store";

const LEGACY_WORKSPACE_STATE_BASENAME = ["state", "json"].join(".");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-store-"));
}

test("StoreService 在空工作区读取时不会物化旧工作区快照文件", () => {
  const cwd = createTempDir();
  const store = new StoreService();

  const state = store.getState(cwd);

  assert.deepEqual(state.tasks, []);
  assert.equal(fs.existsSync(path.join(cwd, ".agent-team", LEGACY_WORKSPACE_STATE_BASENAME)), false);
});

test("StoreService 会在内存里保存 topology / tasks / taskAgents / messages", () => {
  const cwd = createTempDir();
  const store = new StoreService();

  store.upsertTopology(cwd, {
    nodes: ["Build"],
    edges: [],
    langgraph: {
      start: {
        id: "__start__",
        targets: ["Build"],
      },
      end: null,
    },
  });
  store.insertTask({
    id: "task-1",
    title: "demo",
    status: "running",
    cwd,
    opencodeSessionId: "runtime-session",
    agentCount: 1,
    createdAt: "2026-04-21T00:00:00.000Z",
    completedAt: null,
    initializedAt: null,
  });
  store.insertTaskAgent(cwd, {
          taskId: "task-1",
    id: "Build",
    opencodeSessionId: "agent-session",
    opencodeAttachBaseUrl: "http://127.0.0.1:4999",
    status: "running",
    runCount: 1,
  });
  store.insertMessage(cwd, {
    id: "message-1",
    taskId: "task-1",
    sender: "system",
    content: "Task 已创建",
    timestamp: "2026-04-21T00:00:01.000Z",
    kind: "system-message",
  });

  assert.equal(store.getTopology(cwd).nodes[0], "Build");
  assert.equal(store.getTask(cwd, "task-1").opencodeSessionId, "runtime-session");
  assert.equal(store.listTaskAgents(cwd, "task-1")[0]?.opencodeAttachBaseUrl, "http://127.0.0.1:4999");
  assert.equal(store.listMessages(cwd, "task-1")[0]?.id, "message-1");
  assert.equal(fs.existsSync(path.join(cwd, ".agent-team", LEGACY_WORKSPACE_STATE_BASENAME)), false);
});

test("StoreService 会在内存里维护 task locator，并在删除任务时清掉索引", () => {
  const cwd = createTempDir();
  const store = new StoreService();

  store.insertTask({
    id: "task-1",
    title: "demo",
    status: "pending",
    cwd,
    opencodeSessionId: null,
    agentCount: 0,
    createdAt: "2026-04-21T00:00:00.000Z",
    completedAt: null,
    initializedAt: null,
  });

  assert.equal(store.getTaskLocatorCwd("task-1"), cwd);
  store.deleteTask(cwd, "task-1");
  assert.equal(store.getTaskLocatorCwd("task-1"), null);
});
