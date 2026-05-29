import assert from "node:assert/strict";
import path from "node:path";
import { test } from "bun:test";

import { resolveLaunchContext } from "./launch-context";

test("resolveLaunchContext 在没有显式 CLI 启动目录时回退到默认目录", () => {
  // 2026-05-27: 用户要求仅保留显式 CLI 启动目录与默认目录，不保留环境变量兼容入口。
  const launch = resolveLaunchContext({
    argv: ["node", "src/cli/index.ts"],
    defaultCwd: "/repo/agent-team",
  });

  assert.equal(launch, path.resolve("/repo/agent-team"));
});

test("resolveLaunchContext 只识别 agent-team 显式 CLI 启动参数", () => {
  const launch = resolveLaunchContext({
    argv: ["node", "src/cli/index.ts", "--agent-team-cwd", "/tmp/agent-team"],
    defaultCwd: "/repo/agent-team",
  });

  assert.equal(launch, path.resolve("/tmp/agent-team"));
});
