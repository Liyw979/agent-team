import test from "node:test";
import assert from "node:assert/strict";

import type { TaskAgentRecord, TopologyRecord } from "@shared/types";

import { compileBuiltinVulnerabilityTopology } from "./builtin-topology-test-helpers";
import { resolveTaskAgentIdsToPrewarm } from "./task-session-prewarm";

test("resolveTaskAgentIdsToPrewarm 不会为仅作为 spawn 模板存在的静态 agent 预建 session", () => {
  const topology: TopologyRecord = compileBuiltinVulnerabilityTopology().topology;
  const taskAgents: TaskAgentRecord[] = [
    {
      taskId: "task-1",
      id: "线索发现",
      opencodeSessionId: null,
      opencodeAttachBaseUrl: null,
      status: "idle",
      runCount: 0,
    },
    {
      taskId: "task-1",
      id: "漏洞论证",
      opencodeSessionId: null,
      opencodeAttachBaseUrl: null,
      status: "idle",
      runCount: 0,
    },
    {
      taskId: "task-1",
      id: "漏洞挑战",
      opencodeSessionId: null,
      opencodeAttachBaseUrl: null,
      status: "idle",
      runCount: 0,
    },
    {
      taskId: "task-1",
      id: "讨论总结",
      opencodeSessionId: null,
      opencodeAttachBaseUrl: null,
      status: "idle",
      runCount: 0,
    },
  ];

  assert.deepEqual(resolveTaskAgentIdsToPrewarm(topology, taskAgents), ["线索发现"]);
});
