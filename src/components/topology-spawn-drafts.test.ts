import test from "node:test";
import assert from "node:assert/strict";

import type { TopologyRecord } from "@shared/types";

import {
  getTopologyDisplayNodeIds,
  upsertDebateSpawnDraft,
} from "./topology-spawn-drafts";

test("getTopologyDisplayNodeIds 在没有运行过任何 agent 时不展示静态节点", () => {
  const topology: TopologyRecord = {
    nodes: ["线索发现", "漏洞论证模板", "漏洞挑战模板", "Summary模板"],
    nodeRecords: [
      { id: "线索发现", kind: "agent", templateName: "线索发现" },
      {
        id: "疑点辩论工厂",
        kind: "spawn",
        templateName: "漏洞论证模板",
        spawnRuleId: "spawn-rule:漏洞团队",
      },
    ],
    edges: [],
    spawnRules: [],
  };

  assert.deepEqual(getTopologyDisplayNodeIds(topology, []), []);
});

test("getTopologyDisplayNodeIds 只展示已经运行过的静态节点与 runtime 实例", () => {
  const topology: TopologyRecord = {
    nodes: ["线索发现", "疑点辩论", "漏洞论证-1", "漏洞挑战-1"],
    nodeRecords: [
      { id: "线索发现", kind: "agent", templateName: "线索发现" },
      {
        id: "疑点辩论",
        kind: "spawn",
        templateName: "疑点辩论",
        spawnRuleId: "spawn-rule:疑点辩论",
      },
      {
        id: "漏洞论证-1",
        kind: "agent",
        templateName: "漏洞论证",
      },
      {
        id: "漏洞挑战-1",
        kind: "agent",
        templateName: "漏洞挑战",
      },
    ],
    edges: [],
    spawnRules: [],
  };

  assert.deepEqual(
    getTopologyDisplayNodeIds(topology, [
      "线索发现",
      "漏洞论证-1",
      "漏洞挑战-1",
    ]),
    ["线索发现", "漏洞论证-1", "漏洞挑战-1"],
  );
});

test("getTopologyDisplayNodeIds 会用 runtime 实例替换已展开的静态模板节点", () => {
  const topology: TopologyRecord = {
    nodes: ["线索发现", "漏洞论证", "漏洞挑战", "讨论总结", "疑点辩论"],
    nodeRecords: [
      { id: "线索发现", kind: "agent", templateName: "线索发现" },
      { id: "漏洞论证", kind: "agent", templateName: "漏洞论证" },
      { id: "漏洞挑战", kind: "agent", templateName: "漏洞挑战" },
      { id: "讨论总结", kind: "agent", templateName: "讨论总结" },
      {
        id: "疑点辩论",
        kind: "spawn",
        templateName: "疑点辩论",
        spawnRuleId: "spawn-rule:疑点辩论",
      },
    ],
    edges: [],
    spawnRules: [
      {
        id: "疑点辩论",
        spawnNodeName: "疑点辩论",
        sourceTemplateName: "线索发现",
        entryRole: "漏洞论证",
        spawnedAgents: [
          { role: "漏洞论证", templateName: "漏洞论证" },
          { role: "漏洞挑战", templateName: "漏洞挑战" },
          { role: "讨论总结", templateName: "讨论总结" },
        ],
        edges: [
          {
            sourceRole: "漏洞论证",
            targetRole: "漏洞挑战",
            trigger: "<continue>",
            messageMode: "last",
          },
          {
            sourceRole: "漏洞挑战",
            targetRole: "漏洞论证",
            trigger: "<continue>",
            messageMode: "last",
          },
          {
            sourceRole: "漏洞论证",
            targetRole: "讨论总结",
            trigger: "<complete>",
            messageMode: "last",
          },
          {
            sourceRole: "漏洞挑战",
            targetRole: "讨论总结",
            trigger: "<complete>",
            messageMode: "last",
          },
        ],
        exitWhen: "all_completed",
        reportToTemplateName: "线索发现",
        reportToTrigger: "<default>",
      },
    ],
  };

  assert.deepEqual(
    getTopologyDisplayNodeIds(topology, [
      "线索发现",
      "漏洞挑战",
      "漏洞论证",
      "漏洞论证-1",
      "讨论总结",
      "讨论总结-1",
    ]),
    ["线索发现", "漏洞论证-1", "漏洞挑战", "讨论总结-1"],
  );
});

test("getTopologyDisplayNodeIds 在同模板多次 spawn 时只保留最新实例，固定复用原列位置", () => {
  const topology: TopologyRecord = {
    nodes: ["线索发现", "漏洞挖掘", "漏洞挑战", "讨论总结", "疑点辩论"],
    nodeRecords: [
      { id: "线索发现", kind: "agent", templateName: "线索发现" },
      { id: "漏洞挖掘", kind: "agent", templateName: "漏洞挖掘" },
      { id: "漏洞挑战", kind: "agent", templateName: "漏洞挑战" },
      { id: "讨论总结", kind: "agent", templateName: "讨论总结" },
      {
        id: "疑点辩论",
        kind: "spawn",
        templateName: "疑点辩论",
        spawnRuleId: "spawn-rule:疑点辩论",
      },
    ],
    edges: [],
    spawnRules: [
      {
        id: "spawn-rule:疑点辩论",
        spawnNodeName: "疑点辩论",
        sourceTemplateName: "线索发现",
        entryRole: "漏洞挖掘",
        spawnedAgents: [
          { role: "漏洞挖掘", templateName: "漏洞挖掘" },
          { role: "漏洞挑战", templateName: "漏洞挑战" },
          { role: "讨论总结", templateName: "讨论总结" },
        ],
        edges: [],
        exitWhen: "all_completed",
        reportToTemplateName: "线索发现",
        reportToTrigger: "<default>",
      },
    ],
  };

  assert.deepEqual(
    getTopologyDisplayNodeIds(topology, [
      "线索发现",
      "漏洞挖掘",
      "漏洞挖掘-1",
      "漏洞挖掘-2",
      "漏洞挑战",
      "漏洞挑战-1",
      "漏洞挑战-2",
      "讨论总结",
      "讨论总结-1",
      "讨论总结-2",
    ]),
    ["线索发现", "漏洞挖掘-2", "漏洞挑战-2", "讨论总结-2"],
  );
});

test("upsertDebateSpawnDraft 会生成 GUI 需要保存的 spawn 节点、spawnRule 和 source->spawn 边", () => {
  const topology: TopologyRecord = {
    nodes: ["线索发现", "漏洞论证模板", "漏洞挑战模板", "Summary模板"],
    edges: [],
    nodeRecords: [
      { id: "线索发现", kind: "agent", templateName: "线索发现" },
      { id: "漏洞论证模板", kind: "agent", templateName: "漏洞论证模板" },
      { id: "漏洞挑战模板", kind: "agent", templateName: "漏洞挑战模板" },
      { id: "Summary模板", kind: "agent", templateName: "Summary模板" },
    ],
    spawnRules: [],
  };

  const next = upsertDebateSpawnDraft(topology, {
    teamName: "疑点辩论工厂",
    sourceTemplateName: "线索发现",
    proTemplateName: "漏洞论证模板",
    conTemplateName: "漏洞挑战模板",
    summaryTemplateName: "Summary模板",
    reportToTemplateName: "线索发现",
  });

  assert.equal(
    next.nodeRecords?.some(
      (node) => node.id === "疑点辩论工厂" && node.kind === "spawn",
    ),
    true,
  );
  assert.equal(next.spawnRules?.[0]?.id, "spawn-rule:疑点辩论工厂");
  assert.equal(next.spawnRules?.[0]?.reportToTrigger, "<default>");
  assert.deepEqual(next.edges, [
    {
      source: "线索发现",
      target: "疑点辩论工厂",
      trigger: "<default>",
      messageMode: "last",
    },
  ]);
});
