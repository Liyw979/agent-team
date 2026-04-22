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
    projectId: "project-spawn-toggle",
    nodes: ["Build", "正方", "反方", "Summary"],
    nodeRecords: [
      { id: "Build", kind: "agent", templateName: "Build" },
      { id: "正方", kind: "agent", templateName: "正方" },
      { id: "反方", kind: "agent", templateName: "反方" },
      { id: "Summary", kind: "agent", templateName: "Summary" },
    ],
    edges: [
      { source: "Build", target: "正方", triggerOn: "association" },
      { source: "正方", target: "反方", triggerOn: "review_fail" },
      { source: "反方", target: "Summary", triggerOn: "review_pass" },
    ],
    spawnRules: [],
  };

  const next = setSpawnEnabledForDownstream({
    topology,
    sourceNodeId: "Build",
    targetNodeId: "正方",
    enabled: true,
  });

  const spawnNode = next.nodeRecords?.find((node) => node.id === "正方");
  assert.equal(spawnNode?.kind, "spawn");
  assert.equal(spawnNode?.spawnEnabled, true);
  assert.equal(spawnNode?.spawnRuleId, "spawn-rule:正方");

  const spawnRule = next.spawnRules?.find((rule) => rule.id === "spawn-rule:正方");
  assert.notEqual(spawnRule, undefined);
  assert.equal(spawnRule?.sourceTemplateName, "Build");
  assert.deepEqual(
    spawnRule?.spawnedAgents.map((agent) => agent.templateName),
    ["正方", "反方", "Summary"],
  );
});

test("启用 spawn 时，会清掉同一下游上的其它触发类型，保证四种模式完全互斥", () => {
  const topology: TopologyRecord = {
    projectId: "project-spawn-toggle-exclusive",
    nodes: ["Build", "正方", "反方", "Summary"],
    nodeRecords: [
      { id: "Build", kind: "agent", templateName: "Build" },
      { id: "正方", kind: "agent", templateName: "正方" },
      { id: "反方", kind: "agent", templateName: "反方" },
      { id: "Summary", kind: "agent", templateName: "Summary" },
    ],
    edges: [
      { source: "Build", target: "正方", triggerOn: "association" },
      { source: "Build", target: "正方", triggerOn: "review_pass" },
      { source: "Build", target: "正方", triggerOn: "review_fail" },
      { source: "正方", target: "反方", triggerOn: "review_fail" },
      { source: "反方", target: "Summary", triggerOn: "review_pass" },
    ],
    spawnRules: [],
  };

  const next = setSpawnEnabledForDownstream({
    topology,
    sourceNodeId: "Build",
    targetNodeId: "正方",
    enabled: true,
  });

  assert.deepEqual(
    next.edges
      .filter((edge) => edge.source === "Build" && edge.target === "正方")
      .map((edge) => edge.triggerOn)
      .sort(),
    ["association"],
  );
});

test("切换到传递时，会关闭 spawn、删除动态团队规则，并只保留传递一种模式", () => {
  const topology: TopologyRecord = {
    projectId: "project-spawn-toggle-association",
    nodes: ["Build", "正方", "反方", "Summary"],
    nodeRecords: [
      { id: "Build", kind: "agent", templateName: "Build" },
      { id: "正方", kind: "spawn", templateName: "正方", spawnEnabled: true, spawnRuleId: "spawn-rule:正方" },
      { id: "反方", kind: "agent", templateName: "反方" },
      { id: "Summary", kind: "agent", templateName: "Summary" },
    ],
    edges: [
      { source: "Build", target: "正方", triggerOn: "review_fail" },
      { source: "正方", target: "反方", triggerOn: "review_fail" },
      { source: "反方", target: "Summary", triggerOn: "review_pass" },
    ],
    spawnRules: [
      {
        id: "spawn-rule:正方",
        name: "正方",
        sourceTemplateName: "Build",
        entryRole: "entry",
        spawnedAgents: [
          { role: "entry", templateName: "正方" },
          { role: "反方", templateName: "反方" },
          { role: "Summary", templateName: "Summary" },
        ],
        edges: [
          { sourceRole: "entry", targetRole: "反方", triggerOn: "association" },
          { sourceRole: "反方", targetRole: "Summary", triggerOn: "association" },
        ],
        exitWhen: "one_side_agrees",
        reportToTemplateName: "Summary",
      },
    ],
  };

  const next = setDownstreamMode({
    topology,
    sourceNodeId: "Build",
    targetNodeId: "正方",
    mode: "association",
  });

  const targetNode = next.nodeRecords?.find((node) => node.id === "正方");
  assert.equal(targetNode?.kind, "agent");
  assert.equal(targetNode?.spawnEnabled, false);
  assert.equal(targetNode?.spawnRuleId, undefined);
  assert.equal(next.spawnRules?.length ?? 0, 0);
  assert.deepEqual(
    next.edges
      .filter((edge) => edge.source === "Build" && edge.target === "正方")
      .map((edge) => edge.triggerOn)
      .sort(),
    ["association"],
  );
});

test("切换到审视不通过时，会关闭 spawn 并保留一条可调度的 review_fail 入口边", () => {
  const topology: TopologyRecord = {
    projectId: "project-spawn-toggle-review-fail",
    nodes: ["Build", "正方", "反方"],
    nodeRecords: [
      { id: "Build", kind: "agent", templateName: "Build" },
      { id: "正方", kind: "spawn", templateName: "正方", spawnEnabled: true, spawnRuleId: "spawn-rule:正方" },
      { id: "反方", kind: "agent", templateName: "反方" },
    ],
    edges: [],
    spawnRules: [
      {
        id: "spawn-rule:正方",
        name: "正方",
        sourceTemplateName: "Build",
        entryRole: "entry",
        spawnedAgents: [{ role: "entry", templateName: "正方" }],
        edges: [],
        exitWhen: "one_side_agrees",
        reportToTemplateName: "Build",
      },
    ],
  };

  const next = setDownstreamMode({
    topology,
    sourceNodeId: "Build",
    targetNodeId: "正方",
    mode: "review_fail",
  });

  assert.equal(next.nodeRecords?.find((node) => node.id === "正方")?.kind, "agent");
  assert.equal(next.spawnRules?.length ?? 0, 0);
  assert.deepEqual(
    next.edges
      .filter((edge) => edge.source === "Build" && edge.target === "正方")
      .map((edge) => edge.triggerOn),
    ["review_fail"],
  );
});

test("当前下游模式会在 spawn、传递、审视通过、审视不通过 四种触发里返回唯一结果", () => {
  const spawnTopology: TopologyRecord = {
    projectId: "project-spawn-mode",
    nodes: ["Build", "正方"],
    nodeRecords: [
      { id: "Build", kind: "agent", templateName: "Build" },
      { id: "正方", kind: "spawn", templateName: "正方", spawnEnabled: true, spawnRuleId: "spawn-rule:正方" },
    ],
    edges: [],
    spawnRules: [],
  };
  assert.equal(
    getDownstreamMode({
      topology: spawnTopology,
      sourceNodeId: "Build",
      targetNodeId: "正方",
    }),
    "spawn",
  );

  const associationTopology: TopologyRecord = {
    projectId: "project-association-mode",
    nodes: ["Build", "正方"],
    nodeRecords: [
      { id: "Build", kind: "agent", templateName: "Build" },
      { id: "正方", kind: "agent", templateName: "正方" },
    ],
    edges: [{ source: "Build", target: "正方", triggerOn: "association" }],
    spawnRules: [],
  };
  assert.equal(
    getDownstreamMode({
      topology: associationTopology,
      sourceNodeId: "Build",
      targetNodeId: "正方",
    }),
    "association",
  );

  const passTopology: TopologyRecord = {
    projectId: "project-pass-mode",
    nodes: ["Build", "正方"],
    nodeRecords: [
      { id: "Build", kind: "agent", templateName: "Build" },
      { id: "正方", kind: "agent", templateName: "正方" },
    ],
    edges: [{ source: "Build", target: "正方", triggerOn: "review_pass" }],
    spawnRules: [],
  };
  assert.equal(
    getDownstreamMode({
      topology: passTopology,
      sourceNodeId: "Build",
      targetNodeId: "正方",
    }),
    "review_pass",
  );

  const failTopology: TopologyRecord = {
    projectId: "project-fail-mode",
    nodes: ["Build", "正方"],
    nodeRecords: [
      { id: "Build", kind: "agent", templateName: "Build" },
      { id: "正方", kind: "agent", templateName: "正方" },
    ],
    edges: [{ source: "Build", target: "正方", triggerOn: "review_fail" }],
    spawnRules: [],
  };
  assert.equal(
    getDownstreamMode({
      topology: failTopology,
      sourceNodeId: "Build",
      targetNodeId: "正方",
    }),
    "review_fail",
  );
});
