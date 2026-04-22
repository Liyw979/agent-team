import test from "node:test";
import assert from "node:assert/strict";

import { IPC_CHANNELS } from "./ipc";

test("IPC_CHANNELS 统一改用 agent-team 前缀", () => {
  assert.deepEqual(IPC_CHANNELS, {
    getUiSnapshot: "agent-team/get-ui-snapshot",
    submitTask: "agent-team/submit-task",
    openAgentTerminal: "agent-team/open-agent-terminal",
    getTaskRuntime: "agent-team/get-task-runtime",
    eventStream: "agent-team/event-stream",
  });
});
