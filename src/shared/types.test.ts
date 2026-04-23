import test from "node:test";
import assert from "node:assert/strict";

import {
  createDefaultTopology,
  getSpawnRules,
  getActionRequiredEdgeLoopLimit,
  isReviewAgentInTopology,
  normalizeTopologyEdgeTrigger,
  type TopologyAgentSeed,
  type TopologyRecord,
  usesOpenCodeBuiltinPrompt,
} from "./types";
import { readFileSync } from "node:fs";

const TYPES_SOURCE = readFileSync(new URL("./types.ts", import.meta.url), "utf8");
const MESSAGE_RECORD_BLOCK = TYPES_SOURCE.match(/export interface MessageRecord \{[\s\S]*?\n\}/u)?.[0] ?? "";
const TOPOLOGY_RECORD_BLOCK = TYPES_SOURCE.match(/export interface TopologyRecord \{[\s\S]*?\n\}/u)?.[0] ?? "";

test("默认拓扑只生成首节点到次节点的 transfer 边", () => {
  const agents: TopologyAgentSeed[] = [
    { id: "BA" },
    { id: "Build" },
    { id: "TaskReview" },
  ];

  const topology = createDefaultTopology(agents);

  assert.deepEqual(topology.nodes, ["Build", "BA", "TaskReview"]);
  assert.equal(topology.edges.length, 1);
  assert.deepEqual(topology.edges[0], {
    source: "Build",
    target: "BA",
    triggerOn: "transfer",
    messageMode: "last",
  });
  assert.deepEqual(topology.langgraph, {
    start: {
      id: "__start__",
      targets: ["Build"],
    },
    end: null,
  });
  assert.equal(
    topology.edges.some((edge) => edge.triggerOn === "complete" || edge.triggerOn === "continue"),
    false,
  );
});

test("默认拓扑在缺少 Build 时不会偷偷把首个 Agent 当起点", () => {
  const agents: TopologyAgentSeed[] = [
    { id: "BA" },
    { id: "TaskReview" },
  ];

  const topology = createDefaultTopology(agents);

  assert.deepEqual(topology.nodes, ["BA", "TaskReview"]);
  assert.deepEqual(topology.edges, []);
  assert.deepEqual(topology.langgraph, {
    start: {
      id: "__start__",
      targets: ["BA"],
    },
    end: null,
  });
});

test("存在 review 出边时 isReviewAgentInTopology 返回 true", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "TaskReview"],
    edges: [
      {
        source: "TaskReview",
        target: "Build",
        triggerOn: "continue",
        messageMode: "last",
      },
    ],
  };

  assert.equal(isReviewAgentInTopology(topology, "TaskReview"), true);
  assert.equal(isReviewAgentInTopology(topology, "Build"), false);
});

test("continue 边默认回流上限为 4，且支持按边单独覆盖", () => {
  const topology: TopologyRecord = {
    nodes: ["Build", "UnitTest", "TaskReview"],
    edges: [
      {
        source: "UnitTest",
        target: "Build",
        triggerOn: "continue",
        messageMode: "last",
      },
      {
        source: "TaskReview",
        target: "Build",
        triggerOn: "continue",
        messageMode: "last",
        maxRevisionRounds: 7,
      },
    ],
  };

  assert.equal(getActionRequiredEdgeLoopLimit(topology, "UnitTest", "Build"), 4);
  assert.equal(getActionRequiredEdgeLoopLimit(topology, "TaskReview", "Build"), 7);
});

test("只有 Build 继续视为 OpenCode 内置 prompt", () => {
  assert.equal(usesOpenCodeBuiltinPrompt("Build"), true);
  assert.equal(usesOpenCodeBuiltinPrompt("build"), true);
  assert.equal(usesOpenCodeBuiltinPrompt("BA"), false);
  assert.equal(usesOpenCodeBuiltinPrompt("UnitTest"), false);
});

test("未知 trigger 会回退到 transfer，canonical trigger 保持新命名", () => {
  assert.equal(normalizeTopologyEdgeTrigger("unknown"), "transfer");
  assert.equal(normalizeTopologyEdgeTrigger("transfer"), "transfer");
  assert.equal(normalizeTopologyEdgeTrigger("complete"), "complete");
  assert.equal(normalizeTopologyEdgeTrigger("continue"), "continue");
});

test("MessageRecord 不再暴露无生产用途的 projectId / sessionId / sourceAgentId", () => {
  assert.equal(MESSAGE_RECORD_BLOCK.includes("  projectId?: string;\n"), false);
  assert.equal(MESSAGE_RECORD_BLOCK.includes("  sessionId?: string;\n"), false);
  assert.equal(MESSAGE_RECORD_BLOCK.includes("  sourceAgentId?: string;\n"), false);
});

test("TopologyRecord 不再暴露无生产用途的 projectId", () => {
  assert.equal(TOPOLOGY_RECORD_BLOCK.includes("  projectId?: string;\n"), false);
});

test("MessageRecord 使用必选 kind 作为判别字段，并为用户消息保留显式种类", () => {
  assert.equal(MESSAGE_RECORD_BLOCK.includes("  kind?:"), false);
  assert.match(TYPES_SOURCE, /kind:\s*"user"/u);
  assert.match(TYPES_SOURCE, /kind:\s*"system-message"/u);
});

test("getSpawnRules 保留显式声明的 messageMode，不再依赖默认补值", () => {
  const topology: TopologyRecord = {
    nodes: ["线索发现", "疑点辩论"],
    edges: [],
    nodeRecords: [
      {
        id: "线索发现",
        kind: "agent",
        templateName: "线索发现",
      },
      {
        id: "疑点辩论",
        kind: "spawn",
        templateName: "疑点辩论",
        spawnEnabled: true,
        spawnRuleId: "spawn-rule:疑点辩论",
      },
    ],
    spawnRules: [
      {
        id: "疑点辩论",
        spawnNodeName: "疑点辩论",
        sourceTemplateName: "线索发现",
        entryRole: "pro",
        spawnedAgents: [
          { role: "pro", templateName: "漏洞论证" },
          { role: "con", templateName: "漏洞挑战" },
        ],
        edges: [
          {
            sourceRole: "pro",
            targetRole: "con",
            triggerOn: "continue",
            messageMode: "all",
          },
        ],
        exitWhen: "all_completed",
      },
    ],
  };

  assert.deepEqual(getSpawnRules(topology)[0]?.edges, [
    {
      sourceRole: "pro",
      targetRole: "con",
      triggerOn: "continue",
      messageMode: "all",
    },
  ]);
});
