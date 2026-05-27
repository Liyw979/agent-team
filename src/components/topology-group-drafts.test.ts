import { test } from "bun:test";
import assert from "node:assert/strict";

import { createTopologyFlowRecord, type TopologyRecord } from "@shared/types";

import {
  getTopologyDisplayNodeIds,
  upsertDebateGroupDraft,
} from "./topology-group-drafts";

function withFlow(
  topology: Omit<TopologyRecord, "flow"> & Partial<Pick<TopologyRecord, "flow">>,
): TopologyRecord {
  return {
    ...topology,
    flow: topology.flow ?? createTopologyFlowRecord({
      nodes: topology.nodes,
      edges: topology.edges,
    }),
  };
}

function agentNode(input: { id: string; templateName: string; prompt: string; writable: boolean }) {
  return {
    id: input.id,
    kind: "agent" as const,
    templateName: input.templateName,
    initialMessageRouting: { mode: "inherit" as const },
    prompt: input.prompt,
    writable: input.writable,
  };
}

function groupNode(input: { id: string; templateName: string; groupRuleId: string }) {
  return {
    id: input.id,
    kind: "group" as const,
    templateName: input.templateName,
    groupRuleId: input.groupRuleId,
    initialMessageRouting: { mode: "inherit" as const },
  };
}

test("getTopologyDisplayNodeIds 在没有运行过任何 agent 时不展示静态节点", () => {
  const topology: TopologyRecord = withFlow({
    nodes: ["线索发现", "漏洞论证模板", "误报论证模板", "Summary模板"],
    nodeRecords: [
      agentNode({ id: "线索发现", templateName: "线索发现", prompt: "", writable: false }),
      groupNode({ id: "疑点辩论工厂", templateName: "漏洞论证模板", groupRuleId: "group-rule:漏洞团队" }),
    ],
    edges: [],
    groupRules: [],
  });

  assert.deepEqual(getTopologyDisplayNodeIds(topology, []), []);
});

test("getTopologyDisplayNodeIds 只展示已经运行过的静态节点与 runtime 实例", () => {
  const topology: TopologyRecord = withFlow({
    nodes: ["线索发现", "疑点辩论", "漏洞论证-1", "误报论证-1"],
    nodeRecords: [
      agentNode({ id: "线索发现", templateName: "线索发现", prompt: "", writable: false }),
      groupNode({ id: "疑点辩论", templateName: "疑点辩论", groupRuleId: "group-rule:疑点辩论" }),
      agentNode({ id: "漏洞论证-1", templateName: "漏洞论证", prompt: "", writable: false }),
      agentNode({ id: "误报论证-1", templateName: "误报论证", prompt: "", writable: false }),
    ],
    edges: [],
    groupRules: [],
  });

  assert.deepEqual(
    getTopologyDisplayNodeIds(topology, [
      "线索发现",
      "漏洞论证-1",
      "误报论证-1",
    ]),
    ["线索发现", "漏洞论证-1", "误报论证-1"],
  );
});

test("getTopologyDisplayNodeIds 会用 runtime 实例替换已展开的静态模板节点", () => {
  const topology: TopologyRecord = withFlow({
    nodes: ["线索发现", "漏洞论证", "误报论证", "讨论总结", "疑点辩论"],
    nodeRecords: [
      agentNode({ id: "线索发现", templateName: "线索发现", prompt: "", writable: false }),
      agentNode({ id: "漏洞论证", templateName: "漏洞论证", prompt: "", writable: false }),
      agentNode({ id: "误报论证", templateName: "误报论证", prompt: "", writable: false }),
      agentNode({ id: "讨论总结", templateName: "讨论总结", prompt: "", writable: false }),
      groupNode({ id: "疑点辩论", templateName: "疑点辩论", groupRuleId: "group-rule:疑点辩论" }),
    ],
    edges: [],
    groupRules: [
      {
        id: "疑点辩论",
        groupNodeName: "疑点辩论",
        sourceTemplateName: "线索发现",
        entryRole: "漏洞论证",
        members: [
          {role: "漏洞论证", templateName: "漏洞论证"},
          {role: "误报论证", templateName: "误报论证"},
          {role: "讨论总结", templateName: "讨论总结"},
        ],
        edges: [
          {
            sourceRole: "漏洞论证",
            targetRole: "误报论证",
            trigger: "<continue>",
            messageMode: "last", maxTriggerRounds: 4,
          },
          {
            sourceRole: "误报论证",
            targetRole: "漏洞论证",
            trigger: "<continue>",
            messageMode: "last", maxTriggerRounds: 4,
          },
          {
            sourceRole: "漏洞论证",
            targetRole: "讨论总结",
            trigger: "<complete>",
            messageMode: "last", maxTriggerRounds: 4,
          },
          {
            sourceRole: "误报论证",
            targetRole: "讨论总结",
            trigger: "<complete>",
            messageMode: "last", maxTriggerRounds: 4,
          },
        ],
        report: {
          sourceRole: "summary",
          templateName: "线索发现",
          trigger: "<default>",
          messageMode: "last",
          maxTriggerRounds: -1,
        },
      },
    ],
  });

  assert.deepEqual(
    getTopologyDisplayNodeIds(topology, [
      "线索发现",
      "误报论证",
      "漏洞论证",
      "漏洞论证-1",
      "讨论总结",
      "讨论总结-1",
    ]),
    ["线索发现", "漏洞论证-1", "误报论证", "讨论总结-1"],
  );
});

test("getTopologyDisplayNodeIds 在同模板多次 group 时只保留最新实例，固定复用原列位置", () => {
  const topology: TopologyRecord = withFlow({
    nodes: ["线索发现", "漏洞挖掘", "误报论证", "讨论总结", "疑点辩论"],
    nodeRecords: [
      agentNode({ id: "线索发现", templateName: "线索发现", prompt: "", writable: false }),
      agentNode({ id: "漏洞挖掘", templateName: "漏洞挖掘", prompt: "", writable: false }),
      agentNode({ id: "误报论证", templateName: "误报论证", prompt: "", writable: false }),
      agentNode({ id: "讨论总结", templateName: "讨论总结", prompt: "", writable: false }),
      groupNode({ id: "疑点辩论", templateName: "疑点辩论", groupRuleId: "group-rule:疑点辩论" }),
    ],
    edges: [],
    groupRules: [
      {
        id: "group-rule:疑点辩论",
        groupNodeName: "疑点辩论",
        sourceTemplateName: "线索发现",
        entryRole: "漏洞挖掘",
        members: [
          {role: "漏洞挖掘", templateName: "漏洞挖掘"},
          {role: "误报论证", templateName: "误报论证"},
          {role: "讨论总结", templateName: "讨论总结"},
        ],
        edges: [],
        report: {
          sourceRole: "summary",
          templateName: "线索发现",
          trigger: "<default>",
          messageMode: "last",
          maxTriggerRounds: -1,
        },
      },
    ],
  });

  assert.deepEqual(
    getTopologyDisplayNodeIds(topology, [
      "线索发现",
      "漏洞挖掘",
      "漏洞挖掘-1",
      "漏洞挖掘-2",
      "误报论证",
      "误报论证-1",
      "误报论证-2",
      "讨论总结",
      "讨论总结-1",
      "讨论总结-2",
    ]),
    ["线索发现", "漏洞挖掘-2", "误报论证-2", "讨论总结-2"],
  );
});

test("upsertDebateGroupDraft 会生成 GUI 需要保存的 group 节点、groupRule 和 source->group 边", () => {
  const topology: TopologyRecord = withFlow({
    nodes: ["线索发现", "漏洞论证模板", "误报论证模板", "Summary模板"],
    edges: [],
    nodeRecords: [
      agentNode({ id: "线索发现", templateName: "线索发现", prompt: "", writable: false }),
      agentNode({ id: "漏洞论证模板", templateName: "漏洞论证模板", prompt: "", writable: false }),
      agentNode({ id: "误报论证模板", templateName: "误报论证模板", prompt: "", writable: false }),
      agentNode({ id: "Summary模板", templateName: "Summary模板", prompt: "", writable: false }),
    ],
    groupRules: [],
  });

  const next = upsertDebateGroupDraft(topology, {
    teamName: "疑点辩论工厂",
    sourceTemplateName: "线索发现",
    proTemplateName: "漏洞论证模板",
    conTemplateName: "误报论证模板",
    summaryTemplateName: "Summary模板",
    reportToTemplateName: "线索发现",
  });

  assert.equal(
    next.nodeRecords.some(
      (node) =>
        node.id === "疑点辩论工厂"
        && node.kind === "group"
        && node.initialMessageRouting.mode === "inherit",
    ),
    true,
  );
  assert.equal(next.groupRules?.[0]?.id, "group-rule:疑点辩论工厂");
  const firstRule = next.groupRules ? next.groupRules[0] : undefined;
  if (!firstRule || firstRule.report === false) {
    throw new Error("缺少 group report 配置");
  }
  assert.equal(firstRule.report.trigger, "<default>");
  assert.deepEqual(next.edges, [
    {
      source: "线索发现",
      target: "疑点辩论工厂",
      trigger: "<default>",
      messageMode: "last", maxTriggerRounds: 4,
    },
  ]);
});
