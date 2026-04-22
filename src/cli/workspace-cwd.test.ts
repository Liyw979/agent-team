import assert from "node:assert/strict";
import test from "node:test";

import { resolveValidatedWorkspaceCwd } from "./workspace-cwd";

test("不存在的 cwd 必须直接报错", () => {
  assert.throws(
    () => resolveValidatedWorkspaceCwd({
      requestedCwd: "/tmp/missing-workspace",
      currentCwd: "/Users/liyw/code/agent-team",
      exists: false,
      isDirectory: false,
    }),
    /工作目录不存在：\/tmp\/missing-workspace/,
  );
});

test("cwd 存在但不是目录时也必须报错", () => {
  assert.throws(
    () => resolveValidatedWorkspaceCwd({
      requestedCwd: "/tmp/not-a-directory",
      currentCwd: "/Users/liyw/code/agent-team",
      exists: true,
      isDirectory: false,
    }),
    /工作目录必须是目录：\/tmp\/not-a-directory/,
  );
});

test("合法 cwd 会返回解析后的绝对路径", () => {
  assert.equal(
    resolveValidatedWorkspaceCwd({
      requestedCwd: "./cli",
      currentCwd: "/Users/liyw/code/agent-team",
      exists: true,
      isDirectory: true,
    }),
    "/Users/liyw/code/agent-team/cli",
  );
});
