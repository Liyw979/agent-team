import assert from "node:assert/strict";
import test from "node:test";

import { compileTeamDsl } from "./team-dsl";

test("compileTeamDsl 支持 v8 递归式图 DSL，并固定使用 items 字段展开 spawn", () => {
  const compiled = compileTeamDsl({
    entry: "初筛",
    nodes: [
      {
        type: "agent",
        name: "初筛",
        prompt: "你负责输出 items。",
        writable: false,
      },
      {
        type: "spawn",
        name: "辩论",
        graph: {
          entry: "正方",
          nodes: [
            {
              type: "agent",
              name: "正方",
              prompt: "你是正方。",
              writable: false,
            },
            {
              type: "agent",
              name: "反方",
              prompt: "你是反方。",
              writable: false,
            },
            {
              type: "agent",
              name: "裁决总结",
              prompt: "你是裁决总结。",
              writable: false,
            },
          ],
          links: [
            { from: "正方", to: "反方", trigger_type: "needs_revision", message_type: "last" },
            { from: "反方", to: "正方", trigger_type: "needs_revision", message_type: "last" },
            { from: "正方", to: "裁决总结", trigger_type: "approved", message_type: "last" },
            { from: "反方", to: "裁决总结", trigger_type: "approved", message_type: "last" },
          ],
        },
      },
    ],
    links: [
      { from: "初筛", to: "辩论", trigger_type: "association", message_type: "last" },
      { from: "辩论", to: "初筛", trigger_type: "association", message_type: "last" },
    ],
  });

  assert.deepEqual(compiled.topology.edges, [
    { source: "初筛", target: "辩论", triggerOn: "association", messageMode: "last" },
    { source: "辩论", target: "初筛", triggerOn: "association", messageMode: "last" },
  ]);
  assert.equal(compiled.topology.spawnRules?.[0]?.name, "辩论");
  assert.equal(compiled.topology.spawnRules?.[0]?.entryRole, "正方");
  assert.deepEqual(compiled.topology.spawnRules?.[0]?.spawnedAgents, [
    { role: "正方", templateName: "正方" },
    { role: "反方", templateName: "反方" },
    { role: "裁决总结", templateName: "裁决总结" },
  ]);
});
