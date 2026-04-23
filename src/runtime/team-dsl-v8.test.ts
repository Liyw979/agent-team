import assert from "node:assert/strict";
import test from "node:test";

import { compileTeamDsl } from "./team-dsl";

test("compileTeamDsl 支持 v8 递归式图 DSL，并固定使用 items 字段展开 spawn", () => {
  const compiled = compileTeamDsl({
    entry: "线索发现",
    nodes: [
      {
        type: "agent",
        id: "线索发现",
        prompt: "你负责输出 items。",
        writable: false,
      },
      {
        type: "spawn",
        id: "辩论",
        graph: {
          entry: "漏洞论证",
          nodes: [
            {
              type: "agent",
              id: "漏洞论证",
              prompt: "你是漏洞论证。",
              writable: false,
            },
            {
              type: "agent",
              id: "漏洞挑战",
              prompt: "你是漏洞挑战。",
              writable: false,
            },
            {
              type: "agent",
              id: "讨论总结",
              prompt: "你是讨论总结。",
              writable: false,
            },
          ],
          links: [
            { from: "漏洞论证", to: "漏洞挑战", trigger_type: "continue", message_type: "last" },
            { from: "漏洞挑战", to: "漏洞论证", trigger_type: "continue", message_type: "last" },
            { from: "漏洞论证", to: "讨论总结", trigger_type: "complete", message_type: "last" },
            { from: "漏洞挑战", to: "讨论总结", trigger_type: "complete", message_type: "last" },
          ],
        },
      },
    ],
    links: [
      { from: "线索发现", to: "辩论", trigger_type: "transfer", message_type: "last" },
      { from: "辩论", to: "线索发现", trigger_type: "transfer", message_type: "last" },
    ],
  });

  assert.deepEqual(compiled.topology.edges, [
    { source: "线索发现", target: "辩论", triggerOn: "transfer", messageMode: "last" },
    { source: "辩论", target: "线索发现", triggerOn: "transfer", messageMode: "last" },
  ]);
  assert.equal(compiled.topology.spawnRules?.[0]?.id, "spawn-rule:辩论");
  assert.equal(compiled.topology.spawnRules?.[0]?.entryRole, "漏洞论证");
  assert.deepEqual(compiled.topology.spawnRules?.[0]?.spawnedAgents, [
    { role: "漏洞论证", templateName: "漏洞论证" },
    { role: "漏洞挑战", templateName: "漏洞挑战" },
    { role: "讨论总结", templateName: "讨论总结" },
  ]);
});
