import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const CLI_SOURCE = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("CLI 不再兼容旧的 review relation 别名", () => {
  assert.doesNotMatch(CLI_SOURCE, /relation === "review"/);
});

test("CLI 帮助包含 task run/task show/task chat/task attach 命令", () => {
  assert.match(CLI_SOURCE, /task run --file <topology-json> --message <message>/);
  assert.match(CLI_SOURCE, /task show <taskId>/);
  assert.match(CLI_SOURCE, /task chat --file <topology-json> --message <message>/);
  assert.match(CLI_SOURCE, /task attach <agentName>/);
  assert.doesNotMatch(CLI_SOURCE, /task run --task <taskId>/);
  assert.doesNotMatch(CLI_SOURCE, /attach <taskId> <agentName>/);
  assert.doesNotMatch(CLI_SOURCE, /task attach-agent <taskId> <agentName>/);
  assert.doesNotMatch(CLI_SOURCE, /dsl run --file <dsl-file>/);
  assert.doesNotMatch(CLI_SOURCE, /agent attach <agentName>/);
});

test("CLI 会话继续发送消息时支持 @agent 直发", () => {
  assert.match(CLI_SOURCE, /@某一个agent/);
  assert.match(CLI_SOURCE, /resolveTaskSubmissionTarget|submitTask/);
});

test("buildHelp 不再依赖额外的帮助包装模块", () => {
  assert.doesNotMatch(CLI_SOURCE, /buildCliHelpText/);
  assert.doesNotMatch(CLI_SOURCE, /from "\.\/help-text"/);
});

test("CLI 帮助不再包含 Zellij 相关描述", () => {
  assert.doesNotMatch(CLI_SOURCE, /Zellij/);
  assert.doesNotMatch(CLI_SOURCE, /zellij/);
});

test("task run 会打印日志文件路径、taskId 和 task show 提示", () => {
  assert.match(CLI_SOURCE, /renderTaskSessionSummary/);
  assert.match(CLI_SOURCE, /logFilePath: diagnostics\.logFilePath/);
  assert.match(CLI_SOURCE, /taskId,/);
  assert.match(CLI_SOURCE, /agentflow\.log/);
  assert.match(CLI_SOURCE, /task show/);
});

test("CLI 不再通过 ProjectSnapshot / ensureProjectForPath 驱动当前工作区", () => {
  assert.doesNotMatch(CLI_SOURCE, /ProjectSnapshot/);
  assert.doesNotMatch(CLI_SOURCE, /ensureProjectForPath/);
  assert.doesNotMatch(CLI_SOURCE, /getProjectSnapshot/);
});
