import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { isSupportedTopologyFile, loadTeamDslDefinitionFile } from "./topology-file";

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-topology-file-"));
}

function singleNode(nodes: Array<{ id: string }>) {
  assert.equal(nodes.length, 1);
  const [node = assert.fail("缺少拓扑节点")] = nodes;
  return node;
}

test("loadTeamDslDefinitionFile 读取 .yaml 文件时支持 YAML 语法", () => {
  const tempDir = createTempDir();
  const filePath = path.join(tempDir, "team.topology.yaml");
  fs.writeFileSync(filePath, `entry: BA
nodes:
  - type: agent
    id: BA
    system_prompt: 你是 BA。
    writable: false
links: []
`, "utf8");

  const parsed = loadTeamDslDefinitionFile<{
    entry: string;
    nodes: Array<{ id: string }>;
  }>(filePath);

  assert.equal(parsed.entry, "BA");
  assert.equal(singleNode(parsed.nodes).id, "BA");
});

test("isSupportedTopologyFile 只接受 .yaml 与 .yml", () => {
  assert.equal(isSupportedTopologyFile("/tmp/a.json"), false);
  assert.equal(isSupportedTopologyFile("/tmp/a.toml"), false);
  assert.equal(isSupportedTopologyFile("/tmp/a.yaml"), true);
  assert.equal(isSupportedTopologyFile("/tmp/a.yml"), true);
});

test("loadTeamDslDefinitionFile 会拒绝 .json 拓扑文件", () => {
  const tempDir = createTempDir();
  const filePath = path.join(tempDir, "team.topology.json");
  fs.writeFileSync(filePath, "{}", "utf8");

  assert.throws(
    () => loadTeamDslDefinitionFile(filePath),
    /\.yaml 或 \.yml/,
  );
});
