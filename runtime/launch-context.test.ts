import assert from "node:assert/strict";
import test from "node:test";

import { resolveLaunchContext } from "./launch-context";

test("resolveLaunchContext 在启动入口没有透传自定义 CLI 参数时，会回退读取环境变量", () => {
  const launch = resolveLaunchContext({
    argv: ["node", "cli/index.ts"],
    env: {
      AGENTFLOW_TASK_ID: "task-123",
      AGENTFLOW_CWD: "/Users/demo/code/empty",
    },
    defaultCwd: "/repo/agent-team",
  });

  assert.deepEqual(launch, {
    launchTaskId: "task-123",
    launchCwd: "/Users/demo/code/empty",
  });
});
