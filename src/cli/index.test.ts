import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const CLI_SOURCE = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const NORMALIZED_CLI_SOURCE = CLI_SOURCE.replace(/\r\n/g, "\n");
const REMOVED_TERMINAL_HOST = String.fromCharCode(122, 101, 108, 108, 105, 106);

function isUiAssetPreflightBeforeTaskSubmit(source: string): boolean {
  const preflightIndex = source.indexOf("await ensureUiAssetsAvailable(context.userDataPath)");
  const submitIndex = source.indexOf("const snapshot = await context.orchestrator.submitTask(");
  return preflightIndex !== -1 && submitIndex !== -1 && preflightIndex < submitIndex;
}

function getTaskUiSection(source: string): string {
  const startIndex = source.indexOf("async function handleTaskUiCommand(");
  const endIndex = source.indexOf("function buildHelp()", startIndex);
  assert.notEqual(startIndex, -1);
  assert.notEqual(endIndex, -1);
  return source.slice(startIndex, endIndex);
}

function appearsInOrder(source: string, before: string, after: string): boolean {
  const beforeIndex = source.indexOf(before);
  const afterIndex = source.indexOf(after);
  return beforeIndex !== -1 && afterIndex !== -1 && beforeIndex < afterIndex;
}

test("CLI no longer accepts the removed review shortcut", () => {
  assert.doesNotMatch(CLI_SOURCE, /relation === "review"/);
});

test("CLI help only includes task headless and task ui commands", () => {
  assert.match(CLI_SOURCE, /task headless --file <topology-json> --message <message> \[--cwd <path>\] \[--show-message\]/);
  assert.match(CLI_SOURCE, /task ui --file <topology-json> --message <message> \[--cwd <path>\]/);
  assert.doesNotMatch(CLI_SOURCE, /task ui <taskId> \[--cwd <path>\]/);
  assert.doesNotMatch(CLI_SOURCE, /task attach <taskId> <agentId>/);
  assert.doesNotMatch(CLI_SOURCE, /task show <taskId>/);
  assert.doesNotMatch(CLI_SOURCE, /task chat --file <topology-json> --message <message>/);
  assert.doesNotMatch(CLI_SOURCE, /task chat --task <taskId>/);
  assert.doesNotMatch(CLI_SOURCE, /task run --file <topology-json> --message <message>/);
  assert.doesNotMatch(CLI_SOURCE, /--ui/);
  assert.doesNotMatch(CLI_SOURCE, /task attach-agent <taskId> <agentId>/);
  assert.doesNotMatch(CLI_SOURCE, /dsl run --file <dsl-file>/);
  assert.doesNotMatch(CLI_SOURCE, /agent attach <agentId>/);
});

test("CLI no longer keeps the interactive task chat entrypoint", () => {
  assert.doesNotMatch(CLI_SOURCE, /宸茶繘鍏ヤ細璇?/);
  assert.doesNotMatch(CLI_SOURCE, /@鏌愪竴涓猘gent/);
  assert.doesNotMatch(CLI_SOURCE, /runInteractiveSession/);
});

test("buildHelp does not depend on the legacy help wrapper", () => {
  assert.doesNotMatch(CLI_SOURCE, /buildCliHelpText/);
  assert.doesNotMatch(CLI_SOURCE, /from "\.\/help-text"/);
});

test("CLI help no longer contains the removed terminal host wording", () => {
  assert.doesNotMatch(CLI_SOURCE, new RegExp(REMOVED_TERMINAL_HOST, "i"));
});

test("task headless prints the log file path through renderTaskSessionSummary", () => {
  assert.match(CLI_SOURCE, /renderTaskSessionSummary/);
  assert.match(CLI_SOURCE, /logFilePath: diagnostics\.logFilePath/);
  assert.match(CLI_SOURCE, /\.\.\.\(taskUrl \? \{ taskUrl \} : \{\}\)/);
  assert.match(CLI_SOURCE, /buildTaskLogFilePath/);
  assert.match(CLI_SOURCE, /buildTaskLogFilePath\(userDataPath, taskId\)/);
  assert.doesNotMatch(CLI_SOURCE, /agent-team\.log/);
  assert.doesNotMatch(CLI_SOURCE, /task show/);
});

test("task headless 默认保留 attach、隐藏消息记录，并继续传递输出开关", () => {
  assert.match(CLI_SOURCE, /printAttach: streamingPlan\.printAttach,/);
  assert.match(CLI_SOURCE, /printMessages: streamingPlan\.printMessages,/);
  assert.match(CLI_SOURCE, /const printMessages = options\?\.printMessages !== false;/);
  assert.match(CLI_SOURCE, /默认打印诊断信息与 attach 调试命令；传 `--show-message` 后再额外展示完整消息记录。/);
});

test("CLI no longer depends on ProjectSnapshot or ensureProjectForPath", () => {
  assert.doesNotMatch(CLI_SOURCE, /ProjectSnapshot/);
  assert.doesNotMatch(CLI_SOURCE, /ensureProjectForPath/);
  assert.doesNotMatch(CLI_SOURCE, /getProjectSnapshot/);
});

test("CLI starts the web host in-process and opens the browser directly", () => {
  assert.match(CLI_SOURCE, /startWebHost/);
  assert.match(CLI_SOURCE, /import open from "open";/);
  assert.match(CLI_SOURCE, /await open\(url\);/);
  assert.doesNotMatch(CLI_SOURCE, /async function openBrowser\(/);
  assert.doesNotMatch(CLI_SOURCE, /internal web-host/);
  assert.doesNotMatch(CLI_SOURCE, /buildUiHostLaunchSpec/);
});

test("task ui prints diagnostics before starting the web host", () => {
  const taskUiSection = getTaskUiSection(NORMALIZED_CLI_SOURCE);

  assert.equal(
    appearsInOrder(
      taskUiSection,
      "printTaskRunDiagnostics(diagnostics, previewUrl);",
      "const { host, url } = await ensureUiHost(",
    ),
    true,
  );
});

test("task ui diagnostics reuse the final browser url and do not print a separate UI line", () => {
  assert.match(CLI_SOURCE, /const previewUrl = buildUiUrl\(/);
  assert.match(CLI_SOURCE, /printTaskRunDiagnostics\(diagnostics, previewUrl\);/);
  assert.doesNotMatch(CLI_SOURCE, /process\.stdout\.write\(`\[UI\] \$\{url\}\\n`\)/);
});

test("task commands preallocate a task id before creating the CLI context", () => {
  assert.equal(
    appearsInOrder(
      NORMALIZED_CLI_SOURCE,
      "activeTaskDiagnostics = buildTaskRunDiagnostics(userDataPath, randomUUID());",
      "const context = await createCliContext(",
    ),
    true,
  );
  assert.match(NORMALIZED_CLI_SOURCE, /activeTaskDiagnosticsForCrash = activeTaskDiagnostics;/);
  assert.match(
    NORMALIZED_CLI_SOURCE,
    /appendAppLog\([\s\S]*activeTaskDiagnosticsForCrash \? \{ taskId: activeTaskDiagnosticsForCrash\.taskId \} : undefined/,
  );
});

test("task ui checks static UI assets before submitting the task", () => {
  const taskUiSection = getTaskUiSection(NORMALIZED_CLI_SOURCE);

  assert.equal(isUiAssetPreflightBeforeTaskSubmit(taskUiSection), true);
});

test("task ui does not trigger build:web from the user entrypoint", () => {
  assert.doesNotMatch(CLI_SOURCE, /npmCommand/);
  assert.doesNotMatch(CLI_SOURCE, /build:web/);
});

test("task ui stays alive after the task ends and waits for Ctrl+C", () => {
  assert.match(CLI_SOURCE, /keepAliveUntilSignal/);
  assert.match(CLI_SOURCE, /await new Promise<void>\(\(\) => undefined\)/);
  assert.match(CLI_SOURCE, /shouldDisposeContext/);
});

test("task ui and task headless both pass command.cwd into project resolution", () => {
  assert.match(CLI_SOURCE, /resolveProject\(context, command\.cwd\)/);
  assert.doesNotMatch(CLI_SOURCE, /resolveTaskProject\(context, command\.taskId, command\.cwd\)/);
});

test("CLI attach output only shows opencode attach commands", () => {
  assert.match(CLI_SOURCE, /renderTaskAttachCommands/);
  assert.match(CLI_SOURCE, /collectNewTaskAttachCommandEntries/);
  assert.match(CLI_SOURCE, /buildCliOpencodeAttachCommand/);
  assert.doesNotMatch(CLI_SOURCE, /buildCliAttachAgentCommand/);
  assert.doesNotMatch(CLI_SOURCE, /resolveTaskAgentAttachBaseUrl/);
});

test("CLI no longer depends on ui-host state files", () => {
  assert.doesNotMatch(CLI_SOURCE, /readUiHostState/);
  assert.doesNotMatch(CLI_SOURCE, /writeUiHostState/);
  assert.doesNotMatch(CLI_SOURCE, /deleteUiHostState/);
});

test("CLI exit prints the cleaned up OpenCode instance PIDs", () => {
  assert.match(CLI_SOURCE, /renderOpenCodeCleanupReport/);
  assert.match(CLI_SOURCE, /process\.stdout\.write\(output\)/);
  assert.match(CLI_SOURCE, /const report = await context\.orchestrator\.dispose\(options\)/);
});
