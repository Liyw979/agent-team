import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { compileTeamDsl, type TeamDslDefinition } from "./team-dsl";
import { instantiateSpawnBundle } from "./runtime-topology";

const BUILTIN_TOPOLOGY_DIR = path.resolve("config/team-topologies");

type BuiltinTopology = TeamDslDefinition;
type BuiltinNode = BuiltinTopology["nodes"][number];
type BuiltinLink = BuiltinTopology["links"][number];
type BuiltinAgentNode = Extract<BuiltinNode, { type: "agent" }>;

function findBuiltinAgentNode(nodes: BuiltinNode[], name: string): BuiltinAgentNode | undefined {
  return nodes.find((node): node is BuiltinAgentNode => node.type === "agent" && node.name === name);
}

test("本项目内提供开发团队与漏洞挖掘团队拓扑文件", () => {
  const developmentTeamFile = path.join(BUILTIN_TOPOLOGY_DIR, "development-team.topology.json");
  const singleAgentTeamFile = path.join(BUILTIN_TOPOLOGY_DIR, "single-agent-ba.topology.json");
  const vulnerabilityTeamFile = path.join(BUILTIN_TOPOLOGY_DIR, "vulnerability-team.topology.json");
  const developmentTeamTsFile = path.join(BUILTIN_TOPOLOGY_DIR, "development-team.topology.ts");
  const vulnerabilityTeamTsFile = path.join(BUILTIN_TOPOLOGY_DIR, "vulnerability-team.topology.ts");

  assert.equal(fs.existsSync(developmentTeamFile), true);
  assert.equal(fs.existsSync(singleAgentTeamFile), true);
  assert.equal(fs.existsSync(vulnerabilityTeamFile), true);
  assert.equal(fs.existsSync(developmentTeamTsFile), false);
  assert.equal(fs.existsSync(vulnerabilityTeamTsFile), false);
});

function readBuiltinTopology(fileName: string) {
  return JSON.parse(
    fs.readFileSync(path.resolve(BUILTIN_TOPOLOGY_DIR, fileName), "utf8"),
  ) as BuiltinTopology;
}

test("开发团队拓扑包含 CodeReview 审查回路", () => {
  const developmentTeamTopology = readBuiltinTopology("development-team.topology.json");
  const nodeNames = developmentTeamTopology.nodes.map((node: BuiltinNode) => node.name);

  assert.deepEqual(nodeNames.includes("CodeReview"), true);
  assert.equal(developmentTeamTopology.entry, "BA");
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

test("开发团队拓扑文件内直接提供 BA / CodeReview / UnitTest / TaskReview 的 prompt", () => {
  const developmentTeamTopology = readBuiltinTopology("development-team.topology.json");
  const nodes = developmentTeamTopology.nodes;

  const build = nodes.find((node: unknown) => typeof node === "object" && node !== null && (node as { name?: string }).name === "Build") as { writable?: boolean } | undefined;
  const ba = nodes.find((node: unknown) => typeof node === "object" && node !== null && (node as { name?: string }).name === "BA") as { prompt?: string } | undefined;
  const codeReview = nodes.find((node: unknown) => typeof node === "object" && node !== null && (node as { name?: string }).name === "CodeReview") as { prompt?: string } | undefined;
  const unitTest = nodes.find((node: unknown) => typeof node === "object" && node !== null && (node as { name?: string }).name === "UnitTest") as { prompt?: string } | undefined;
  const taskReview = nodes.find((node: unknown) => typeof node === "object" && node !== null && (node as { name?: string }).name === "TaskReview") as { prompt?: string } | undefined;

  assert.equal(build?.writable, true);
  assert.equal(typeof ba?.prompt, "string");
  assert.equal((ba?.prompt ?? "").trim().length > 0, true);
  assert.equal(typeof codeReview?.prompt, "string");
  assert.equal((codeReview?.prompt ?? "").trim().length > 0, true);
  assert.equal(typeof unitTest?.prompt, "string");
  assert.equal((unitTest?.prompt ?? "").trim().length > 0, true);
  assert.equal(typeof taskReview?.prompt, "string");
  assert.equal((taskReview?.prompt ?? "").trim().length > 0, true);
});

test("JSON 团队拓扑可以直接编译为运行时 DSL", () => {
  const developmentTeamTopology = readBuiltinTopology("development-team.topology.json");
  const compiled = compileTeamDsl(developmentTeamTopology);

  assert.equal(compiled.agents.some((agent) => agent.name === "Build"), true);
  assert.equal(compiled.topology.edges.length > 0, true);
  assert.deepEqual(compiled.topology.langgraph, {
    start: {
      id: "__start__",
      targets: ["BA"],
    },
    end: null,
  });
});

test("单 Agent 示例拓扑也使用递归式 DSL 并可直接编译", () => {
  const singleAgentTopology = readBuiltinTopology("single-agent-ba.topology.json");
  const compiled = compileTeamDsl(singleAgentTopology);

  assert.equal(singleAgentTopology.entry, "BA");
  assert.deepEqual(compiled.topology.nodes, ["BA"]);
  assert.deepEqual(compiled.topology.edges, []);
});

test("漏洞挖掘团队默认使用正反双方多轮对弈，而不是固定四个辩手串行两轮", () => {
  const vulnerabilityTeamTopology = readBuiltinTopology("vulnerability-team.topology.json");
  const compiled = compileTeamDsl(vulnerabilityTeamTopology);
  const spawnRule = compiled.topology.spawnRules?.[0];
  const debateNode = vulnerabilityTeamTopology.nodes.find((node: BuiltinNode) => node.name === "疑点辩论");

  assert.notEqual(spawnRule, undefined);
  assert.equal(debateNode?.type, "spawn");
  assert.equal(spawnRule?.name, "疑点辩论");
  assert.equal(spawnRule?.reportToTemplateName, "初筛");
  assert.equal(spawnRule?.reportToTriggerOn, "transfer");
  assert.equal(spawnRule?.entryRole, "反方");
  assert.deepEqual(spawnRule?.spawnedAgents, [
    { role: "正方", templateName: "正方" },
    { role: "反方", templateName: "反方" },
    { role: "裁决总结", templateName: "裁决总结" },
  ]);
  assert.deepEqual(spawnRule?.edges, [
    { sourceRole: "正方", targetRole: "反方", triggerOn: "continue", messageMode: "last" },
    { sourceRole: "反方", targetRole: "正方", triggerOn: "continue", messageMode: "last" },
    { sourceRole: "正方", targetRole: "裁决总结", triggerOn: "complete", messageMode: "last" },
    { sourceRole: "反方", targetRole: "裁决总结", triggerOn: "complete", messageMode: "last" },
  ]);
  assert.equal(compiled.topology.edges.some((edge) => edge.source === "疑点辩论" && edge.target === "初筛"), true);
});

test("漏洞挖掘团队的 spawn 实例会继承 初筛 -> 疑点辩论 的 messageMode 到 entry runtime edge", () => {
  const compiled = compileTeamDsl(readBuiltinTopology("vulnerability-team.topology.json"));
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
    source: "初筛",
    target: "反方-1",
    triggerOn: "transfer",
    messageMode: "all",
  });
});

test("漏洞团队的裁决总结 prompt 约束漏洞输出报告、误报不额外输出，并按 transfer 回到初筛", () => {
  const vulnerabilityTeamTopology = readBuiltinTopology("vulnerability-team.topology.json");
  const debateNode = vulnerabilityTeamTopology.nodes.find((node: BuiltinNode) => node.name === "疑点辩论");
  const summaryNode = debateNode?.type === "spawn"
    ? findBuiltinAgentNode(debateNode.graph.nodes, "裁决总结")
    : undefined;

  assert.equal(typeof summaryNode?.prompt, "string");
  assert.match(summaryNode?.prompt ?? "", /真实漏洞.*正式漏洞报告/u);
  assert.match(summaryNode?.prompt ?? "", /误报.*什么都不做/u);
  assert.match(summaryNode?.prompt ?? "", /<continue>[\s\S]*<complete>/u);
});

test("漏洞挖掘团队的初筛 prompt 要求每次仅返回一个可疑漏洞点", () => {
  const vulnerabilityTeamTopology = readBuiltinTopology("vulnerability-team.topology.json");
  const initialScreeningNode = findBuiltinAgentNode(vulnerabilityTeamTopology.nodes, "初筛");

  assert.equal(typeof initialScreeningNode?.prompt, "string");
  assert.match(initialScreeningNode?.prompt ?? "", /每次仅返回一个可疑的漏洞点/u);
});

test("漏洞挖掘团队的结论类 agent prompt 要求先阅读代码再给结论", () => {
  const vulnerabilityTeamTopology = readBuiltinTopology("vulnerability-team.topology.json");
  const debateNode = vulnerabilityTeamTopology.nodes.find((node: BuiltinNode) => node.name === "疑点辩论");
  const debateAgents = debateNode?.type === "spawn" ? debateNode.graph.nodes : [];
  const proNode = findBuiltinAgentNode(debateAgents, "正方");
  const conNode = findBuiltinAgentNode(debateAgents, "反方");
  const summaryNode = findBuiltinAgentNode(debateAgents, "裁决总结");

  assert.equal(typeof proNode?.prompt, "string");
  assert.equal(typeof conNode?.prompt, "string");
  assert.equal(typeof summaryNode?.prompt, "string");
  assert.match(proNode?.prompt ?? "", /阅读当前项目代码.*支撑|先阅读代码.*再.*结论/u);
  assert.match(conNode?.prompt ?? "", /阅读当前项目代码.*支撑|先阅读代码.*再.*结论/u);
  assert.match(summaryNode?.prompt ?? "", /阅读当前项目代码.*支撑|先阅读代码.*再.*裁决/u);
  assert.match(proNode?.prompt ?? "", /<continue>[\s\S]*<complete>/u);
  assert.match(conNode?.prompt ?? "", /<continue>[\s\S]*<complete>/u);
  assert.match(summaryNode?.prompt ?? "", /<continue>[\s\S]*<complete>/u);
});

test("内置拓扑里的单个 agent prompt 不显式提及其他 agent", () => {
  const developmentTeamTopology = readBuiltinTopology("development-team.topology.json");
  const vulnerabilityTeamTopology = readBuiltinTopology("vulnerability-team.topology.json");

  const assertPromptDoesNotMentionPeerAgents = (
    currentName: string,
    prompt: string,
    peerAgentNames: string[],
  ) => {
    for (const peerAgentName of peerAgentNames) {
      if (peerAgentName === currentName) {
        continue;
      }
      assert.doesNotMatch(prompt, new RegExp(peerAgentName, "u"));
    }
  };

  const developmentAgentNames = developmentTeamTopology.nodes.map((node: BuiltinNode) => node.name);
  for (const node of developmentTeamTopology.nodes) {
    if (node.type !== "agent" || typeof node.prompt !== "string") {
      continue;
    }
    assertPromptDoesNotMentionPeerAgents(node.name, node.prompt, developmentAgentNames);
  }

  const vulnerabilityRootAgentNames = vulnerabilityTeamTopology.nodes.map((node: BuiltinNode) => node.name);
  for (const node of vulnerabilityTeamTopology.nodes) {
    if (node.type === "agent" && typeof node.prompt === "string") {
      assertPromptDoesNotMentionPeerAgents(node.name, node.prompt, vulnerabilityRootAgentNames);
      continue;
    }
    if (node.type !== "spawn") {
      continue;
    }

    const childAgentNames = node.graph.nodes.map((child: BuiltinNode) => child.name);
    for (const child of node.graph.nodes) {
      if (child.type !== "agent" || typeof child.prompt !== "string") {
        continue;
      }
      assertPromptDoesNotMentionPeerAgents(child.name, child.prompt, [
        ...vulnerabilityRootAgentNames,
        ...childAgentNames,
      ]);
    }
  }
});
