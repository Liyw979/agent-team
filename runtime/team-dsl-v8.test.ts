import assert from "node:assert/strict";
import test from "node:test";

import { compileTeamDsl } from "./team-dsl";

test("compileTeamDsl 支持 v8 递归式图 DSL，并为 spawn 默认生成 items 字段约定", () => {
  const compiled = compileTeamDsl({
    entry: "初筛",
    nodes: [
      {
        type: "agent",
        name: "初筛",
        prompt: "你负责输出 items。",
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
            },
            {
              type: "agent",
              name: "反方",
              prompt: "你是反方。",
            },
            {
              type: "agent",
              name: "裁决总结",
              prompt: "你是裁决总结。",
            },
          ],
          links: [
            ["正方", "反方", "needs_revision"],
            ["反方", "正方", "needs_revision"],
            ["正方", "裁决总结", "approved"],
            ["反方", "裁决总结", "approved"],
          ],
        },
      },
    ],
    links: [
      ["初筛", "辩论", "association"],
      ["辩论", "初筛", "association"],
    ],
  });

  assert.deepEqual(compiled.topology.edges, [
    { source: "初筛", target: "辩论", triggerOn: "association" },
    { source: "辩论", target: "初筛", triggerOn: "association" },
  ]);
  assert.equal(compiled.topology.spawnRules?.[0]?.name, "辩论");
  assert.equal(compiled.topology.spawnRules?.[0]?.itemsFrom, "items");
  assert.equal(compiled.topology.spawnRules?.[0]?.entryRole, "正方");
  assert.deepEqual(compiled.topology.spawnRules?.[0]?.spawnedAgents, [
    { role: "正方", templateName: "正方" },
    { role: "反方", templateName: "反方" },
    { role: "裁决总结", templateName: "裁决总结" },
  ]);
});
