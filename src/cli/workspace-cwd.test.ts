import assert from "node:assert/strict";
import { test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceCwdFromFilesystem } from "./workspace-cwd";

test("不存在的 cwd 必须直接报错", () => {
  const missingWorkspacePath = path.resolve("/tmp/missing-workspace");
  assert.throws(
    () => resolveWorkspaceCwdFromFilesystem("/tmp/missing-workspace", "/Users/liyw/code/agent-team"),
    new RegExp(`工作目录不存在：${missingWorkspacePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u"),
  );
});

test("cwd 存在但不是目录时也必须报错", () => {
  const filePath = path.join(os.tmpdir(), `agent-team-workspace-cwd-${Date.now()}.txt`);
  fs.writeFileSync(filePath, "test");
  assert.throws(
    () => resolveWorkspaceCwdFromFilesystem(filePath, "/Users/liyw/code/agent-team"),
    new RegExp(`工作目录必须是目录：${filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u"),
  );
  fs.unlinkSync(filePath);
});

test("合法 cwd 会返回解析后的绝对路径", () => {
  const currentCwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-workspace-cwd-valid-"));
  const childDir = path.join(currentCwd, "cli");
  fs.mkdirSync(childDir);
  assert.equal(
    resolveWorkspaceCwdFromFilesystem("./cli", currentCwd),
    childDir,
  );
  fs.rmSync(currentCwd, { recursive: true, force: true });
});
