import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { compileTeamDsl } from "./team-dsl";

const BUILTIN_TOPOLOGY_DIR = path.resolve("config/team-topologies");

test("本项目内提供开发团队与漏洞挖掘团队拓扑文件", () => {
  const developmentTeamFile = path.join(BUILTIN_TOPOLOGY_DIR, "development-team.topology.json");
  const vulnerabilityTeamFile = path.join(BUILTIN_TOPOLOGY_DIR, "vulnerability-team.topology.json");
  const developmentTeamTsFile = path.join(BUILTIN_TOPOLOGY_DIR, "development-team.topology.ts");
  const vulnerabilityTeamTsFile = path.join(BUILTIN_TOPOLOGY_DIR, "vulnerability-team.topology.ts");

  assert.equal(fs.existsSync(developmentTeamFile), true);
  assert.equal(fs.existsSync(vulnerabilityTeamFile), true);
  assert.equal(fs.existsSync(developmentTeamTsFile), false);
  assert.equal(fs.existsSync(vulnerabilityTeamTsFile), false);
});

function readBuiltinTopology(fileName: string) {
  return JSON.parse(
    fs.readFileSync(path.resolve(BUILTIN_TOPOLOGY_DIR, fileName), "utf8"),
  ) as Parameters<typeof compileTeamDsl>[0];
}

test("开发团队拓扑包含 CodeReview 审查回路", () => {
  const developmentTeamTopology = readBuiltinTopology("development-team.topology.json");
  const agentNames = developmentTeamTopology.agents.map((agent) => agent.name);

  assert.deepEqual(agentNames.includes("CodeReview"), true);
  assert.equal(
    developmentTeamTopology.topology.downstream.Build?.CodeReview,
    "association",
  );
  assert.equal(
    developmentTeamTopology.topology.downstream.CodeReview?.Build,
    "needs_revision",
  );
  assert.deepEqual(developmentTeamTopology.topology.langgraph, {
    start: "BA",
    end: null,
  });
});

test("开发团队拓扑文件内直接提供 BA / CodeReview / UnitTest / TaskReview 的 prompt", () => {
  const developmentTeamTopology = readBuiltinTopology("development-team.topology.json");
  const agents = developmentTeamTopology.agents;

  const build = agents.find((agent: unknown) => typeof agent === "object" && agent !== null && (agent as { name?: string }).name === "Build") as { writable?: boolean } | undefined;
  const ba = agents.find((agent: unknown) => typeof agent === "object" && agent !== null && (agent as { name?: string }).name === "BA") as { prompt?: string } | undefined;
  const codeReview = agents.find((agent: unknown) => typeof agent === "object" && agent !== null && (agent as { name?: string }).name === "CodeReview") as { prompt?: string } | undefined;
  const unitTest = agents.find((agent: unknown) => typeof agent === "object" && agent !== null && (agent as { name?: string }).name === "UnitTest") as { prompt?: string } | undefined;
  const taskReview = agents.find((agent: unknown) => typeof agent === "object" && agent !== null && (agent as { name?: string }).name === "TaskReview") as { prompt?: string } | undefined;

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

test("漏洞挖掘团队默认使用正反双方多轮对弈，而不是固定四个辩手串行两轮", () => {
  const vulnerabilityTeamTopology = readBuiltinTopology("vulnerability-team.topology.json");
  const compiled = compileTeamDsl(vulnerabilityTeamTopology);
  const spawnRule = compiled.topology.spawnRules?.[0];

  assert.notEqual(spawnRule, undefined);
  assert.equal(spawnRule?.entryRole, "pro");
  assert.deepEqual(spawnRule?.spawnedAgents, [
    { role: "pro", templateName: "正方" },
    { role: "con", templateName: "反方" },
    { role: "summary", templateName: "裁决总结" },
  ]);
  assert.deepEqual(spawnRule?.edges, [
    { sourceRole: "pro", targetRole: "con", triggerOn: "needs_revision" },
    { sourceRole: "con", targetRole: "pro", triggerOn: "needs_revision" },
    { sourceRole: "pro", targetRole: "summary", triggerOn: "approved" },
    { sourceRole: "con", targetRole: "summary", triggerOn: "approved" },
  ]);
});
