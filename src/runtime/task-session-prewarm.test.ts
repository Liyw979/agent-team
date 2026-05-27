import { test } from "bun:test";
import assert from "node:assert/strict";

import type { TaskAgentRecord, TopologyRecord } from "@shared/types";

import { compileBuiltinTopology } from "../../test-support/runtime/builtin-topology-test-helpers";
import { resolveTaskAgentIdsToPrewarm } from "./task-session-prewarm";

test("resolveTaskAgentIdsToPrewarm 不会为仅作为 group 模板存在的静态 agent 预建 session", () => {
  const topology: TopologyRecord = compileBuiltinTopology("vulnerability.yaml").topology;
  const taskAgents: TaskAgentRecord[] = [
    {
      id: "线索发现",
      opencodeSessionId: "",
      opencodeAttachBaseUrl: "",
      status: "idle",
      runCount: 0,
    },
    {
      id: "漏洞论证",
      opencodeSessionId: "",
      opencodeAttachBaseUrl: "",
      status: "idle",
      runCount: 0,
    },
    {
      id: "误报论证",
      opencodeSessionId: "",
      opencodeAttachBaseUrl: "",
      status: "idle",
      runCount: 0,
    },
    {
      id: "讨论总结",
      opencodeSessionId: "",
      opencodeAttachBaseUrl: "",
      status: "idle",
      runCount: 0,
    },
  ];

  assert.deepEqual(resolveTaskAgentIdsToPrewarm(topology, taskAgents), ["线索发现"]);
});
