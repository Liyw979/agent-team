import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { StoreService } from "./store";

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-store-"));
}

test("StoreService 读取旧 review 拓扑边时不再静默兼容", () => {
  const userDataPath = createTempDir();
  const cwd = createTempDir();
  const store = new StoreService(userDataPath);
  const statePath = path.join(cwd, ".agentflow", "state.json");

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
      taskPanels: [],
      messages: [],
    }, null, 2),
  );

  const topology = store.getTopology(cwd);
  assert.deepEqual(topology.edges, []);
});

test("StoreService 会读取 needs_revision 边的单独回流上限，并为缺省值补默认 4", () => {
  const userDataPath = createTempDir();
  const cwd = createTempDir();
  const store = new StoreService(userDataPath);
  const statePath = path.join(cwd, ".agentflow", "state.json");

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
      taskPanels: [],
      messages: [],
    }, null, 2),
  );

  const topology = store.getTopology(cwd);
  assert.deepEqual(topology.edges, [
    { source: "UnitTest", target: "Build", triggerOn: "needs_revision", maxRevisionRounds: 4 },
    { source: "TaskReview", target: "Build", triggerOn: "needs_revision", maxRevisionRounds: 6 },
  ]);
});
