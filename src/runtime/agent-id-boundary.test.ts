import { strict as assert } from "assert";
import { test } from "bun:test";

import { buildTopologyNodeRecords, createTopologyFlowRecord } from "@shared/types";

import { createEmptyGraphTaskState } from "./gating-state";
import { createUserDispatchDecision } from "./gating-router";

test("用户派发决策使用 agentId 字段表达来源和目标", () => {
  const state = createEmptyGraphTaskState({
    topology: {
      nodes: ["Build"],
      edges: [],
      flow: createTopologyFlowRecord({
        nodes: ["Build"],
        edges: [],
      }),
      nodeRecords: buildTopologyNodeRecords({
        nodes: ["Build"],
        groupNodeIds: new Set(),
        templateNameByNodeId: new Map(),
        initialMessageRoutingByNodeId: new Map(),
        groupRuleIdByNodeId: new Map(),
        groupEnabledNodeIds: new Set(),
        promptByNodeId: new Map(),
        writableNodeIds: new Set(),
      }),
    },
  });

  const decision = createUserDispatchDecision(state, {
    targetAgentId: "Build",
    content: "实现加法",
  });

  assert.equal(decision.type, "execute_batch");
  assert.deepEqual(decision.batch, {
    routingKind: "default",
    source: { kind: "user" },
    sourceContent: "实现加法",
    displayContent: "实现加法",
    triggerTargets: ["Build"],
    jobs: [
      {
        agentId: "Build",
        sourceContent: "实现加法",
        displayContent: "实现加法",
        kind: "raw",
      },
    ],
  });
});

test("用户直接命中 group 时不会把 group 节点伪造成来源 agent", () => {
  const state = createEmptyGraphTaskState({
    topology: {
      nodes: ["讨论", "执行"],
      edges: [],
      flow: createTopologyFlowRecord({
        nodes: ["讨论", "执行"],
        edges: [],
      }),
      nodeRecords: [
        {
          id: "讨论",
          kind: "group",
          templateName: "讨论",
          groupRuleId: "group-rule:讨论",
          initialMessageRouting: { mode: "inherit" },
        },
        {
          id: "执行",
          kind: "agent",
          templateName: "执行",
          initialMessageRouting: { mode: "inherit" },
        },
      ],
      groupRules: [
        {
          id: "group-rule:讨论",
          groupNodeName: "讨论",
          entryRole: "entry",
        members: [{ role: "entry", templateName: "执行" }],
        edges: [],
        report: false,
      },
    ],
    },
  });

  const decision = createUserDispatchDecision(state, {
    targetAgentId: "讨论",
    content: "请开始",
  });

  assert.equal(decision.type, "execute_batch");
  assert.deepEqual(decision.batch.source, { kind: "user" });
  assert.deepEqual(decision.batch.jobs, [
    {
      agentId: "执行-1",
      sourceContent: "请开始",
      displayContent: "请开始",
      kind: "raw",
    },
  ]);
});
