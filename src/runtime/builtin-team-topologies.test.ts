import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  compileBuiltinTopology,
  readBuiltinTopology,
} from "./builtin-topology-test-helpers";
import type { TeamDslDefinition } from "./team-dsl";
import { instantiateSpawnBundle } from "./runtime-topology";

const BUILTIN_TOPOLOGY_DIR = path.resolve("config/team-topologies");

type BuiltinTopology = TeamDslDefinition;
type BuiltinNode = BuiltinTopology["nodes"][number];
type BuiltinLink = BuiltinTopology["links"][number];

test("本项目内提供开发团队与漏洞挖掘团队拓扑文件", () => {
  const developmentTeamFile = path.join(BUILTIN_TOPOLOGY_DIR, "development-team.topology.json5");
  const singleAgentTeamFile = path.join(BUILTIN_TOPOLOGY_DIR, "single-agent-ba.topology.json5");
  const vulnerabilityTeamFile = path.join(BUILTIN_TOPOLOGY_DIR, "vulnerability.json5");
  const legacyDevelopmentTeamFile = path.join(BUILTIN_TOPOLOGY_DIR, "development-team.topology.json");
  const legacySingleAgentTeamFile = path.join(BUILTIN_TOPOLOGY_DIR, "single-agent-ba.topology.json");
  const legacyVulnerabilityTeamFile = path.join(BUILTIN_TOPOLOGY_DIR, "vulnerability-team.topology.json");
  const developmentTeamTsFile = path.join(BUILTIN_TOPOLOGY_DIR, "development-team.topology.ts");
  const vulnerabilityTeamTsFile = path.join(BUILTIN_TOPOLOGY_DIR, "vulnerability-team.topology.ts");

  assert.equal(fs.existsSync(developmentTeamFile), true);
  assert.equal(fs.existsSync(singleAgentTeamFile), true);
  assert.equal(fs.existsSync(vulnerabilityTeamFile), true);
  assert.equal(fs.existsSync(legacyDevelopmentTeamFile), false);
  assert.equal(fs.existsSync(legacySingleAgentTeamFile), false);
  assert.equal(fs.existsSync(legacyVulnerabilityTeamFile), false);
  assert.equal(fs.existsSync(developmentTeamTsFile), false);
  assert.equal(fs.existsSync(vulnerabilityTeamTsFile), false);
});

test("仓库内全部团队拓扑 JSON5 文件都可以被真实解析", () => {
  const topologyFiles = fs.readdirSync(BUILTIN_TOPOLOGY_DIR)
    .filter((fileName) => fileName.endsWith(".json5"));

  assert.equal(topologyFiles.length > 0, true);
  for (const fileName of topologyFiles) {
    assert.doesNotThrow(() => readBuiltinTopology(fileName), `${fileName} 必须是合法 JSON5`);
  }
});

test("内置团队拓扑 JSON5 节点使用 id 字段而不是 name 字段", () => {
  const topologyFiles = [
    "development-team.topology.json5",
    "single-agent-ba.topology.json5",
    "vulnerability.json5",
  ];

  const collectNodes = (nodes: unknown[]): unknown[] =>
    nodes.flatMap((node) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) {
        return [node];
      }
      const childNodes = "graph" in node
        && node.graph
        && typeof node.graph === "object"
        && "nodes" in node.graph
        && Array.isArray(node.graph.nodes)
        ? collectNodes(node.graph.nodes)
        : [];
      return [node, ...childNodes];
    });

  for (const fileName of topologyFiles) {
    const topology = readBuiltinTopology(fileName);
    for (const node of collectNodes(topology.nodes)) {
      assert.equal(typeof (node as { id?: unknown }).id, "string", `${fileName} 节点必须使用 id 字段`);
      assert.equal(Object.prototype.hasOwnProperty.call(node, "name"), false, `${fileName} 节点不能使用 name 字段`);
    }
  }
});

test("开发团队拓扑包含 CodeReview 判定回路", () => {
  const developmentTeamTopology = readBuiltinTopology("development-team.topology.json5");
  const nodeIds = developmentTeamTopology.nodes.map((node: BuiltinNode) => node.id);

  assert.deepEqual(nodeIds.includes("CodeReview"), true);
  assert.equal(developmentTeamTopology.entry, "任务分析");
  assert.equal(
    developmentTeamTopology.links.some(
      (link: BuiltinLink) =>
        link.from === "任务分析" && link.to === "Build" && link.trigger_type === "transfer",
    ),
    true,
  );
  assert.equal(
    developmentTeamTopology.links.some(
      (link: BuiltinLink) => link.from === "Build" && link.to === "CodeReview" && link.trigger_type === "transfer",
    ),
    true,
  );
  assert.equal(
    developmentTeamTopology.links.some(
      (link: BuiltinLink) => link.from === "CodeReview" && link.to === "Build" && link.trigger_type === "continue",
    ),
    true,
  );
});

test("开发团队拓扑文件内直接提供 任务分析 / CodeReview / UnitTest / SecurityReview 的 prompt", () => {
  const developmentTeamTopology = readBuiltinTopology("development-team.topology.json5");
  const nodes = developmentTeamTopology.nodes;

  const build = nodes.find((node: unknown) => typeof node === "object" && node !== null && (node as { id?: string }).id === "Build") as { writable?: boolean } | undefined;
  const taskAnalyst = nodes.find((node: unknown) => typeof node === "object" && node !== null && (node as { id?: string }).id === "任务分析") as { prompt?: string } | undefined;
  const codeDecision = nodes.find((node: unknown) => typeof node === "object" && node !== null && (node as { id?: string }).id === "CodeReview") as { prompt?: string } | undefined;
  const unitTest = nodes.find((node: unknown) => typeof node === "object" && node !== null && (node as { id?: string }).id === "UnitTest") as { prompt?: string } | undefined;
  const securityReview = nodes.find((node: unknown) => typeof node === "object" && node !== null && (node as { id?: string }).id === "SecurityReview") as { prompt?: string } | undefined;

  assert.equal(build?.writable, true);
  assert.equal(typeof taskAnalyst?.prompt, "string");
  assert.equal((taskAnalyst?.prompt ?? "").trim().length > 0, true);
  assert.equal(typeof codeDecision?.prompt, "string");
  assert.equal((codeDecision?.prompt ?? "").trim().length > 0, true);
  assert.equal(typeof unitTest?.prompt, "string");
  assert.equal((unitTest?.prompt ?? "").trim().length > 0, true);
  assert.equal(typeof securityReview?.prompt, "string");
  assert.equal((securityReview?.prompt ?? "").trim().length > 0, true);
});

test("JSON5 团队拓扑可以直接编译为运行时 DSL", () => {
  const compiled = compileBuiltinTopology("development-team.topology.json5");

  assert.equal(compiled.agents.some((agent) => agent.id === "Build"), true);
  assert.equal(compiled.topology.edges.length > 0, true);
  assert.deepEqual(compiled.topology.langgraph, {
    start: {
      id: "__start__",
      targets: ["任务分析"],
    },
    end: null,
  });
});

test("单 Agent 示例拓扑也使用递归式 DSL 并可直接编译", () => {
  const singleAgentTopology = readBuiltinTopology("single-agent-ba.topology.json5");
  const compiled = compileBuiltinTopology("single-agent-ba.topology.json5");

  assert.equal(singleAgentTopology.entry, "BA");
  assert.deepEqual(compiled.topology.nodes, ["BA"]);
  assert.deepEqual(compiled.topology.edges, []);
});

test("漏洞挖掘团队默认使用论证与挑战多轮对弈，而不是固定四个辩手串行两轮", () => {
  const vulnerabilityTeamTopology = readBuiltinTopology("vulnerability.json5");
  const compiled = compileBuiltinTopology("vulnerability.json5");
  const spawnRule = compiled.topology.spawnRules?.[0];
  const debateNode = vulnerabilityTeamTopology.nodes.find((node: BuiltinNode) => node.id === "疑点辩论");
  const completenessAgent = vulnerabilityTeamTopology.nodes.find((node: BuiltinNode) => node.id === "线索完备性评估");

  assert.notEqual(spawnRule, undefined);
  assert.equal(debateNode?.type, "spawn");
  assert.equal(completenessAgent?.type, "agent");
  assert.equal(spawnRule?.id, "spawn-rule:疑点辩论");
  assert.equal(spawnRule?.reportToTemplateName, "线索发现");
  assert.equal(spawnRule?.reportToTriggerOn, "transfer");
  assert.equal(spawnRule?.reportToMessageMode, "none");
  assert.equal(spawnRule?.entryRole, "漏洞挑战");
  assert.deepEqual(spawnRule?.spawnedAgents, [
    { role: "漏洞挑战", templateName: "漏洞挑战" },
    { role: "漏洞论证", templateName: "漏洞论证" },
    { role: "讨论总结", templateName: "讨论总结" },
  ]);
  assert.deepEqual(spawnRule?.edges, [
    { sourceRole: "漏洞论证", targetRole: "漏洞挑战", triggerOn: "continue", messageMode: "last" },
    { sourceRole: "漏洞挑战", targetRole: "漏洞论证", triggerOn: "continue", messageMode: "last" },
    { sourceRole: "漏洞论证", targetRole: "讨论总结", triggerOn: "complete", messageMode: "last-all" },
    { sourceRole: "漏洞挑战", targetRole: "讨论总结", triggerOn: "complete", messageMode: "last-all" },
  ]);
  assert.equal(compiled.topology.edges.some((edge) => edge.source === "疑点辩论" && edge.target === "线索发现"), false);
  assert.deepEqual(compiled.topology.langgraph?.end, {
    id: "__end__",
    sources: ["线索完备性评估"],
    incoming: [
      { source: "线索完备性评估", triggerOn: "complete" },
    ],
  });
  assert.equal(
    vulnerabilityTeamTopology.links.some((link: BuiltinLink) =>
      link.from === "线索完备性评估" && link.to === "__end__" && link.trigger_type === "complete"),
    true,
  );
  assert.equal(
    debateNode?.type === "spawn" && debateNode.graph.links.some((link: BuiltinLink) =>
      link.from === "讨论总结" && link.to === "线索发现" && link.trigger_type === "transfer" && link.message_type === "none"),
    true,
  );
});

test("漏洞挖掘团队里线索发现准备结束时，会先经过线索完备性评估再决定继续还是结束", () => {
  const vulnerabilityTeamTopology = readBuiltinTopology("vulnerability.json5");
  const compiled = compileBuiltinTopology("vulnerability.json5");

  assert.equal(
    compiled.topology.edges.some((edge) =>
      edge.source === "线索发现"
      && edge.target === "疑点辩论"
      && edge.triggerOn === "continue"
      && edge.maxContinueRounds === 999),
    true,
  );
  assert.equal(
    vulnerabilityTeamTopology.links.some((link: BuiltinLink) =>
      link.from === "线索发现"
      && link.to === "疑点辩论"
      && link.trigger_type === "continue"
      && link.maxContinueRounds === 999),
    true,
  );
  assert.deepEqual(compiled.topology.langgraph?.end, {
    id: "__end__",
    sources: ["线索完备性评估"],
    incoming: [
      { source: "线索完备性评估", triggerOn: "complete" },
    ],
  });
  assert.equal(
    vulnerabilityTeamTopology.links.some((link: BuiltinLink) =>
      link.from === "线索发现"
      && link.to === "线索完备性评估"
      && link.trigger_type === "complete"
      && link.message_type === "last"),
    true,
  );
  assert.equal(
    vulnerabilityTeamTopology.links.some((link: BuiltinLink) =>
      link.from === "线索完备性评估"
      && link.to === "线索发现"
      && link.trigger_type === "continue"
      && link.message_type === "last"),
    true,
  );
  assert.equal(
    vulnerabilityTeamTopology.links.some((link: BuiltinLink) =>
      link.from === "线索完备性评估" && link.to === "__end__" && link.trigger_type === "complete"),
    true,
  );
});

test("漏洞挖掘团队的 spawn 实例会继承 线索发现 -> 疑点辩论 的 messageMode 到 entry runtime edge", () => {
  const compiled = compileBuiltinTopology("vulnerability.json5");
  const bundle = instantiateSpawnBundle({
    topology: compiled.topology,
    spawnRuleId: "spawn-rule:疑点辩论",
    activationId: "activation-1",
    item: {
      id: "finding-001",
      title: "路径穿越",
    },
  });

  assert.deepEqual(bundle.edges[0], {
    source: "线索发现",
    target: "漏洞挑战-1",
    triggerOn: "continue",
    messageMode: "last-all",
    maxContinueRounds: 999,
  });
});
