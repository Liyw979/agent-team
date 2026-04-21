import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const CLI_SOURCE = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const REMOVED_TERMINAL_HOST = String.fromCharCode(122, 101, 108, 108, 105, 106);

test("CLI 不再兼容旧的 review relation 别名", () => {
  assert.doesNotMatch(CLI_SOURCE, /relation === "review"/);
});

test("CLI 帮助只包含 task headless/task ui 命令", () => {
  assert.match(CLI_SOURCE, /task headless --file <topology-json> --message <message>/);
  assert.match(CLI_SOURCE, /task ui --file <topology-json> --message <message> \[--cwd <path>\]/);
  assert.doesNotMatch(CLI_SOURCE, /task ui <taskId> \[--cwd <path>\]/);
  assert.doesNotMatch(CLI_SOURCE, /task attach <taskId> <agentName>/);
  assert.doesNotMatch(CLI_SOURCE, /task show <taskId>/);
  assert.doesNotMatch(CLI_SOURCE, /task chat --file <topology-json> --message <message>/);
  assert.doesNotMatch(CLI_SOURCE, /task chat --task <taskId>/);
  assert.doesNotMatch(CLI_SOURCE, /task run --file <topology-json> --message <message>/);
  assert.doesNotMatch(CLI_SOURCE, /--ui/);
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
  assert.match(CLI_SOURCE, /agent-team\.log/);
  assert.doesNotMatch(CLI_SOURCE, /task show/);
});

test("CLI 不再通过 ProjectSnapshot / ensureProjectForPath 驱动当前工作区", () => {
  assert.doesNotMatch(CLI_SOURCE, /ProjectSnapshot/);
  assert.doesNotMatch(CLI_SOURCE, /ensureProjectForPath/);
  assert.doesNotMatch(CLI_SOURCE, /getProjectSnapshot/);
});

test("CLI 会在当前进程里直接启动 web-host 并打开浏览器 UI", () => {
  assert.match(CLI_SOURCE, /startWebHost/);
  assert.match(CLI_SOURCE, /openBrowser/);
  assert.doesNotMatch(CLI_SOURCE, /internal web-host/);
  assert.doesNotMatch(CLI_SOURCE, /buildUiHostLaunchSpec/);
});

test("task ui 不会在用户入口里触发 build:web 编译", () => {
  assert.doesNotMatch(CLI_SOURCE, /npmCommand/);
  assert.doesNotMatch(CLI_SOURCE, /build:web/);
});

test("task ui 在任务结束后会继续驻留，等待 Ctrl\\+C 再清理", () => {
  assert.match(CLI_SOURCE, /keepAliveUntilSignal/);
  assert.match(CLI_SOURCE, /await new Promise<void>\(\(\) => undefined\)/);
  assert.match(CLI_SOURCE, /shouldDisposeContext/);
});

test("task ui 与 task headless 都会把 command.cwd 传入工作区解析链路", () => {
  assert.match(CLI_SOURCE, /resolveProject\(context, command\.cwd\)/);
  assert.doesNotMatch(CLI_SOURCE, /resolveTaskProject\(context, command\.taskId, command\.cwd\)/);
});

test("CLI attach 列表只展示 opencode attach 命令", () => {
  assert.match(CLI_SOURCE, /renderTaskAttachCommands/);
  assert.match(CLI_SOURCE, /buildCliOpencodeAttachCommand/);
  assert.doesNotMatch(CLI_SOURCE, /buildCliAttachAgentCommand/);
  assert.doesNotMatch(CLI_SOURCE, /resolveTaskAgentAttachBaseUrl/);
});

test("CLI 不再依赖 ui-host 状态文件复用后台服务", () => {
  assert.doesNotMatch(CLI_SOURCE, /readUiHostState/);
  assert.doesNotMatch(CLI_SOURCE, /writeUiHostState/);
  assert.doesNotMatch(CLI_SOURCE, /deleteUiHostState/);
});

test("CLI 退出时会输出被清理的 OpenCode 实例 PID", () => {
  assert.match(CLI_SOURCE, /renderOpenCodeCleanupReport/);
  assert.match(CLI_SOURCE, /process\.stdout\.write\(output\)/);
  assert.match(CLI_SOURCE, /const report = await context\.orchestrator\.dispose\(options\)/);
});
