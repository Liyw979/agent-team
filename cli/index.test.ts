import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const CLI_SOURCE = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const REMOVED_TERMINAL_HOST = String.fromCharCode(122, 101, 108, 108, 105, 106);

test("CLI 不再兼容旧的 review relation 别名", () => {
  assert.doesNotMatch(CLI_SOURCE, /relation === "review"/);
});

test("CLI 帮助包含 task headless/task ui/task attach 命令", () => {
  assert.match(CLI_SOURCE, /task headless --file <topology-json> --message <message>/);
  assert.match(CLI_SOURCE, /task ui --file <topology-json> --message <message>/);
  assert.match(CLI_SOURCE, /task ui --task <taskId>/);
  assert.match(CLI_SOURCE, /task attach <agentName>/);
  assert.doesNotMatch(CLI_SOURCE, /task show <taskId>/);
  assert.doesNotMatch(CLI_SOURCE, /task chat --file <topology-json> --message <message>/);
  assert.doesNotMatch(CLI_SOURCE, /task chat --task <taskId>/);
  assert.doesNotMatch(CLI_SOURCE, /task run --file <topology-json> --message <message>/);
  assert.doesNotMatch(CLI_SOURCE, /--ui/);
  assert.doesNotMatch(CLI_SOURCE, /attach <taskId> <agentName>/);
  assert.doesNotMatch(CLI_SOURCE, /task attach-agent <taskId> <agentName>/);
  assert.doesNotMatch(CLI_SOURCE, /dsl run --file <dsl-file>/);
  assert.doesNotMatch(CLI_SOURCE, /agent attach <agentName>/);
});

test("CLI 不再保留交互式 task chat 会话入口", () => {
  assert.doesNotMatch(CLI_SOURCE, /已进入会话/);
  assert.doesNotMatch(CLI_SOURCE, /@某一个agent/);
  assert.doesNotMatch(CLI_SOURCE, /runInteractiveSession/);
});

test("buildHelp 不再依赖额外的帮助包装模块", () => {
  assert.doesNotMatch(CLI_SOURCE, /buildCliHelpText/);
  assert.doesNotMatch(CLI_SOURCE, /from "\.\/help-text"/);
});

test("CLI 帮助不再包含旧终端宿主相关描述", () => {
  assert.doesNotMatch(CLI_SOURCE, new RegExp(REMOVED_TERMINAL_HOST, "i"));
});

test("task headless 会打印日志文件路径和 taskId", () => {
  assert.match(CLI_SOURCE, /renderTaskSessionSummary/);
  assert.match(CLI_SOURCE, /logFilePath: diagnostics\.logFilePath/);
  assert.match(CLI_SOURCE, /taskId,/);
  assert.match(CLI_SOURCE, /agentflow\.log/);
  assert.doesNotMatch(CLI_SOURCE, /task show/);
});

test("CLI 不再通过 ProjectSnapshot / ensureProjectForPath 驱动当前工作区", () => {
  assert.doesNotMatch(CLI_SOURCE, /ProjectSnapshot/);
  assert.doesNotMatch(CLI_SOURCE, /ensureProjectForPath/);
  assert.doesNotMatch(CLI_SOURCE, /getProjectSnapshot/);
});

test("CLI 会通过内部 web-host 模式拉起浏览器 UI", () => {
  assert.match(CLI_SOURCE, /internal web-host/);
  assert.match(CLI_SOURCE, /openBrowser/);
  assert.doesNotMatch(CLI_SOURCE, /spawnUi\(/);
});
