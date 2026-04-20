#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json";
import { buildCliAttachAgentCommand, buildCliOpencodeAttachCommand } from "@shared/terminal-commands";
import type { TaskSnapshot, WorkspaceSnapshot } from "@shared/types";
import { appendAppLog, initAppFileLogger } from "../runtime/app-log";
import { Orchestrator } from "../runtime/orchestrator";
import { resolveCliUserDataPath } from "../runtime/user-data-path";
import { compileTeamDsl, matchesAppliedTeamDsl } from "../runtime/team-dsl";
import { collectIncrementalChatTranscript, renderChatStreamEntries } from "./chat-stream-printer";
import {
  buildCliProgram,
  parseCliCommand,
  type ParsedCliCommand,
} from "./cli-command";
import { resolveCliDisposeOptions } from "./cli-dispose-policy";
import { ensureRuntimeAssets, isCompiledRuntime } from "./runtime-assets";
import { resolveCliTaskStreamingPlan } from "./task-streaming-policy";
import { renderTaskSessionSummary } from "./task-session-summary";
import {
  buildBrowserOpenSpec,
  buildUiHostLaunchSpec,
  buildUiUrl,
} from "./ui-host-launch";
import {
  deleteUiHostState,
  isUiHostStateReusable,
  readUiHostState,
  writeUiHostState,
  type UiHostStateRecord,
} from "./ui-host-state";
import { startWebHost } from "./web-host";

const CLI_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_UI_PORT = 4310;
const HEALTHCHECK_TIMEOUT_MS = 10_000;

interface CliContext {
  orchestrator: Orchestrator;
  userDataPath: string;
}

interface TaskRunDiagnostics {
  logFilePath: string;
}

interface InternalWebHostCommand {
  taskId: string;
  port: number;
}

function fail(message: string): never {
  throw new Error(message);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildTaskRunDiagnostics(userDataPath: string): TaskRunDiagnostics {
  return {
    logFilePath: path.join(userDataPath, "logs", "agent-team.log"),
  };
}

function printTaskRunDiagnostics(diagnostics: TaskRunDiagnostics, taskId: string) {
  process.stdout.write(`${renderTaskSessionSummary({
    logFilePath: diagnostics.logFilePath,
    taskId,
  })}\n\n`);
}

function isSettledTaskStatus(status: TaskSnapshot["task"]["status"]) {
  return status === "waiting" || status === "finished" || status === "failed";
}

async function createCliContext(options?: {
  enableEventStream?: boolean;
}): Promise<CliContext> {
  const userDataPath = resolveCliUserDataPath();
  initAppFileLogger(userDataPath);
  await ensureRuntimeAssets(userDataPath);
  const orchestrator = new Orchestrator({
    userDataPath,
    autoOpenTaskSession: false,
    enableEventStream: options?.enableEventStream ?? false,
  });
  await orchestrator.initialize();
  return {
    orchestrator,
    userDataPath,
  };
}

async function resolveProject(
  context: CliContext,
  cwd?: string,
): Promise<WorkspaceSnapshot> {
  return context.orchestrator.getWorkspaceSnapshot(path.resolve(cwd || process.cwd()));
}

async function resolveTaskProject(
  context: CliContext,
  taskId: string,
): Promise<WorkspaceSnapshot> {
  const task = await context.orchestrator.getTaskSnapshot(taskId);
  return context.orchestrator.getWorkspaceSnapshot(task.task.cwd);
}

function findTaskOrThrow(workspace: WorkspaceSnapshot, taskId: string): TaskSnapshot {
  const matched = workspace.tasks.find((task) => task.task.id === taskId);
  if (!matched) {
    fail(`未找到 Task：${taskId}`);
  }
  return matched;
}

function findLatestTaskOrThrow(workspace: WorkspaceSnapshot): TaskSnapshot {
  const latest = workspace.tasks[0];
  if (!latest) {
    fail(`当前工作目录 ${workspace.cwd} 还没有可 attach 的 Task。`);
  }
  return latest;
}

async function loadTeamDslDefinition(file: string) {
  const resolved = path.resolve(file);
  if (path.extname(resolved).toLowerCase() !== ".json") {
    throw new Error(`团队拓扑文件必须是 JSON：${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

async function ensureJsonTopologyApplied(
  context: CliContext,
  workspace: WorkspaceSnapshot,
  file: string,
): Promise<WorkspaceSnapshot> {
  const definition = await loadTeamDslDefinition(file);
  const compiled = compileTeamDsl(definition);
  if (matchesAppliedTeamDsl(workspace.agents, workspace.topology, compiled)) {
    return workspace;
  }
  return context.orchestrator.applyTeamDsl({
    cwd: workspace.cwd,
    compiled,
  });
}

function validateTaskHeadlessCommand(
  command: Extract<ParsedCliCommand, { kind: "task.headless" }>,
) {
  const hasFile = Boolean(command.file?.trim());
  const hasMessage = Boolean(command.message?.trim());
  if (!hasFile) {
    fail("新建 Task 时必须传 --file <topology.json>。");
  }
  if (!hasMessage) {
    fail("新建 Task 时必须传 --message <message>。");
  }
}

function validateTaskUiCommand(
  command: Extract<ParsedCliCommand, { kind: "task.ui" }>,
) {
  const hasTaskId = Boolean(command.taskId?.trim());
  const hasFile = Boolean(command.file?.trim());
  const hasMessage = Boolean(command.message?.trim());

  if (hasTaskId) {
    if (hasFile || hasMessage) {
      fail("恢复已有 Task 打开网页界面时，不允许再传 --file 或 --message。");
    }
    return;
  }

  if (!hasFile) {
    fail("新建 Task 打开网页界面时必须传 --file <topology.json>。");
  }
  if (!hasMessage) {
    fail("新建 Task 打开网页界面时必须传 --message <message>。");
  }
}

function printTaskAttachCommands(task: TaskSnapshot, cwd?: string) {
  process.stdout.write("\nattach:\n");
  const attachCommandOptions = isCompiledRuntime()
    ? {
        mode: "compiled" as const,
        executablePath: process.execPath,
        platform: process.platform,
      }
    : {
        mode: "source" as const,
        platform: process.platform,
      };
  for (const agent of task.agents) {
    process.stdout.write(
      `- ${agent.name} | attach: ${buildCliAttachAgentCommand(agent.name, cwd, attachCommandOptions)}\n`,
    );
  }
  process.stdout.write("\n");
}

async function buildAttachCommand(
  context: CliContext,
  projectPath: string,
  cwd: string,
  opencodeSessionId: string,
) {
  const attachBaseUrl = await (context.orchestrator as Orchestrator & {
    opencodeClient: { getAttachBaseUrl: (projectPath: string) => Promise<string> };
  }).opencodeClient.getAttachBaseUrl(projectPath);
  return buildCliOpencodeAttachCommand(attachBaseUrl, opencodeSessionId, cwd);
}

async function runAttachCommand(command: string, cwd: string) {
  await new Promise<void>((resolve, reject) => {
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
    const child = spawn(shell, args, {
      cwd,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`attach 被信号中断：${signal}`));
        return;
      }
      if ((code ?? 0) !== 0) {
        reject(new Error(`attach 退出码异常：${code ?? 0}`));
        return;
      }
      resolve();
    });
  });
}

async function renderTaskMessages(
  context: CliContext,
  taskId: string,
  previousMessages: TaskSnapshot["messages"],
  options?: {
    includeHistory?: boolean;
    printAttach?: boolean;
  },
) {
  let lastMessages = previousMessages;
  let attachPrinted = options?.printAttach !== true;
  let includeHistory = options?.includeHistory === true;

  while (true) {
    const snapshot = await context.orchestrator.getTaskSnapshot(taskId);

    if (!attachPrinted) {
      printTaskAttachCommands(snapshot, snapshot.task.cwd);
      attachPrinted = true;
    }

    const entries = includeHistory
      ? collectIncrementalChatTranscript([], snapshot.messages)
      : collectIncrementalChatTranscript(lastMessages, snapshot.messages);

    if (entries.length > 0) {
      process.stdout.write(renderChatStreamEntries(entries));
      lastMessages = snapshot.messages;
      includeHistory = false;
    }

    if (isSettledTaskStatus(snapshot.task.status)) {
      return {
        snapshot,
        messages: lastMessages,
      };
    }

    await sleep(800);
  }
}

async function buildWebAssetsFromSource() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(npmCommand, ["run", "build:web"], {
      cwd: CLI_REPO_ROOT,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`build:web 被信号中断：${signal}`));
        return;
      }
      if ((code ?? 0) !== 0) {
        reject(new Error(`build:web 退出码异常：${code ?? 0}`));
        return;
      }
      resolve();
    });
  });
}

async function reservePort(
  host: string,
  port: number,
): Promise<{ port: number; close: () => Promise<void> } | null> {
  return new Promise((resolve) => {
    const server = net.createServer();
    const close = async () => {
      await new Promise<void>((closeResolve) => {
        server.close(() => closeResolve());
      });
    };
    server.once("error", () => resolve(null));
    server.listen(port, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        void close().then(() => resolve(null));
        return;
      }
      resolve({
        port: address.port,
        close,
      });
    });
  });
}

async function resolveUiPort() {
  const preferred = await reservePort("127.0.0.1", DEFAULT_UI_PORT);
  if (preferred) {
    const port = preferred.port;
    await preferred.close();
    return port;
  }
  const fallback = await reservePort("127.0.0.1", 0);
  if (!fallback) {
    fail("无法为网页界面分配可用端口。");
  }
  const port = fallback.port;
  await fallback.close();
  return port;
}

async function isUiHostAlive(record: UiHostStateRecord): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/healthz`);
    if (!response.ok) {
      return false;
    }
    const payload = await response.json() as { taskId?: string };
    return payload.taskId === record.taskId;
  } catch {
    return false;
  }
}

async function waitForUiHost(port: number, taskId: string) {
  const startTime = Date.now();
  while (Date.now() - startTime < HEALTHCHECK_TIMEOUT_MS) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) {
        const payload = await response.json() as { taskId?: string };
        if (payload.taskId === taskId) {
          return;
        }
      }
    } catch {
      // ignore and retry
    }
    await sleep(200);
  }
  fail(`后台网页服务启动超时：${taskId}`);
}

async function openBrowser(url: string) {
  const spec = buildBrowserOpenSpec({ url });
  const child = spawn(spec.command, spec.args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function ensureWebRoot(userDataPath: string): Promise<string> {
  let assets = await ensureRuntimeAssets(userDataPath);
  if (assets.webRoot) {
    return assets.webRoot;
  }

  if (!isCompiledRuntime()) {
    await buildWebAssetsFromSource();
    assets = await ensureRuntimeAssets(userDataPath);
    if (assets.webRoot) {
      return assets.webRoot;
    }
  }

  fail("网页资源不可用，无法启动浏览器 UI。");
}

async function ensureUiHost(
  context: CliContext,
  cwd: string,
  taskId: string,
): Promise<{ port: number; url: string }> {
  await ensureWebRoot(context.userDataPath);
  const state = readUiHostState(cwd);
  if (
    state
    && isUiHostStateReusable(state, {
      cwd,
      taskId,
      version: packageJson.version,
    })
    && await isUiHostAlive(state)
  ) {
    return {
      port: state.port,
      url: buildUiUrl({
        port: state.port,
        taskId,
      }),
    };
  }

  if (state) {
    deleteUiHostState(cwd);
  }

  const port = await resolveUiPort();
  const spec = isCompiledRuntime()
    ? buildUiHostLaunchSpec({
        mode: "compiled",
        executablePath: process.execPath,
        taskId,
        port,
      })
    : buildUiHostLaunchSpec({
        mode: "source",
        nodeBinary: process.execPath,
        repoRoot: CLI_REPO_ROOT,
        taskId,
        port,
      });
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: {
      ...process.env,
      AGENT_TEAM_WEB_ROOT: process.env.AGENT_TEAM_WEB_ROOT,
    },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  await waitForUiHost(port, taskId);
  writeUiHostState(cwd, {
    pid: child.pid ?? 0,
    port,
    cwd,
    taskId,
    startedAt: new Date().toISOString(),
    version: packageJson.version,
  });
  return {
    port,
    url: buildUiUrl({
      port,
      taskId,
    }),
  };
}

function parseInternalWebHostCommand(argv: string[]): InternalWebHostCommand | null {
  if (argv[0] !== "internal" || argv[1] !== "web-host") {
    return null;
  }

  const readFlag = (flag: string) => {
    const index = argv.findIndex((value) => value === flag);
    if (index < 0) {
      return null;
    }
    return argv[index + 1] ?? null;
  };

  const taskId = readFlag("--task-id");
  const port = Number(readFlag("--port"));
  if (!taskId || !Number.isFinite(port)) {
    fail("internal web-host 缺少必要参数。");
  }

  return {
    taskId,
    port,
  };
}

async function runInternalWebHost(command: InternalWebHostCommand) {
  const context = await createCliContext({
    enableEventStream: true,
  });
  const assets = await ensureRuntimeAssets(context.userDataPath);
  const webRoot = assets.webRoot ?? process.env.AGENT_TEAM_WEB_ROOT ?? null;
  if (!webRoot) {
    fail("网页资源不可用，无法启动内部 web-host。");
  }

  const task = await context.orchestrator.getTaskSnapshot(command.taskId);
  const cwd = path.resolve(task.task.cwd);

  writeUiHostState(cwd, {
    pid: process.pid,
    port: command.port,
    cwd,
    taskId: command.taskId,
    startedAt: new Date().toISOString(),
    version: packageJson.version,
  });

  const host = await startWebHost({
    orchestrator: context.orchestrator,
    cwd,
    taskId: command.taskId,
    port: command.port,
    webRoot,
  });

  const shutdown = async () => {
    deleteUiHostState(command.cwd);
    await host.close().catch(() => undefined);
    await context.orchestrator.dispose({
      awaitPendingTaskRuns: false,
    }).catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

async function handleTaskHeadlessCommand(
  context: CliContext,
  command: Extract<ParsedCliCommand, { kind: "task.headless" }>,
) {
  validateTaskHeadlessCommand(command);
  const diagnostics = buildTaskRunDiagnostics(context.userDataPath);
  let workspace = await resolveProject(context, command.cwd);
  workspace = await ensureJsonTopologyApplied(context, workspace, command.file!);
  const initialMessage = command.message!.trim();

  const snapshot = await context.orchestrator.submitTask({
    cwd: workspace.cwd,
    taskId: null,
    content: initialMessage,
  });
  printTaskRunDiagnostics(diagnostics, snapshot.task.id);

  const streamingPlan = resolveCliTaskStreamingPlan({
    commandKind: command.kind,
    isResume: false,
  });
  if (!streamingPlan.enabled) {
    return;
  }

  await renderTaskMessages(context, snapshot.task.id, [], {
    includeHistory: streamingPlan.includeHistory,
    printAttach: streamingPlan.printAttach,
  });
}

async function handleTaskUiCommand(
  context: CliContext,
  command: Extract<ParsedCliCommand, { kind: "task.ui" }>,
) {
  validateTaskUiCommand(command);
  const diagnostics = buildTaskRunDiagnostics(context.userDataPath);
  const streamingPlan = resolveCliTaskStreamingPlan({
    commandKind: command.kind,
    isResume: Boolean(command.taskId),
  });

  if (command.taskId) {
    const workspace = await resolveTaskProject(context, command.taskId);
    const task = findTaskOrThrow(workspace, command.taskId);
    const { url } = await ensureUiHost(context, task.task.cwd, task.task.id);
    printTaskRunDiagnostics(diagnostics, task.task.id);
    process.stdout.write(`[UI] ${url}\n`);
    await openBrowser(url);
    if (streamingPlan.enabled) {
      await renderTaskMessages(context, task.task.id, task.messages, {
        includeHistory: streamingPlan.includeHistory,
        printAttach: streamingPlan.printAttach,
      });
    }
    return;
  }

  let workspace = await resolveProject(context);
  workspace = await ensureJsonTopologyApplied(context, workspace, command.file!);
  const snapshot = await context.orchestrator.submitTask({
    cwd: workspace.cwd,
    taskId: null,
    content: command.message!.trim(),
  });
  const { url } = await ensureUiHost(context, snapshot.task.cwd, snapshot.task.id);
  printTaskRunDiagnostics(diagnostics, snapshot.task.id);
  process.stdout.write(`[UI] ${url}\n`);
  await openBrowser(url);
  if (streamingPlan.enabled) {
    await renderTaskMessages(context, snapshot.task.id, [], {
      includeHistory: streamingPlan.includeHistory,
      printAttach: streamingPlan.printAttach,
    });
  }
}

async function handleTaskAttachCommand(
  context: CliContext,
  command: Extract<ParsedCliCommand, { kind: "task.attach" }>,
) {
  const workspace = await resolveProject(context, command.cwd);
  const task = findLatestTaskOrThrow(workspace);
  const agent = task.agents.find((item) => item.name === command.agentName);
  if (!agent) {
    fail(`未找到 Agent：${command.agentName}`);
  }
  if (!agent.opencodeSessionId) {
    fail(`Agent ${command.agentName} 当前还没有可 attach 的 OpenCode session。`);
  }

  const attachCommand = await buildAttachCommand(
    context,
    workspace.cwd,
    task.task.cwd,
    agent.opencodeSessionId,
  );

  if (command.printOnly) {
    process.stdout.write(`${attachCommand}\n`);
    return;
  }

  await runAttachCommand(attachCommand, task.task.cwd);
}

function buildHelp() {
  const commanderHelp = buildCliProgram().helpInformation().trimEnd();
  const appendix = [
    "",
    "补充命令示例：",
    "  task headless --file <topology-json> --message <message> [--cwd <path>]",
    "  task ui --file <topology-json> --message <message>",
    "  task ui <taskId>",
    "  task attach <agentName> [--cwd <path>] [--print-only]",
    "",
    "说明：",
    "  - `task headless` 只负责新建任务，运行到本轮任务结束后退出 CLI。",
    "  - `task ui` 会通过 internal web-host 启动后台网页服务，并打开浏览器。",
    "  - 新建任务时必须传 `--file` 和 `--message`。",
    "  - `task attach <agentName>` 会 attach 到当前工作目录最新 task 的对应 Agent。",
  ].join("\n");
  return `${commanderHelp}\n${appendix}`;
}

async function run() {
  const internalWebHostCommand = parseInternalWebHostCommand(process.argv.slice(2));
  if (internalWebHostCommand) {
    await runInternalWebHost(internalWebHostCommand);
    return;
  }

  const command = parseCliCommand(process.argv.slice(2));
  if (command.kind === "help") {
    process.stdout.write(`${buildHelp()}\n`);
    return;
  }

  const context = await createCliContext();
  let observedSettledTaskState = false;
  let forceProcessExit = false;
  try {
    if (command.kind === "task.headless") {
      await handleTaskHeadlessCommand(context, command);
      observedSettledTaskState = true;
    } else if (command.kind === "task.ui") {
      await handleTaskUiCommand(context, command);
      observedSettledTaskState = true;
    } else if (command.kind === "task.attach") {
      await handleTaskAttachCommand(context, command);
    }
  } finally {
    const disposeOptions = resolveCliDisposeOptions({
      commandKind: command.kind,
      observedSettledTaskState,
    });
    forceProcessExit = disposeOptions.forceProcessExit;
    await context.orchestrator.dispose(disposeOptions);
  }

  if (forceProcessExit) {
    process.exit(0);
  }
}

void run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  appendAppLog("error", "cli.run_failed", {
    cwd: process.cwd(),
    message,
  });
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
