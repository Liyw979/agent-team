import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildCliLauncherSpec } = require("./launcher-spec.cjs") as {
  buildCliLauncherSpec: (input: {
    nodeBinary: string;
    repoRoot: string;
    argv: string[];
    env: Record<string, string | undefined>;
  }) => {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string | undefined>;
  };
};

test("buildCliLauncherSpec 直接使用当前 Node 进程启动 CLI 入口", () => {
  const spec = buildCliLauncherSpec({
    nodeBinary: "/opt/homebrew/bin/node",
    repoRoot: "/repo/agent-team",
    argv: ["task", "run", "--message", "hello"],
    env: {
      PATH: "/usr/bin",
    },
  });

  assert.equal(spec.command, "/opt/homebrew/bin/node");
  assert.deepEqual(spec.args, [
    "--require",
    "/repo/agent-team/node_modules/tsx/dist/preflight.cjs",
    "--import",
    "file:///repo/agent-team/node_modules/tsx/dist/loader.mjs",
    "/repo/agent-team/cli/index.ts",
    "task",
    "run",
    "--message",
    "hello",
  ]);
  assert.equal(spec.cwd, "/repo/agent-team");
  assert.equal(spec.env.PATH, "/usr/bin");
});
