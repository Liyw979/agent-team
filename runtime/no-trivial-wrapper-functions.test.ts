import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const TEAM_DSL_SOURCE = fs.readFileSync(new URL("./team-dsl.ts", import.meta.url), "utf8");
const CLI_COMMAND_SOURCE = fs.readFileSync(new URL("../cli/cli-command.ts", import.meta.url), "utf8");
const CLI_INDEX_SOURCE = fs.readFileSync(new URL("../cli/index.ts", import.meta.url), "utf8");
const APP_SOURCE = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const TOPOLOGY_GRAPH_SOURCE = fs.readFileSync(new URL("../src/components/TopologyGraph.tsx", import.meta.url), "utf8");
const TOPOLOGY_GRAPH_HELPERS_SOURCE = fs.readFileSync(
  new URL("../src/components/topology-graph-helpers.ts", import.meta.url),
  "utf8",
);
const SHARED_TYPES_SOURCE = fs.readFileSync(new URL("../shared/types.ts", import.meta.url), "utf8");
const STORE_SOURCE = fs.readFileSync(new URL("./store.ts", import.meta.url), "utf8");
const ORCHESTRATOR_SOURCE = fs.readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");

test("不再保留一行 return 的 DSL 包装函数 defineTeamDsl", () => {
  assert.doesNotMatch(TEAM_DSL_SOURCE, /export function defineTeamDsl\(/);
});

test("CLI 不再保留 applyCwdOption/applyJsonOption 这类一行包装函数", () => {
  assert.doesNotMatch(CLI_COMMAND_SOURCE, /function applyCwdOption\(/);
  assert.doesNotMatch(CLI_COMMAND_SOURCE, /function applyJsonOption\(/);
});

test("CLI 不再保留 buildOpenAgentTerminalCommand 这类一行包装函数", () => {
  assert.doesNotMatch(CLI_INDEX_SOURCE, /function buildOpenAgentTerminalCommand\(/);
});

test("UI 不再保留只有一行 return 的按钮文案包装函数", () => {
  assert.doesNotMatch(APP_SOURCE, /export function getOpenAgentTerminalButtonLabel\(/);
  assert.doesNotMatch(APP_SOURCE, /export function getOpenAgentTerminalButtonTitle\(/);
});

test("TopologyGraph 不再重复导出一行 return 的 helper 包装函数", () => {
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /export function getTopologyAgentStatusLabel\(/);
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /export function getTopologyEdgeTriggerAppearance\(/);
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /export function getTopologyNodeOrder\(/);
});

test("TopologyGraph helper 只保留在独立 helper 文件，不在页面组件内重复包一层", () => {
  assert.match(TOPOLOGY_GRAPH_HELPERS_SOURCE, /export function getTopologyAgentStatusLabel\(/);
  assert.match(TOPOLOGY_GRAPH_HELPERS_SOURCE, /export function getTopologyEdgeTriggerAppearance\(/);
  assert.match(TOPOLOGY_GRAPH_HELPERS_SOURCE, /export function getTopologyNodeOrder\(/);
});

test("不再保留 DEFAULT_BUILTIN_AGENT_TEMPLATES 内置模板常量", () => {
  assert.doesNotMatch(SHARED_TYPES_SOURCE, /DEFAULT_BUILTIN_AGENT_TEMPLATES/);
});

test("共享类型层不再暴露旧的 Agent 配置命名", () => {
  assert.doesNotMatch(SHARED_TYPES_SOURCE, new RegExp("Agent" + "FileRecord"));
  assert.doesNotMatch(SHARED_TYPES_SOURCE, new RegExp("\\bagent" + "Files\\b"));
});

test("共享类型层不再暴露 ProjectRecord / ProjectSnapshot", () => {
  assert.doesNotMatch(SHARED_TYPES_SOURCE, /export interface ProjectRecord/);
  assert.doesNotMatch(SHARED_TYPES_SOURCE, /export interface ProjectSnapshot/);
});

test("StoreService 不再使用全局 projects.json registry", () => {
  assert.doesNotMatch(STORE_SOURCE, /projects\.json/);
  assert.doesNotMatch(STORE_SOURCE, /listProjects\(/);
  assert.doesNotMatch(STORE_SOURCE, /insertProject\(/);
});

test("Orchestrator 不再保留 ensureProjectForPath / createProject / getProjectSnapshot", () => {
  assert.doesNotMatch(ORCHESTRATOR_SOURCE, /ensureProjectForPath\(/);
  assert.doesNotMatch(ORCHESTRATOR_SOURCE, /createProject\(/);
  assert.doesNotMatch(ORCHESTRATOR_SOURCE, /getProjectSnapshot\(/);
});
