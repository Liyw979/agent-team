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
type BuiltinAgentNode = Extract<BuiltinNode, { type: "agent" }>;

function findBuiltinAgentNode(nodes: BuiltinNode[], id: string): BuiltinAgentNode | undefined {
  return nodes.find((node): node is BuiltinAgentNode => node.type === "agent" && node.id === id);
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

test("内置团队拓扑 JSON 节点使用 id 字段而不是 name 字段", () => {
  const topologyFiles = [
    "development-team.topology.json",
    "single-agent-ba.topology.json",
    "vulnerability-team.topology.json",
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

test("开发团队拓扑包含 CodeReview 审查回路", () => {
  const developmentTeamTopology = readBuiltinTopology("development-team.topology.json");
  const nodeIds = developmentTeamTopology.nodes.map((node: BuiltinNode) => node.id);

  assert.deepEqual(nodeIds.includes("CodeReview"), true);
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

  const build = nodes.find((node: unknown) => typeof node === "object" && node !== null && (node as { id?: string }).id === "Build") as { writable?: boolean } | undefined;
  const ba = nodes.find((node: unknown) => typeof node === "object" && node !== null && (node as { id?: string }).id === "BA") as { prompt?: string } | undefined;
  const codeReview = nodes.find((node: unknown) => typeof node === "object" && node !== null && (node as { id?: string }).id === "CodeReview") as { prompt?: string } | undefined;
  const unitTest = nodes.find((node: unknown) => typeof node === "object" && node !== null && (node as { id?: string }).id === "UnitTest") as { prompt?: string } | undefined;
  const taskReview = nodes.find((node: unknown) => typeof node === "object" && node !== null && (node as { id?: string }).id === "TaskReview") as { prompt?: string } | undefined;

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
  const compiled = compileBuiltinTopology("development-team.topology.json");

  assert.equal(compiled.agents.some((agent) => agent.id === "Build"), true);
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
  const compiled = compileBuiltinTopology("single-agent-ba.topology.json");

  assert.equal(singleAgentTopology.entry, "BA");
  assert.deepEqual(compiled.topology.nodes, ["BA"]);
  assert.deepEqual(compiled.topology.edges, []);
});

test("漏洞挖掘团队默认使用论证与挑战多轮对弈，而不是固定四个辩手串行两轮", () => {
  const vulnerabilityTeamTopology = readBuiltinTopology("vulnerability-team.topology.json");
  const compiled = compileBuiltinTopology("vulnerability-team.topology.json");
  const spawnRule = compiled.topology.spawnRules?.[0];
  const debateNode = vulnerabilityTeamTopology.nodes.find((node: BuiltinNode) => node.id === "疑点辩论");

  assert.notEqual(spawnRule, undefined);
  assert.equal(debateNode?.type, "spawn");
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
    sources: ["线索发现"],
    incoming: [
      { source: "线索发现", triggerOn: "complete" },
    ],
  });
  assert.equal(
    vulnerabilityTeamTopology.links.some((link: BuiltinLink) =>
      link.from === "线索发现" && link.to === "__end__" && link.trigger_type === "complete"),
    true,
  );
  assert.equal(
    debateNode?.type === "spawn" && debateNode.graph.links.some((link: BuiltinLink) =>
      link.from === "讨论总结" && link.to === "线索发现" && link.trigger_type === "transfer" && link.message_type === "none"),
    true,
  );
});

test("漏洞挖掘团队里线索发现是条件流转：有 finding 走 continue，没有 finding 走 complete -> END", () => {
  const vulnerabilityTeamTopology = readBuiltinTopology("vulnerability-team.topology.json");
  const compiled = compileBuiltinTopology("vulnerability-team.topology.json");

  assert.equal(
    compiled.topology.edges.some((edge) =>
      edge.source === "线索发现"
      && edge.target === "疑点辩论"
      && edge.triggerOn === "continue"
      && edge.maxRevisionRounds === 999),
    true,
  );
  assert.equal(
    vulnerabilityTeamTopology.links.some((link: BuiltinLink) =>
      link.from === "线索发现"
      && link.to === "疑点辩论"
      && link.trigger_type === "continue"
      && link.maxRevisionRounds === 999),
    true,
  );
  assert.deepEqual(compiled.topology.langgraph?.end, {
    id: "__end__",
    sources: ["线索发现"],
    incoming: [
      { source: "线索发现", triggerOn: "complete" },
    ],
  });
  assert.equal(
    vulnerabilityTeamTopology.links.some((link: BuiltinLink) =>
      link.from === "线索发现" && link.to === "__end__" && link.trigger_type === "complete"),
    true,
  );
});

test("漏洞挖掘团队的 spawn 实例会继承 线索发现 -> 疑点辩论 的 messageMode 到 entry runtime edge", () => {
  const compiled = compileBuiltinTopology("vulnerability-team.topology.json");
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
    maxRevisionRounds: 999,
  });
});

test("漏洞团队的讨论总结 prompt 直接输出总结正文，不再要求 review 标签", () => {
  const vulnerabilityTeamTopology = readBuiltinTopology("vulnerability-team.topology.json");
  const debateNode = vulnerabilityTeamTopology.nodes.find((node: BuiltinNode) => node.id === "疑点辩论");
  const summaryNode = debateNode?.type === "spawn"
    ? findBuiltinAgentNode(debateNode.graph.nodes, "讨论总结")
    : undefined;

  assert.equal(typeof summaryNode?.prompt, "string");
  assert.equal(summaryNode?.writable, true);
  assert.match(summaryNode?.prompt ?? "", /综合当前可疑点已经形成的材料/u);
  assert.match(summaryNode?.prompt ?? "", /result\//u);
  assert.match(summaryNode?.prompt ?? "", /最终判断/u);
  assert.match(summaryNode?.prompt ?? "", /写入的相对路径/u);
  assert.match(summaryNode?.prompt ?? "", /输出总结正文/u);
  assert.match(summaryNode?.prompt ?? "", /支持判断的关键依据/u);
  assert.match(summaryNode?.prompt ?? "", /仍未解决的不确定点/u);
  assert.doesNotMatch(summaryNode?.prompt ?? "", /回复开头必须先输出 <continue>/u);
  assert.doesNotMatch(summaryNode?.prompt ?? "", /回复开头必须先输出 <complete>/u);
});

test("漏洞挖掘团队的线索发现 prompt 要求每次仅返回一个可疑漏洞点", () => {
  const vulnerabilityTeamTopology = readBuiltinTopology("vulnerability-team.topology.json");
  const initialScreeningNode = findBuiltinAgentNode(vulnerabilityTeamTopology.nodes, "线索发现");

  assert.equal(typeof initialScreeningNode?.prompt, "string");
  assert.match(initialScreeningNode?.prompt ?? "", /每次仅返回一个可疑的漏洞点/u);
  assert.doesNotMatch(initialScreeningNode?.prompt ?? "", /items/u);
  assert.doesNotMatch(initialScreeningNode?.prompt ?? "", /TASK_DONE/u);
  assert.match(initialScreeningNode?.prompt ?? "", /<complete>/u);
  assert.match(initialScreeningNode?.prompt ?? "", /<continue>/u);
});

test("漏洞挖掘团队的线索发现 prompt 明确要求回复开头先输出标签再输出正文", () => {
  const vulnerabilityTeamTopology = readBuiltinTopology("vulnerability-team.topology.json");
  const initialScreeningNode = findBuiltinAgentNode(vulnerabilityTeamTopology.nodes, "线索发现");

  assert.equal(typeof initialScreeningNode?.prompt, "string");
  assert.match(initialScreeningNode?.prompt ?? "", /回复开头必须先输出 <continue>，再输出 finding 正文/u);
  assert.match(initialScreeningNode?.prompt ?? "", /回复开头必须先输出 <complete>，再输出简短说明/u);
  assert.doesNotMatch(initialScreeningNode?.prompt ?? "", /末尾追加/u);
  assert.doesNotMatch(initialScreeningNode?.prompt ?? "", /结尾追加/u);
  assert.doesNotMatch(initialScreeningNode?.prompt ?? "", /尾段/u);
});

test("内置拓扑的审查类 prompt 与 system prompt 一致要求回复开头先输出标签", () => {
  const developmentTeamTopology = readBuiltinTopology("development-team.topology.json");
  const vulnerabilityTeamTopology = readBuiltinTopology("vulnerability-team.topology.json");

  const prompts: string[] = [];

  for (const node of developmentTeamTopology.nodes) {
    if (node.type === "agent" && typeof node.prompt === "string" && node.id !== "BA" && node.id !== "Build") {
      prompts.push(node.prompt);
    }
  }

  for (const node of vulnerabilityTeamTopology.nodes) {
    if (node.type === "agent" && typeof node.prompt === "string") {
      prompts.push(node.prompt);
    }
    if (node.type === "spawn") {
      for (const child of node.graph.nodes) {
        if (child.type === "agent" && typeof child.prompt === "string" && child.id !== "讨论总结") {
          prompts.push(child.prompt);
        }
      }
    }
  }

  for (const prompt of prompts) {
    assert.match(prompt, /开头/u);
    assert.doesNotMatch(prompt, /结尾/u);
    assert.doesNotMatch(prompt, /末尾/u);
  }
});

test("内置拓扑的审查类 prompt 不提示右侧结束标签", () => {
  const developmentTeamTopology = readBuiltinTopology("development-team.topology.json");
  const vulnerabilityTeamTopology = readBuiltinTopology("vulnerability-team.topology.json");

  const prompts: string[] = [];

  for (const node of developmentTeamTopology.nodes) {
    if (node.type === "agent" && typeof node.prompt === "string") {
      prompts.push(node.prompt);
    }
  }

  for (const node of vulnerabilityTeamTopology.nodes) {
    if (node.type === "agent" && typeof node.prompt === "string") {
      prompts.push(node.prompt);
    }
    if (node.type === "spawn") {
      for (const child of node.graph.nodes) {
        if (child.type === "agent" && typeof child.prompt === "string") {
          prompts.push(child.prompt);
        }
      }
    }
  }

  for (const prompt of prompts) {
    assert.doesNotMatch(prompt, /<\/continue>/u);
    assert.doesNotMatch(prompt, /<\/complete>/u);
  }
});

test("漏洞挖掘团队的结论类 agent prompt 要求先阅读代码再给结论", () => {
  const vulnerabilityTeamTopology = readBuiltinTopology("vulnerability-team.topology.json");
  const debateNode = vulnerabilityTeamTopology.nodes.find((node: BuiltinNode) => node.id === "疑点辩论");
  const debateAgents = debateNode?.type === "spawn" ? debateNode.graph.nodes : [];
  const proNode = findBuiltinAgentNode(debateAgents, "漏洞论证");
  const conNode = findBuiltinAgentNode(debateAgents, "漏洞挑战");
  const summaryNode = findBuiltinAgentNode(debateAgents, "讨论总结");

  assert.equal(typeof proNode?.prompt, "string");
  assert.equal(typeof conNode?.prompt, "string");
  assert.equal(typeof summaryNode?.prompt, "string");
  assert.match(proNode?.prompt ?? "", /阅读当前项目代码.*支撑|先阅读代码.*再.*结论/u);
  assert.match(conNode?.prompt ?? "", /阅读当前项目代码.*支撑|先阅读代码.*再.*结论/u);
  assert.match(summaryNode?.prompt ?? "", /阅读当前项目代码.*支撑|先阅读代码.*再.*裁决/u);
  assert.match(proNode?.prompt ?? "", /<continue>[\s\S]*<complete>/u);
  assert.match(conNode?.prompt ?? "", /<continue>[\s\S]*<complete>/u);
  assert.doesNotMatch(summaryNode?.prompt ?? "", /回复开头必须先输出 <continue>/u);
  assert.doesNotMatch(summaryNode?.prompt ?? "", /回复开头必须先输出 <complete>/u);
});

test("内置拓扑里的单个 agent prompt 不显式提及其他 agent", () => {
  const developmentTeamTopology = readBuiltinTopology("development-team.topology.json");
  const vulnerabilityTeamTopology = readBuiltinTopology("vulnerability-team.topology.json");

  const assertPromptDoesNotMentionPeerAgents = (
    currentId: string,
    prompt: string,
    peerAgentIds: string[],
  ) => {
    for (const peerAgentId of peerAgentIds) {
      if (peerAgentId === currentId) {
        continue;
      }
      assert.doesNotMatch(prompt, new RegExp(peerAgentId, "u"));
    }
  };

  const developmentAgentIds = developmentTeamTopology.nodes.map((node: BuiltinNode) => node.id);
  for (const node of developmentTeamTopology.nodes) {
    if (node.type !== "agent") {
      continue;
    }
    assertPromptDoesNotMentionPeerAgents(node.id, node.prompt, developmentAgentIds);
  }

  const vulnerabilityRootAgentIds = vulnerabilityTeamTopology.nodes.map((node: BuiltinNode) => node.id);
  for (const node of vulnerabilityTeamTopology.nodes) {
    if (node.type === "agent") {
      assertPromptDoesNotMentionPeerAgents(node.id, node.prompt, vulnerabilityRootAgentIds);
      continue;
    }
    if (node.type !== "spawn") {
      continue;
    }

    const childAgentIds = node.graph.nodes.map((child: BuiltinNode) => child.id);
    for (const child of node.graph.nodes) {
      if (child.type !== "agent") {
        continue;
      }
      assertPromptDoesNotMentionPeerAgents(child.id, child.prompt, [
        ...vulnerabilityRootAgentIds,
        ...childAgentIds,
      ]);
    }
  }
});
