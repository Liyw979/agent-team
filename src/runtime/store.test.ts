import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildTopologyNodeRecords, toUtcIsoTimestamp } from "@shared/types";

import { StoreService } from "./store";

const LEGACY_WORKSPACE_STATE_BASENAME = ["state", "json"].join(".");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-store-"));
}

test("StoreService 在空工作区读取时不会物化旧工作区快照文件", () => {
  const cwd = createTempDir();
  const store = new StoreService();

  const state = store.getState();

  assert.deepEqual(state.taskSlot, { kind: "empty" });
  assert.equal(fs.existsSync(path.join(cwd, ".agent-team", LEGACY_WORKSPACE_STATE_BASENAME)), false);
});

test("StoreService 会在内存里保存 topology / task / taskAgents / messages", () => {
  const cwd = createTempDir();
  const store = new StoreService();

  store.upsertTopology({
    nodes: ["Build"],
    edges: [],
    flow: {
      start: {
        id: "__start__",
        targets: ["Build"],
      },
      end: {
        id: "__end__",
        sources: [],
        incoming: [],
      },
    },
    nodeRecords: buildTopologyNodeRecords({
      nodes: ["Build"],
      groupNodeIds: new Set(),
      templateNameByNodeId: new Map(),
      initialMessageRoutingByNodeId: new Map(),
      groupRuleIdByNodeId: new Map(),
      groupEnabledNodeIds: new Set(),
      promptByNodeId: new Map(),
      writableNodeIds: new Set(),
    }),
  });
  store.insertTask({
    id: "task-1",
    title: "demo",
    status: "running",
    cwd,
    agentCount: 1,
    createdAt: "2026-04-21T00:00:00.000Z",
    completedAt: "",
    initializedAt: "",
  });
  store.insertTaskAgent({
    id: "Build",
    opencodeSessionId: "agent-session",
    opencodeAttachBaseUrl: "http://127.0.0.1:4999",
    status: "running",
    runCount: 1,
  });
  store.insertMessage({
    id: "message-1",
    sender: "system",
    content: "Task 已创建",
    timestamp: toUtcIsoTimestamp("2026-04-21T00:00:01.000Z"),
    kind: "system-message",
  });

  assert.equal(store.getTopology().nodes[0], "Build");
  assert.equal(store.getTask().createdAt, "2026-04-21T00:00:00.000Z");
  assert.equal(store.listTaskAgents()[0]?.opencodeAttachBaseUrl, "http://127.0.0.1:4999");
  assert.equal(store.listMessages()[0]?.id, "message-1");
  assert.equal(fs.existsSync(path.join(cwd, ".agent-team", LEGACY_WORKSPACE_STATE_BASENAME)), false);
});
