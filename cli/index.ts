#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { buildCliOpencodeAttachCommand } from "@shared/terminal-commands";
import type { TaskSnapshot, WorkspaceSnapshot } from "@shared/types";
import open from "open";
import { appendAppLog, buildTaskLogFilePath, initAppFileLogger } from "../runtime/app-log";
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
import { resolveCliSignalPlan } from "./cli-signal-policy";
import { ensureRuntimeAssets, isCompiledRuntime } from "./runtime-assets";
import { resolveCliTaskStreamingPlan } from "./task-streaming-policy";
import { renderTaskSessionSummary } from "./task-session-summary";
import { renderTaskAttachCommands } from "./task-attach-display";
import { renderOpenCodeCleanupReport } from "./opencode-cleanup-report";
import { buildUiUrl, UI_LOOPBACK_HOST } from "./ui-host-launch";
import { startWebHost } from "./web-host";
import { resolveWorkspaceCwdFromFilesystem } from "./workspace-cwd";

const DEFAULT_UI_PORT = 4310;

interface CliContext {
  orchestrator: Orchestrator;
  userDataPath: string;
}

interface TaskRunDiagnostics {
  taskId: string;
  logFilePath: string;
}

interface CliDisposeOptions {
  awaitPendingTaskRuns: boolean;
}

interface ActiveUiHost {
  close: () => Promise<void>;
}

let activeTaskDiagnosticsForCrash: TaskRunDiagnostics | null = null;
let didPrintTaskDiagnosticsForCrash = false;

function fail(message: string): never {
  throw new Error(message);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildTaskRunDiagnostics(userDataPath: string, taskId: string): TaskRunDiagnostics {
  return {
    taskId,
    logFilePath: buildTaskLogFilePath(userDataPath, taskId),
  };
}

function printTaskRunDiagnostics(diagnostics: TaskRunDiagnostics, taskUrl?: string | null) {
  process.stdout.write(`${renderTaskSessionSummary({
    logFilePath: diagnostics.logFilePath,
    taskUrl,
  })}\n\n`);
}

function isSettledTaskStatus(status: TaskSnapshot["task"]["status"]) {
  return status === "waiting" || status === "finished" || status === "failed";
}

async function disposeCliContext(context: CliContext, options: CliDisposeOptions) {
  const report = await context.orchestrator.dispose(options);
  const output = renderOpenCodeCleanupReport(report);
  if (output) {
    process.stdout.write(output);
  }
  return report;
}

async function createCliContext(options?: {
  userDataPath?: string;
  enableEventStream?: boolean;
}): Promise<CliContext> {
  const userDataPath = options?.userDataPath ?? resolveCliUserDataPath();
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
  return context.orchestrator.getWorkspaceSnapshot(
    resolveWorkspaceCwdFromFilesystem(cwd, process.cwd()),
  );
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
  const hasFile = Boolean(command.file?.trim());
  const hasMessage = Boolean(command.message?.trim());

  if (!hasFile) {
    fail("新建 Task 打开网页界面时必须传 --file <topology.json>。");
  }
  if (!hasMessage) {
    fail("新建 Task 打开网页界面时必须传 --message <message>。");
  }
}

async function printTaskAttachCommands(context: CliContext, task: TaskSnapshot) {
  process.stdout.write(
    renderTaskAttachCommands(
      task.agents.map((agent) => ({
        agentName: agent.name,
        opencodeAttachCommand:
          agent.opencodeAttachBaseUrl && agent.opencodeSessionId
            ? buildCliOpencodeAttachCommand(
                agent.opencodeAttachBaseUrl,
                agent.opencodeSessionId,
              )
            : null,
      })),
    ),
  );
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
      await printTaskAttachCommands(context, snapshot);
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
  const preferred = await reservePort(UI_LOOPBACK_HOST, DEFAULT_UI_PORT);
  if (preferred) {
    const port = preferred.port;
    await preferred.close();
    return port;
  }
  const fallback = await reservePort(UI_LOOPBACK_HOST, 0);
  if (!fallback) {
    fail("无法为网页界面分配可用端口。");
  }
  const port = fallback.port;
  await fallback.close();
  return port;
}

async function ensureUiHost(
  context: CliContext,
  cwd: string,
  taskId: string,
  webRoot: string,
  port: number,
) : Promise<{ host: ActiveUiHost; port: number; url: string }> {
  const host = await startWebHost({
    orchestrator: context.orchestrator,
    cwd,
    taskId,
    port,
    webRoot,
    userDataPath: context.userDataPath,
  });
  return {
    host,
    port,
    url: buildUiUrl({
      port,
      taskId,
    }),
  };
}

async function ensureUiAssetsAvailable(userDataPath: string): Promise<string> {
  const assets = await ensureRuntimeAssets(userDataPath);
  const webRoot = assets.webRoot;
  if (webRoot) {
    return webRoot;
  }

  fail(
    isCompiledRuntime()
      ? "网页资源不可用：当前编译产物未内嵌可访问的静态入口文件 index.html，无法启动浏览器 UI。请先执行 bun run build，再重新运行 bun run dist:win 生成新的 agent-team.exe。"
      : "网页资源不可用：缺少可访问的静态入口文件 index.html，无法启动浏览器 UI。源码运行前请先执行 bun run build 生成 dist/web。",
  );
}

async function handleTaskHeadlessCommand(
  context: CliContext,
  command: Extract<ParsedCliCommand, { kind: "task.headless" }>,
  diagnostics: TaskRunDiagnostics,
) {
  let workspace = await resolveProject(context, command.cwd);
  workspace = await ensureJsonTopologyApplied(context, workspace, command.file!);
  const initialMessage = command.message!.trim();

  const snapshot = await context.orchestrator.submitTask({
    cwd: workspace.cwd,
    newTaskId: diagnostics.taskId,
    content: initialMessage,
  });
  printTaskRunDiagnostics(diagnostics);

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
  diagnostics: TaskRunDiagnostics,
): Promise<ActiveUiHost> {
  const streamingPlan = resolveCliTaskStreamingPlan({
    commandKind: command.kind,
    isResume: false,
  });

  let workspace = await resolveProject(context, command.cwd);
  workspace = await ensureJsonTopologyApplied(context, workspace, command.file!);
  const webRoot = await ensureUiAssetsAvailable(context.userDataPath);
  const snapshot = await context.orchestrator.submitTask({
    cwd: workspace.cwd,
    newTaskId: diagnostics.taskId,
    content: command.message!.trim(),
  });
  const uiPort = await resolveUiPort();
  const previewUrl = buildUiUrl({
    port: uiPort,
    taskId: snapshot.task.id,
  });
  printTaskRunDiagnostics(diagnostics, previewUrl);
  const { host, url } = await ensureUiHost(
    context,
    snapshot.task.cwd,
    snapshot.task.id,
    webRoot,
    uiPort,
  );
  await open(url);
  if (streamingPlan.enabled) {
    await renderTaskMessages(context, snapshot.task.id, [], {
      includeHistory: streamingPlan.includeHistory,
      printAttach: streamingPlan.printAttach,
    });
  }
  return host;
}

function buildHelp() {
  const commanderHelp = buildCliProgram().helpInformation().trimEnd();
  const appendix = [
    "",
    "补充命令示例：",
    "  task headless --file <topology-json> --message <message> [--cwd <path>]",
    "  task ui --file <topology-json> --message <message> [--cwd <path>]",
    "",
    "说明：",
    "  - `task headless` 只负责新建任务，运行到本轮任务结束后退出 CLI。",
    "  - `task ui` 会在当前 CLI 进程里启动本地 Web Host，并打开浏览器；命令本身会保持驻留，按 Ctrl+C 后才清理并退出。",
    "  - 新建任务时必须传 `--file` 和 `--message`。",
  ].join("\n");
  return `${commanderHelp}\n${appendix}`;
}

async function run() {
  const command = parseCliCommand(process.argv.slice(2));
  if (command.kind === "help") {
    process.stdout.write(`${buildHelp()}\n`);
    return;
  }

  let userDataPath: string | null = null;
  let activeTaskDiagnostics: TaskRunDiagnostics | null = null;
  if (command.kind === "task.headless") {
    validateTaskHeadlessCommand(command);
    userDataPath = resolveCliUserDataPath();
    initAppFileLogger(userDataPath);
    activeTaskDiagnostics = buildTaskRunDiagnostics(userDataPath, randomUUID());
  } else if (command.kind === "task.ui") {
    validateTaskUiCommand(command);
    userDataPath = resolveCliUserDataPath();
    initAppFileLogger(userDataPath);
    activeTaskDiagnostics = buildTaskRunDiagnostics(userDataPath, randomUUID());
  }
  activeTaskDiagnosticsForCrash = activeTaskDiagnostics;
  didPrintTaskDiagnosticsForCrash = false;

  const context = await createCliContext({
    userDataPath: userDataPath ?? undefined,
  });
  let observedSettledTaskState = false;
  let forceProcessExit = false;
  let interrupted = false;
  let activeUiHost: ActiveUiHost | null = null;
  const handleSignal = (signal: NodeJS.Signals) => {
    if (interrupted) {
      return;
    }
    interrupted = true;
    const plan = resolveCliSignalPlan({
      commandKind: command.kind,
      signal,
    });
    if (!plan.shouldCleanupOpencode) {
      process.exit(plan.exitCode);
      return;
    }
    void Promise.resolve()
      .then(async () => {
        if (activeUiHost) {
          await activeUiHost.close().catch(() => undefined);
          activeUiHost = null;
        }
        await disposeCliContext(context, {
          awaitPendingTaskRuns: plan.awaitPendingTaskRuns,
        });
      })
      .catch(() => undefined)
      .finally(() => {
        process.exit(plan.exitCode);
      });
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  try {
    if (command.kind === "task.headless") {
      await handleTaskHeadlessCommand(context, command, activeTaskDiagnostics!);
      didPrintTaskDiagnosticsForCrash = true;
      observedSettledTaskState = true;
    } else if (command.kind === "task.ui") {
      activeUiHost = await handleTaskUiCommand(context, command, activeTaskDiagnostics!);
      didPrintTaskDiagnosticsForCrash = true;
      observedSettledTaskState = true;
      const disposeOptions = resolveCliDisposeOptions({
        commandKind: command.kind,
        observedSettledTaskState,
      });
      if (disposeOptions.keepAliveUntilSignal) {
        await new Promise<void>(() => undefined);
      }
    }
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    if (!interrupted) {
      const disposeOptions = resolveCliDisposeOptions({
        commandKind: command.kind,
        observedSettledTaskState,
      });
      forceProcessExit = disposeOptions.forceProcessExit;
      if (activeUiHost) {
        await activeUiHost.close().catch(() => undefined);
        activeUiHost = null;
      }
      if (disposeOptions.shouldDisposeContext) {
        await disposeCliContext(context, disposeOptions);
      }
    }
  }

  if (interrupted) {
    return;
  }
  if (forceProcessExit) {
    process.exit(0);
  }
}

void run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  appendAppLog(
    "error",
    "cli.run_failed",
    {
      cwd: process.cwd(),
      message,
    },
    activeTaskDiagnosticsForCrash ? { taskId: activeTaskDiagnosticsForCrash.taskId } : undefined,
  );
  if (activeTaskDiagnosticsForCrash && !didPrintTaskDiagnosticsForCrash) {
    printTaskRunDiagnostics(activeTaskDiagnosticsForCrash);
    didPrintTaskDiagnosticsForCrash = true;
  }
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
