import assert from "node:assert/strict";
import { test } from "bun:test";

import { createTopologyFlowRecord, type TopologyRecord } from "@shared/types";

import { createEmptyGraphTaskState } from "./gating-state";
import { materializeRuntimeGroupAgentsForItems } from "./gating-group";
import { compileTeamDsl, type TeamDslDefinition } from "./team-dsl";

function createGroupTopology(): TopologyRecord {
  return {
    nodes: ["线索发现", "漏洞疑点辩论", "漏洞论证模板", "误报论证模板", "Summary模板"],
    nodeRecords: [
      { id: "线索发现", kind: "agent", templateName: "线索发现", initialMessageRouting: { mode: "inherit" }, prompt: "", writable: false },
      { id: "漏洞疑点辩论", kind: "group", templateName: "漏洞疑点辩论", groupRuleId: "finding-debate", initialMessageRouting: { mode: "inherit" } },
      { id: "漏洞论证模板", kind: "agent", templateName: "漏洞论证模板", initialMessageRouting: { mode: "inherit" }, prompt: "", writable: false },
      { id: "误报论证模板", kind: "agent", templateName: "误报论证模板", initialMessageRouting: { mode: "inherit" }, prompt: "", writable: false },
      { id: "Summary模板", kind: "agent", templateName: "Summary模板", initialMessageRouting: { mode: "inherit" }, prompt: "", writable: false },
    ],
    edges: [
      { source: "线索发现", target: "漏洞疑点辩论", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
    ],
    flow: createTopologyFlowRecord({
      nodes: ["线索发现", "漏洞疑点辩论", "漏洞论证模板", "误报论证模板", "Summary模板"],
      edges: [
        { source: "线索发现", target: "漏洞疑点辩论", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
      ],
    }),
    groupRules: [
      {
        id: "finding-debate",
        groupNodeName: "漏洞疑点辩论",
        sourceTemplateName: "线索发现",
        entryRole: "pro",
        members: [
          { role: "pro", templateName: "漏洞论证模板" },
          { role: "con", templateName: "误报论证模板" },
          { role: "summary", templateName: "Summary模板" },
        ],
        edges: [
          { sourceRole: "pro", targetRole: "con", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
          { sourceRole: "con", targetRole: "pro", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
          { sourceRole: "pro", targetRole: "summary", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
          { sourceRole: "con", targetRole: "summary", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
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
  };
}

function agentNode(id: string, prompt: string) {
  return {
    type: "agent" as const,
    id,
    system_prompt: prompt,
    writable: false,
  };
}

function groupNode(id: string, nodes: TeamDslDefinition["nodes"]) {
  return {
    type: "group" as const,
    id,
    nodes,
  };
}

function link(
  from: string,
  to: string,
  trigger: `<${string}>`,
  message_type: "none" | "last",
  maxTriggerRounds = 4,
) {
  return { from, to, trigger, message_type, maxTriggerRounds };
}

test("materializeRuntimeGroupAgentsForItems 会把 finding 批量实例化进 GraphTaskState", () => {
  const topology = createGroupTopology();
  const state = createEmptyGraphTaskState({
    topology,
  });

  materializeRuntimeGroupAgentsForItems({
    state,
    groupRuleId: "finding-debate",
    items: [
      { id: "finding-001", title: "路径穿越" },
      { id: "finding-002", title: "鉴权缺失" },
    ],
  });

  assert.equal(state.groupBundles.length, 2);
  assert.equal(state.runtimeNodes.length, 6);
  assert.equal(state.runtimeEdges.length, 12);
  assert.equal(state.agentStatusesByName["漏洞论证模板-1"], "idle");
  assert.equal(state.agentStatusesByName["Summary模板-2"], "idle");
});

test("materializeRuntimeGroupAgentsForItems 展开嵌套 group 时会继承父实例 runtime source", () => {
  const topology = compileTeamDsl({
    entry: "Source",
    nodes: [
      agentNode("Source", "你负责 source。"),
      groupNode("Outer", [
        agentNode("OuterEntry", "你负责外层入口。允许输出 trigger：<outer-next>、<outer-report>"),
        groupNode("Inner", [
          agentNode("InnerEntry", "你负责中层入口。允许输出 trigger：<inner-next>、<inner-report>"),
          agentNode("InnerSummary", "你负责中层总结。允许输出 trigger：<inner-report>"),
        ]),
      ]),
      agentNode("Sink", "你负责汇总。"),
    ],
    links: [
      link("Source", "OuterEntry", "<default>", "last"),
      link("OuterEntry", "InnerEntry", "<outer-next>", "last"),
      link("InnerEntry", "InnerSummary", "<inner-next>", "last"),
      link("InnerSummary", "OuterEntry", "<inner-report>", "none"),
      link("OuterEntry", "Sink", "<outer-report>", "none"),
    ],
  }).topology;
  const state = createEmptyGraphTaskState({
    topology,
  });

  materializeRuntimeGroupAgentsForItems({
    state,
    groupRuleId: "group-rule:Outer",
    activationId: "activation-outer",
    items: [{ id: "case-001", title: "外层条目" }],
    sourceRuntimeNodeId: "Source",
    sourceRuntimeTemplateName: "Source",
  });

  const innerRuntimeGroup = state.runtimeNodes.find((node) => node.kind === "group" && node.id === "Inner-1");
  assert.notEqual(innerRuntimeGroup, undefined);

  materializeRuntimeGroupAgentsForItems({
    state,
    groupRuleId: "group-rule:Inner",
    activationId: "activation-inner",
    items: [{ id: "case-002", title: "中层条目" }],
    sourceRuntimeNodeId: "OuterEntry-1",
    sourceRuntimeTemplateName: "OuterEntry",
    reportRuntimeNodeId: "OuterEntry-1",
  });

  assert.deepEqual(
    state.runtimeEdges.find((edge) => edge.source === "OuterEntry-1" && edge.target === "InnerEntry-2"),
    {
      source: "OuterEntry-1",
      target: "InnerEntry-2",
      trigger: "<outer-next>",
      messageMode: "last", maxTriggerRounds: 4,
    },
  );
  assert.deepEqual(
    state.runtimeEdges.find((edge) => edge.source === "InnerSummary-2" && edge.target === "OuterEntry-1"),
    {
      source: "InnerSummary-2",
      target: "OuterEntry-1",
      trigger: "<inner-report>",
      messageMode: "none", maxTriggerRounds: 4,
    },
  );
  assert.equal(state.runtimeNodes.find((node) => node.id === "InnerEntry-2")?.sourceNodeId, "OuterEntry-1");
});
