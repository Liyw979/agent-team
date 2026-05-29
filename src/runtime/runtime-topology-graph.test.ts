import assert from "node:assert/strict";
import { test } from "bun:test";

import { createTopologyFlowRecord, type TopologyRecord } from "@shared/types";

import { createEmptyGraphTaskState } from "./gating-state";
import {
  buildEffectiveTopology,
  getGroupRuleIdForNode,
  getRuntimeTemplateName,
  resolveSourceTemplateName,
} from "./runtime-topology-graph";

test("buildEffectiveTopology 不会因为 nodeRecords 只保存局部节点而丢掉 topology.nodes 里的静态节点", () => {
  const topology: TopologyRecord = {
    nodes: ["BA", "Build", "QA"],
    edges: [
      { source: "BA", target: "Build", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "Build", target: "QA", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
    ],
    flow: createTopologyFlowRecord({
      nodes: ["BA", "Build", "QA"],
      edges: [
        { source: "BA", target: "Build", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "Build", target: "QA", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
      ],
    }),
    nodeRecords: [
      { id: "BA", kind: "agent", templateName: "BA", initialMessageRouting: { mode: "inherit" }, prompt: "", writable: false },
    ],
  };
  const state = createEmptyGraphTaskState({
    topology,
  });

  const effective = buildEffectiveTopology(state);

  assert.deepEqual(effective.nodes, ["BA", "Build", "QA"]);
});

test("getGroupRuleIdForNode 会返回 group 节点的确定 ruleId", () => {
  const topology: TopologyRecord = {
    nodes: ["group:review"],
    edges: [],
    flow: createTopologyFlowRecord({
      nodes: ["group:review"],
      edges: [],
    }),
    nodeRecords: [
      { id: "group:review", kind: "group", templateName: "group:review", initialMessageRouting: { mode: "inherit" }, groupRuleId: "rule:review" },
    ],
    groupRules: [],
  };
  const state = createEmptyGraphTaskState({
    topology,
  });

  assert.equal(getGroupRuleIdForNode(state, "group:review"), "rule:review");
});

test("getRuntimeTemplateName 在缺少 runtime 节点时直接抛错", () => {
  const topology: TopologyRecord = {
    nodes: ["Build"],
    edges: [],
    flow: createTopologyFlowRecord({
      nodes: ["Build"],
      edges: [],
    }),
    nodeRecords: [
      { id: "Build", kind: "agent", templateName: "Build", initialMessageRouting: { mode: "inherit" }, prompt: "", writable: false },
    ],
    groupRules: [],
  };
  const state = createEmptyGraphTaskState({
    topology,
  });

  assert.throws(() => getRuntimeTemplateName(state, "Build-runtime"), {
    message: "运行态节点不存在：Build-runtime",
  });
});

test("resolveSourceTemplateName 会从静态拓扑节点记录解析模板名", () => {
  const topology: TopologyRecord = {
    nodes: ["线索发现"],
    edges: [],
    flow: createTopologyFlowRecord({
      nodes: ["线索发现"],
      edges: [],
    }),
    nodeRecords: [
      { id: "线索发现", kind: "agent", templateName: "线索发现", initialMessageRouting: { mode: "inherit" }, prompt: "", writable: false },
    ],
    groupRules: [],
  };
  const state = createEmptyGraphTaskState({
    topology,
  });

  assert.equal(resolveSourceTemplateName(state, "线索发现"), "线索发现");
});
