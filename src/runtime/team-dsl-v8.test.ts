import assert from "node:assert/strict";
import test from "node:test";

import { readBuiltinVulnerabilityTopology } from "./builtin-topology-test-helpers";
import { compileTeamDsl } from "./team-dsl";

test("compileTeamDsl 支持 v8 递归式图 DSL，并固定使用 items 字段展开 spawn", () => {
  const compiled = compileTeamDsl(readBuiltinVulnerabilityTopology());

  assert.deepEqual(compiled.topology.edges, [
    { source: "线索发现", target: "疑点辩论", triggerOn: "continue", messageMode: "last-all" },
  ]);
  assert.equal(compiled.topology.spawnRules?.[0]?.id, "spawn-rule:疑点辩论");
  assert.equal(compiled.topology.spawnRules?.[0]?.entryRole, "漏洞挑战");
  assert.deepEqual(compiled.topology.spawnRules?.[0]?.spawnedAgents, [
    { role: "漏洞挑战", templateName: "漏洞挑战" },
    { role: "漏洞论证", templateName: "漏洞论证" },
    { role: "讨论总结", templateName: "讨论总结" },
  ]);
});
