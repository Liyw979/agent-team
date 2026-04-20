import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveProjectAgents,
  validateProjectAgents,
} from "./project-agent-source";

test("resolveProjectAgents 在存在 DSL agents 时直接返回 DSL prompt", () => {
  const resolved = resolveProjectAgents({
    dslAgents: [
      { name: "BA", prompt: "DSL BA prompt", isWritable: false },
      { name: "Build", prompt: "", isWritable: true },
    ],
  });

  assert.deepEqual(resolved, [
    { name: "BA", prompt: "DSL BA prompt", isWritable: false },
    { name: "Build", prompt: "", isWritable: true },
  ]);
});

test("resolveProjectAgents 在不存在 DSL agents 时不再回退到用户自定义 prompt", () => {
  const resolved = resolveProjectAgents({
    dslAgents: null,
  });

  assert.deepEqual(resolved, []);
});

test("validateProjectAgents 只允许一个可写 Agent", () => {
  assert.throws(
    () => validateProjectAgents([
      { name: "Build", prompt: "", isWritable: true },
      { name: "BA", prompt: "dsl", isWritable: true },
    ]),
    /至多只能有一个可写 Agent/,
  );
});
