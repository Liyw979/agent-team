import test from "node:test";
import assert from "node:assert/strict";

import type { TopologyRecord } from "@shared/types";

import {
  getDownstreamMode,
  setDownstreamMode,
  setSpawnEnabledForDownstream,
} from "./topology-spawn-toggle";

test("在下游配置中把某个下游勾选为 spawn 后，会自动把该下游及其后续可达 Agent 组成同一个动态团队", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "漏洞论证", "漏洞挑战", "Summary"],
    nodeRecords: [
      { id: "Build", kind: "agent", templateName: "Build" },
      { id: "漏洞论证", kind: "agent", templateName: "漏洞论证" },
      { id: "漏洞挑战", kind: "agent", templateName: "漏洞挑战" },
      { id: "Summary", kind: "agent", templateName: "Summary" },
    ],
    edges: [
      { source: "Build", target: "漏洞论证", triggerOn: "transfer", messageMode: "last" },
      { source: "漏洞论证", target: "漏洞挑战", triggerOn: "continue", messageMode: "last" },
      { source: "漏洞挑战", target: "Summary", triggerOn: "complete", messageMode: "last" },
    ],
    spawnRules: [],
  };

  const next = setSpawnEnabledForDownstream({
    topology,
    sourceNodeId: "Build",
    targetNodeId: "漏洞论证",
    enabled: true,
  });

  const spawnNode = next.nodeRecords?.find((node) => node.id === "漏洞论证");
  assert.equal(spawnNode?.kind, "spawn");
  assert.equal(spawnNode?.spawnEnabled, true);
  assert.equal(spawnNode?.spawnRuleId, "spawn-rule:漏洞论证");

  const spawnRule = next.spawnRules?.find((rule) => rule.id === "spawn-rule:漏洞论证");
  assert.notEqual(spawnRule, undefined);
  assert.equal(spawnRule?.sourceTemplateName, "Build");
  assert.deepEqual(
    spawnRule?.spawnedAgents.map((agent) => agent.templateName),
    ["漏洞论证", "漏洞挑战", "Summary"],
  );
});

test("启用 spawn 时，会清掉同一下游上的其它触发类型，保证四种模式完全互斥", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "漏洞论证", "漏洞挑战", "Summary"],
    nodeRecords: [
      { id: "Build", kind: "agent", templateName: "Build" },
      { id: "漏洞论证", kind: "agent", templateName: "漏洞论证" },
      { id: "漏洞挑战", kind: "agent", templateName: "漏洞挑战" },
      { id: "Summary", kind: "agent", templateName: "Summary" },
    ],
    edges: [
      { source: "Build", target: "漏洞论证", triggerOn: "transfer", messageMode: "last" },
      { source: "Build", target: "漏洞论证", triggerOn: "complete", messageMode: "last" },
      { source: "Build", target: "漏洞论证", triggerOn: "continue", messageMode: "last" },
      { source: "漏洞论证", target: "漏洞挑战", triggerOn: "continue", messageMode: "last" },
      { source: "漏洞挑战", target: "Summary", triggerOn: "complete", messageMode: "last" },
    ],
    spawnRules: [],
  };

  const next = setSpawnEnabledForDownstream({
    topology,
    sourceNodeId: "Build",
    targetNodeId: "漏洞论证",
    enabled: true,
  });

  assert.deepEqual(
    next.edges
      .filter((edge) => edge.source === "Build" && edge.target === "漏洞论证")
      .map((edge) => edge.triggerOn)
      .sort(),
    ["transfer"],
  );
});

test("切换到传递时，会关闭 spawn、删除动态团队规则，并只保留传递一种模式", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "漏洞论证", "漏洞挑战", "Summary"],
    nodeRecords: [
      { id: "Build", kind: "agent", templateName: "Build" },
      { id: "漏洞论证", kind: "spawn", templateName: "漏洞论证", spawnEnabled: true, spawnRuleId: "spawn-rule:漏洞论证" },
      { id: "漏洞挑战", kind: "agent", templateName: "漏洞挑战" },
      { id: "Summary", kind: "agent", templateName: "Summary" },
    ],
    edges: [
      { source: "Build", target: "漏洞论证", triggerOn: "continue", messageMode: "last" },
      { source: "漏洞论证", target: "漏洞挑战", triggerOn: "continue", messageMode: "last" },
      { source: "漏洞挑战", target: "Summary", triggerOn: "complete", messageMode: "last" },
    ],
    spawnRules: [
      {
        id: "spawn-rule:漏洞论证",
        spawnNodeName: "漏洞论证",
        sourceTemplateName: "Build",
        entryRole: "entry",
        spawnedAgents: [
          { role: "entry", templateName: "漏洞论证" },
          { role: "漏洞挑战", templateName: "漏洞挑战" },
          { role: "Summary", templateName: "Summary" },
        ],
        edges: [
          { sourceRole: "entry", targetRole: "漏洞挑战", triggerOn: "transfer", messageMode: "last" },
          { sourceRole: "漏洞挑战", targetRole: "Summary", triggerOn: "transfer", messageMode: "last" },
        ],
        exitWhen: "one_side_agrees",
        reportToTemplateName: "Summary",
      },
    ],
  };

  const next = setDownstreamMode({
    topology,
    sourceNodeId: "Build",
    targetNodeId: "漏洞论证",
    mode: "transfer",
  });

  const targetNode = next.nodeRecords?.find((node) => node.id === "漏洞论证");
  assert.equal(targetNode?.kind, "agent");
  assert.equal(targetNode?.spawnEnabled, false);
  assert.equal(targetNode?.spawnRuleId, undefined);
  assert.equal(next.spawnRules?.length ?? 0, 0);
  assert.deepEqual(
    next.edges
      .filter((edge) => edge.source === "Build" && edge.target === "漏洞论证")
      .map((edge) => edge.triggerOn)
      .sort(),
    ["transfer"],
  );
});

test("切换到继续处理时，会关闭 spawn 并保留一条可调度的 action_required 入口边", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "漏洞论证", "漏洞挑战"],
    nodeRecords: [
      { id: "Build", kind: "agent", templateName: "Build" },
      { id: "漏洞论证", kind: "spawn", templateName: "漏洞论证", spawnEnabled: true, spawnRuleId: "spawn-rule:漏洞论证" },
      { id: "漏洞挑战", kind: "agent", templateName: "漏洞挑战" },
    ],
    edges: [],
    spawnRules: [
      {
        id: "spawn-rule:漏洞论证",
        spawnNodeName: "漏洞论证",
        sourceTemplateName: "Build",
        entryRole: "entry",
        spawnedAgents: [{ role: "entry", templateName: "漏洞论证" }],
        edges: [],
        exitWhen: "one_side_agrees",
        reportToTemplateName: "Build",
      },
    ],
  };

  const next = setDownstreamMode({
    topology,
    sourceNodeId: "Build",
    targetNodeId: "漏洞论证",
    mode: "continue",
  });

  assert.equal(next.nodeRecords?.find((node) => node.id === "漏洞论证")?.kind, "agent");
  assert.equal(next.spawnRules?.length ?? 0, 0);
  assert.deepEqual(
    next.edges
      .filter((edge) => edge.source === "Build" && edge.target === "漏洞论证")
      .map((edge) => edge.triggerOn),
    ["continue"],
  );
});

test("当前下游模式会在 spawn、传递、已完成判定、继续处理 四种触发里返回唯一结果", () => {
  const spawnTopology: TopologyRecord = {
    nodes: ["Build", "漏洞论证"],
    nodeRecords: [
      { id: "Build", kind: "agent", templateName: "Build" },
      { id: "漏洞论证", kind: "spawn", templateName: "漏洞论证", spawnEnabled: true, spawnRuleId: "spawn-rule:漏洞论证" },
    ],
    edges: [],
    spawnRules: [],
  };
  assert.equal(
    getDownstreamMode({
      topology: spawnTopology,
      sourceNodeId: "Build",
      targetNodeId: "漏洞论证",
    }),
    "spawn",
  );

  const handoffTopology: TopologyRecord = {
    nodes: ["Build", "漏洞论证"],
    nodeRecords: [
      { id: "Build", kind: "agent", templateName: "Build" },
      { id: "漏洞论证", kind: "agent", templateName: "漏洞论证" },
    ],
    edges: [{ source: "Build", target: "漏洞论证", triggerOn: "transfer", messageMode: "last" }],
    spawnRules: [],
  };
  assert.equal(
    getDownstreamMode({
      topology: handoffTopology,
      sourceNodeId: "Build",
      targetNodeId: "漏洞论证",
    }),
    "transfer",
  );

  const passTopology: TopologyRecord = {
    nodes: ["Build", "漏洞论证"],
    nodeRecords: [
      { id: "Build", kind: "agent", templateName: "Build" },
      { id: "漏洞论证", kind: "agent", templateName: "漏洞论证" },
    ],
    edges: [{ source: "Build", target: "漏洞论证", triggerOn: "complete", messageMode: "last" }],
    spawnRules: [],
  };
  assert.equal(
    getDownstreamMode({
      topology: passTopology,
      sourceNodeId: "Build",
      targetNodeId: "漏洞论证",
    }),
    "complete",
  );

  const failTopology: TopologyRecord = {
    nodes: ["Build", "漏洞论证"],
    nodeRecords: [
      { id: "Build", kind: "agent", templateName: "Build" },
      { id: "漏洞论证", kind: "agent", templateName: "漏洞论证" },
    ],
    edges: [{ source: "Build", target: "漏洞论证", triggerOn: "continue", messageMode: "last" }],
    spawnRules: [],
  };
  assert.equal(
    getDownstreamMode({
      topology: failTopology,
      sourceNodeId: "Build",
      targetNodeId: "漏洞论证",
    }),
    "continue",
  );
});
