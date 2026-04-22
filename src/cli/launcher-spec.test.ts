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
    platform?: NodeJS.Platform;
  }) => {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string | undefined>;
  };
};

test("buildCliLauncherSpec 鐩存帴浣跨敤褰撳墠 Node 杩涚▼鍚姩 CLI 鍏ュ彛", () => {
  const spec = buildCliLauncherSpec({
    nodeBinary: "/opt/homebrew/bin/node",
    repoRoot: "/repo/agent-team",
    argv: ["task", "run", "--message", "hello"],
    platform: "darwin",
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
    "/repo/agent-team/src/cli/index.ts",
    "task",
    "run",
    "--message",
    "hello",
  ]);
  assert.equal(spec.cwd, "/repo/agent-team");
  assert.equal(spec.env.PATH, "/usr/bin");
});

test("buildCliLauncherSpec 鍦?Windows 浠撳簱璺緞涓嬩篃浼氱敓鎴愬悎娉曠殑 loader file URL", () => {
  const spec = buildCliLauncherSpec({
    nodeBinary: "C:\\Program Files\\nodejs\\node.exe",
    repoRoot: "C:\\repo\\agent-team",
    argv: ["task", "attach", "Build"],
    platform: "win32",
    env: {
      PATH: "C:\\Windows\\System32",
    },
  });

  assert.equal(
    spec.args[3],
    "file:///C:/repo/agent-team/node_modules/tsx/dist/loader.mjs",
  );
});
