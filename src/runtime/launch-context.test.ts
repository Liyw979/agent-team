import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveLaunchContext } from "./launch-context";

test("resolveLaunchContext 鍦ㄥ惎鍔ㄥ叆鍙ｆ病鏈夐€忎紶鑷畾涔?CLI 鍙傛暟鏃讹紝浼氬洖閫€璇诲彇鐜鍙橀噺", () => {
  const launch = resolveLaunchContext({
    argv: ["node", "src/cli/index.ts"],
    env: {
      AGENT_TEAM_TASK_ID: "task-123",
      AGENT_TEAM_CWD: "/Users/demo/code/empty",
    },
    defaultCwd: "/repo/agent-team",
  });

  assert.deepEqual(launch, {
    launchTaskId: "task-123",
    launchCwd: path.resolve("/Users/demo/code/empty"),
  });
});

test("resolveLaunchContext 鍙瘑鍒柊鐨?agent-team 鍚姩鍙傛暟", () => {
  const launch = resolveLaunchContext({
    argv: ["node", "src/cli/index.ts", "--agent-team-task-id", "task-456", "--agent-team-cwd", "/tmp/agent-team"],
    env: {},
    defaultCwd: "/repo/agent-team",
  });

  assert.deepEqual(launch, {
    launchTaskId: "task-456",
    launchCwd: path.resolve("/tmp/agent-team"),
  });
});
