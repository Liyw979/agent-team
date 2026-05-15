import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";

import {
  compileBuiltinTopology,
  readBuiltinTopology,
} from "../../test-support/runtime/builtin-topology-test-helpers";
import { instantiateGroupBundle } from "./runtime-topology";

const BUILTIN_TOPOLOGY_DIR = path.resolve("config/team-topologies");

test("本项目内提供开发团队与漏洞挖掘团队拓扑文件", () => {
  assert.equal(fs.existsSync(path.join(BUILTIN_TOPOLOGY_DIR, "development-team.topology.yaml")), true);
  assert.equal(fs.existsSync(path.join(BUILTIN_TOPOLOGY_DIR, "single-agent-ba.topology.yaml")), true);
  assert.equal(fs.existsSync(path.join(BUILTIN_TOPOLOGY_DIR, "vulnerability.yaml")), true);
  assert.equal(fs.existsSync(path.join(BUILTIN_TOPOLOGY_DIR, "rfc-scanner.yaml")), true);
  assert.equal(fs.existsSync(path.join(BUILTIN_TOPOLOGY_DIR, "development-team.topology.ts")), false);
  assert.equal(fs.existsSync(path.join(BUILTIN_TOPOLOGY_DIR, "vulnerability-team.topology.ts")), false);
});

test("内置团队拓扑 YAML 节点使用 id 字段而不是 name 字段", () => {
  for (const fileName of [
    "development-team.topology.yaml",
    "single-agent-ba.topology.yaml",
    "vulnerability.yaml",
    "rfc-scanner.yaml",
  ]) {
    const topology = readBuiltinTopology(fileName);
    const stack = [...topology.nodes];
    while (stack.length > 0) {
      const node = stack.pop();
      assert.ok(node);
      assert.equal(typeof node.id, "string", `${fileName} 节点必须使用 id 字段`);
      assert.equal(Object.prototype.hasOwnProperty.call(node, "name"), false, `${fileName} 节点不能使用 name 字段`);
      if (node.type === "agent") {
        assert.equal(Object.prototype.hasOwnProperty.call(node, "prompt"), false, `${fileName} agent 节点不能使用 prompt 字段`);
        assert.equal(typeof node.system_prompt, "string", `${fileName} agent 节点必须使用 system_prompt 字段`);
      }
      if (node.type === "group") {
        stack.push(...node.nodes);
      }
    }
  }
});

test("开发团队拓扑为每个 decisionAgent 显式声明回流与成功 trigger", () => {
  const topology = readBuiltinTopology("development-team.topology.yaml");
  for (const agentId of ["CodeReview", "UnitTest", "SecurityReview"]) {
    const links = topology.links.filter((link) => link.from === agentId);
    assert.deepEqual(
      links.map((link) => link.trigger).sort(),
      ["<complete>", "<continue>"],
    );
    assert.equal(links.some((link) => link.to === "Build" && link.trigger === "<continue>"), true);
    assert.equal(links.some((link) => link.to === "__end__" && link.trigger === "<complete>"), true);
  }
});

test("开发团队拓扑编译后保留显式成功结束边", () => {
  const compiled = compileBuiltinTopology("development-team.topology.yaml");
  assert.deepEqual(compiled.topology.flow.end, {
    id: "__end__",
    sources: ["CodeReview", "UnitTest", "SecurityReview"],
    incoming: [
      { source: "CodeReview", trigger: "<complete>" },
      { source: "UnitTest", trigger: "<complete>" },
      { source: "SecurityReview", trigger: "<complete>" },
    ],
  });
});

test("单 Agent 示例拓扑也使用递归式 DSL 并可直接编译", () => {
  const topology = readBuiltinTopology("single-agent-ba.topology.yaml");
  const compiled = compileBuiltinTopology("single-agent-ba.topology.yaml");
  assert.equal(topology.entry, "BA");
  assert.deepEqual(compiled.topology.nodes, ["BA"]);
  assert.deepEqual(compiled.topology.edges, []);
});

test("漏洞挖掘团队默认使用论证与挑战多轮对弈，而不是固定四个辩手串行两轮", () => {
  const topology = readBuiltinTopology("vulnerability.yaml");
  const debateNode = topology.nodes.find((node) => node.id === "疑点辩论");
  assert.ok(debateNode);
  assert.equal(debateNode.type, "group");
  assert.deepEqual(
    topology.links
      .filter((link) => ["漏洞论证", "误报论证", "讨论总结"].includes(link.from))
      .map((link) => ({ from: link.from, to: link.to, trigger: link.trigger })),
    [
      { from: "漏洞论证", to: "误报论证", trigger: "<continue>" },
      { from: "误报论证", to: "漏洞论证", trigger: "<continue>" },
      { from: "漏洞论证", to: "讨论总结", trigger: "<agree>" },
      { from: "误报论证", to: "讨论总结", trigger: "<agree>" },
      { from: "讨论总结", to: "线索发现", trigger: "<default>" },
    ],
  );
});

test("漏洞挖掘团队里线索发现准备结束时，会先经过线索完备性评估再决定继续还是结束", () => {
  const topology = readBuiltinTopology("vulnerability.yaml");
  assert.equal(
    topology.links.some((link) => link.from === "线索发现" && link.to === "线索完备性评估" && link.trigger === "<complete>"),
    true,
  );
  assert.equal(
    topology.links.some((link) => link.from === "线索完备性评估" && link.to === "线索发现" && link.trigger === "<continue>"),
    true,
  );
  assert.equal(
    topology.links.some((link) => link.from === "线索完备性评估" && link.to === "__end__" && link.trigger === "<complete>"),
    true,
  );
});

test("漏洞挖掘团队的 group 实例会继承 线索发现 -> 疑点辩论 的 messageMode 到 entry runtime edge", () => {
  const compiled = compileBuiltinTopology("vulnerability.yaml");
  const bundle = instantiateGroupBundle({
    topology: compiled.topology,
    groupRuleId: "group-rule:疑点辩论",
    activationId: "activation-1",
    item: {
      id: "finding-001",
      title: "路径穿越",
    },
  });

  assert.deepEqual(bundle.edges[0], {
    source: "线索发现",
    target: "误报论证-1",
    trigger: "<continue>",
    messageMode: "last",
    maxTriggerRounds: 999,
  });
});
