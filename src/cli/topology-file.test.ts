import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isSupportedTopologyFile, loadTeamDslDefinitionFile } from "./topology-file";

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-topology-file-"));
}

test("loadTeamDslDefinitionFile 读取 .json5 文件时支持 JSON5 语法", () => {
  const tempDir = createTempDir();
  const filePath = path.join(tempDir, "team.topology.json5");
  fs.writeFileSync(filePath, `{
    // comment
    entry: "BA",
    nodes: [
      {
        type: "agent",
        id: "BA",
        prompt: "你是 BA。",
        writable: false,
      },
    ],
    links: [],
  }`, "utf8");

  const parsed = loadTeamDslDefinitionFile<{
    entry?: string;
    nodes?: Array<{ id?: string }>;
  }>(filePath);

  assert.equal(parsed.entry, "BA");
  assert.equal(parsed.nodes?.[0]?.id, "BA");
});

test("isSupportedTopologyFile 只接受 .json5", () => {
  assert.equal(isSupportedTopologyFile("/tmp/a.json"), false);
  assert.equal(isSupportedTopologyFile("/tmp/a.json5"), true);
  assert.equal(isSupportedTopologyFile("/tmp/a.yaml"), false);
});

test("loadTeamDslDefinitionFile 会拒绝 .json 拓扑文件", () => {
  const tempDir = createTempDir();
  const filePath = path.join(tempDir, "team.topology.json");
  fs.writeFileSync(filePath, "{}", "utf8");

  assert.throws(
    () => loadTeamDslDefinitionFile(filePath),
    /\.json5/,
  );
});
