import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const LANGGRAPH_RUNTIME_SOURCE = fs.readFileSync(new URL("./langgraph-runtime.ts", import.meta.url), "utf8");
const ORCHESTRATOR_SOURCE = fs.readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");

test("LangGraphRuntime 不再通过文件型 checkpointer 落盘 checkpoint", () => {
  assert.doesNotMatch(LANGGRAPH_RUNTIME_SOURCE, /class FileMemorySaver extends MemorySaver/);
  assert.doesNotMatch(LANGGRAPH_RUNTIME_SOURCE, /writeFileAtomic\s*\(/);
  assert.doesNotMatch(LANGGRAPH_RUNTIME_SOURCE, /getThreadPath\s*\(/);
});

test("Orchestrator 不再把 LangGraph checkpoint 固定到 .agent-team/langgraph", () => {
  assert.doesNotMatch(ORCHESTRATOR_SOURCE, /checkpointDir:\s*path\.join\(cwd,\s*["']\.agent-team["'],\s*["']langgraph["']\)/);
});
