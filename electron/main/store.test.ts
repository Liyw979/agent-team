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
  const projectPath = createTempDir();
  const store = new StoreService(userDataPath);
  const projectId = "project-review-legacy";

  store.insertProject({
    id: projectId,
    path: projectPath,
    createdAt: new Date().toISOString(),
  });

  const statePath = path.join(projectPath, ".agentflow", "state.json");
  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    topology: {
      projectId: string;
      nodes: string[];
      edges: Array<{ source: string; target: string; triggerOn: string }>;
    };
  };
  persisted.topology = {
    projectId,
    nodes: ["Build", "TaskReview"],
    edges: [{ source: "Build", target: "TaskReview", triggerOn: "review" }],
  };
  fs.writeFileSync(statePath, JSON.stringify(persisted, null, 2));

  const topology = store.getTopology(projectId);
  assert.deepEqual(topology.edges, []);
});

test("StoreService 会读取 needs_revision 边的单独回流上限，并为缺省值补默认 4", () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const store = new StoreService(userDataPath);
  const projectId = "project-review-limit";

  store.insertProject({
    id: projectId,
    path: projectPath,
    createdAt: new Date().toISOString(),
  });

  const statePath = path.join(projectPath, ".agentflow", "state.json");
  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    topology: {
      projectId: string;
      nodes: string[];
      edges: Array<{ source: string; target: string; triggerOn: string; maxRevisionRounds?: number }>;
    };
  };
  persisted.topology = {
    projectId,
    nodes: ["Build", "UnitTest", "TaskReview"],
    edges: [
      { source: "UnitTest", target: "Build", triggerOn: "needs_revision" },
      { source: "TaskReview", target: "Build", triggerOn: "needs_revision", maxRevisionRounds: 6 },
    ],
  };
  fs.writeFileSync(statePath, JSON.stringify(persisted, null, 2));

  const topology = store.getTopology(projectId);
  assert.deepEqual(topology.edges, [
    { source: "UnitTest", target: "Build", triggerOn: "needs_revision", maxRevisionRounds: 4 },
    { source: "TaskReview", target: "Build", triggerOn: "needs_revision", maxRevisionRounds: 6 },
  ]);
});
