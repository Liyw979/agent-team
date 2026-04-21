import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { StoreService, shouldMaterializeWorkspaceState } from "./store";

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-store-"));
}

test("只读访问缺失工作区状态时不应物化 .agent-team 目录", () => {
  assert.equal(shouldMaterializeWorkspaceState({
    accessMode: "read",
    stateFileExists: false,
    rawState: null,
  }), false);
});

test("写模式读到已存在但为空的 state.json 时，不应重置成默认空状态", () => {
  assert.equal(shouldMaterializeWorkspaceState({
    accessMode: "write",
    stateFileExists: true,
    rawState: "",
  }), false);
});

test("StoreService 读取旧 review 拓扑边时不再静默兼容", () => {
  const userDataPath = createTempDir();
  const cwd = createTempDir();
  const store = new StoreService(userDataPath);
  const statePath = path.join(cwd, ".agent-team", "state.json");

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      topology: {
        nodes: ["Build", "TaskReview"],
        edges: [{ source: "Build", target: "TaskReview", triggerOn: "review" }],
      },
      tasks: [],
      taskAgents: [],
      messages: [],
    }, null, 2),
  );

  const topology = store.getTopology(cwd);
  assert.deepEqual(topology.edges, []);
});

test("StoreService 读到已存在但为空的 state.json 时会直接报错，而不是静默重置整个状态", () => {
  const userDataPath = createTempDir();
  const cwd = createTempDir();
  const store = new StoreService(userDataPath);
  const statePath = path.join(cwd, ".agent-team", "state.json");

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, "", "utf8");

  assert.throws(
    () => store.getState(cwd),
    /state\.json 已存在但内容为空/,
  );
});

test("StoreService 会读取 needs_revision 边的单独回流上限，并为缺省值补默认 4", () => {
  const userDataPath = createTempDir();
  const cwd = createTempDir();
  const store = new StoreService(userDataPath);
  const statePath = path.join(cwd, ".agent-team", "state.json");

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      topology: {
        nodes: ["Build", "UnitTest", "TaskReview"],
        edges: [
          { source: "UnitTest", target: "Build", triggerOn: "needs_revision" },
          { source: "TaskReview", target: "Build", triggerOn: "needs_revision", maxRevisionRounds: 6 },
        ],
      },
      tasks: [],
      taskAgents: [],
      messages: [],
    }, null, 2),
  );

  const topology = store.getTopology(cwd);
  assert.deepEqual(topology.edges, [
    { source: "UnitTest", target: "Build", triggerOn: "needs_revision", maxRevisionRounds: 4 },
    { source: "TaskReview", target: "Build", triggerOn: "needs_revision", maxRevisionRounds: 6 },
  ]);
});

test("StoreService 读取旧 topology 时会补齐 LangGraph START，并把缺省 END 规范化为 null", () => {
  const userDataPath = createTempDir();
  const cwd = createTempDir();
  const store = new StoreService(userDataPath);
  const statePath = path.join(cwd, ".agent-team", "state.json");

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      topology: {
        nodes: ["BA", "Build"],
        edges: [{ source: "BA", target: "Build", triggerOn: "association" }],
      },
      tasks: [],
      taskAgents: [],
      messages: [],
    }, null, 2),
  );

  const topology = store.getTopology(cwd);
  assert.deepEqual(topology.langgraph, {
    start: {
      id: "__start__",
      targets: ["BA"],
    },
    end: null,
  });
});

test("StoreService 读取旧 state 时会忽略已持久化的 OpenCode session/attach 地址", () => {
  const userDataPath = createTempDir();
  const cwd = createTempDir();
  const store = new StoreService(userDataPath);
  const statePath = path.join(cwd, ".agent-team", "state.json");

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      topology: {
        nodes: ["Build"],
        edges: [],
      },
      tasks: [
        {
          id: "task-1",
          title: "demo",
          status: "running",
          cwd,
          opencodeSessionId: "legacy-task-session",
          agentCount: 1,
          createdAt: "2026-04-21T00:00:00.000Z",
          completedAt: null,
          initializedAt: null,
        },
      ],
      taskAgents: [
        {
          id: "task-1:Build",
          taskId: "task-1",
          name: "Build",
          opencodeSessionId: "legacy-agent-session",
          opencodeAttachBaseUrl: "http://127.0.0.1:4999",
          status: "running",
          runCount: 1,
        },
      ],
      messages: [],
    }, null, 2),
  );

  const [task] = store.listTasks(cwd);
  const [agent] = store.listTaskAgents(cwd, "task-1");

  assert.equal(task?.opencodeSessionId ?? null, null);
  assert.equal(agent?.opencodeSessionId ?? null, null);
  assert.equal(agent?.opencodeAttachBaseUrl ?? null, null);
});

test("StoreService 写回 state.json 时不会落盘 OpenCode session/attach 地址", () => {
  const userDataPath = createTempDir();
  const cwd = createTempDir();
  const store = new StoreService(userDataPath);

  store.insertTask({
    id: "task-1",
    title: "demo",
    status: "running",
    cwd,
    opencodeSessionId: "runtime-only-task-session",
    agentCount: 1,
    createdAt: "2026-04-21T00:00:00.000Z",
    completedAt: null,
    initializedAt: null,
  });
  store.insertTaskAgent(cwd, {
    id: "task-1:Build",
    taskId: "task-1",
    name: "Build",
    opencodeSessionId: "runtime-only-agent-session",
    opencodeAttachBaseUrl: "http://127.0.0.1:4999",
    status: "running",
    runCount: 1,
  });

  const statePath = path.join(cwd, ".agent-team", "state.json");
  const raw = fs.readFileSync(statePath, "utf8");

  assert.doesNotMatch(raw, /runtime-only-task-session/);
  assert.doesNotMatch(raw, /runtime-only-agent-session/);
  assert.doesNotMatch(raw, /127\.0\.0\.1:4999/);
  assert.doesNotMatch(raw, /"opencodeSessionId"/);
  assert.doesNotMatch(raw, /"opencodeAttachBaseUrl"/);
});
