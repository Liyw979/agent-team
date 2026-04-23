import { strict as assert } from "assert";
import test from "node:test";

import { createEmptyGraphTaskState } from "./gating-state";
import { createUserDispatchDecision } from "./gating-router";

test("用户派发决策使用 agentId 字段表达来源和目标", () => {
  const state = createEmptyGraphTaskState({
    taskId: "task-1",
    topology: {
      nodes: ["Build"],
      edges: [],
    },
  });

  const decision = createUserDispatchDecision(state, {
    targetAgentId: "Build",
    content: "实现加法",
  });

  assert.equal(decision.type, "execute_batch");
  assert.deepEqual(decision.batch, {
    sourceAgentId: null,
    sourceContent: "实现加法",
    triggerTargets: ["Build"],
    jobs: [
      {
        agentId: "Build",
        sourceAgentId: null,
        kind: "raw",
      },
    ],
  });
});
