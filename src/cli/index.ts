#!/usr/bin/env node
import process from "node:process";
import { buildCliAttachCommand } from "@shared/terminal-commands";
import type { TaskSnapshot, WorkspaceSnapshot } from "@shared/types";
import open from "open";
import {
  buildTaskLogFilePath,
  initAppFileLogger,
} from "../runtime/app-log";
import { Orchestrator } from "../runtime/orchestrator";
import { OpenCodeClient } from "../runtime/opencode-client";
import { buildInjectedConfigFromAgents } from "../runtime/project-agent-source";
import { launchTerminalCommand } from "../runtime/terminal-launcher";
import { resolveCliUserDataPath } from "../runtime/user-data-path";
import { compileTeamDsl, matchesAppliedTeamDsl } from "../runtime/team-dsl";
import {
  collectIncrementalAgentFinalMessages,
  renderChatStreamEntries,
} from "./chat-stream-printer";
import {
  buildCliHelpText,
  isCliCommandNameSupported,
  parseCliCommand,
  type ParsedCliCommand,
} from "./cli-command";
import { resolveCliDisposeOptions, type CliDisposeOptions } from "./cli-dispose-policy";
import { resolveCliSignalPlan } from "./cli-signal-policy";
import { ensureRuntimeAssets, isCompiledRuntime } from "./runtime-assets";
import { renderTaskSessionSummary } from "./task-session-summary";
import { isSupportedTopologyFile, loadTeamDslDefinitionFile } from "./topology-file";
import {
  collectNewTaskAttachCommandEntries,
  renderTaskAttachCommands,
  type TaskAttachCommandEntry,
} from "./task-attach-display";
import { reportCliRunFailure } from "./cli-run-failure";
import { renderOpenCodeCleanupReport } from "./opencode-cleanup-report";
import { ensureOpencodePreflightPassed } from "./opencode-preflight";
import {
  buildUiUrl,
  type UiLoopbackBindHost,
} from "./ui-host-launch";
import {
  canReserveLoopbackPortOnHosts,
  reserveLoopbackPort,
  resolveAvailableLoopbackBindHosts,
} from "./loopback-bindings";
import type { CliRunFailureContext } from "./cli-run-failure";
import { startWebHost } from "./web-host";
import { resolveWorkspaceCwdFromFilesystem } from "./workspace-cwd";

const DEFAULT_UI_PORT = 4310;

interface CliContext {
  orchestrator: Orchestrator;
  userDataPath: string;
}

type RunnableCliCommand = Extract<ParsedCliCommand, { kind: "task.ui" }>;
type UiHostState =
  | {
      kind: "inactive";
    }
  | {
      kind: "active";
      close: () => Promise<void>;
    };

const WITHOUT_TASK_RUN_FAILURE_CONTEXT: CliRunFailureContext = {
  kind: "without-task",
};

let activeRunFailureContextForCrash: CliRunFailureContext = WITHOUT_TASK_RUN_FAILURE_CONTEXT;
let didPrintTaskDiagnosticsForCrash = false;

function fail(message: string): never {
  throw new Error(message);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printRunDiagnostics(logFilePath: string) {
  process.stdout.write(`${renderTaskSessionSummary({
    kind: "log-only",
    logFilePath,
  })}\n\n`);
}

function printRunDiagnosticsWithTaskUrl(logFilePath: string, taskUrl: string) {
  process.stdout.write(`${renderTaskSessionSummary({
    kind: "with-url",
    logFilePath,
    taskUrl,
  })}\n\n`);
}

function resolveCommandCwd(command: RunnableCliCommand): string {
  const cwd = command.cwd.trim();
  if (cwd.length > 0) {
    return cwd;
  }
  return process.cwd();
}

function isSettledTaskStatus(status: TaskSnapshot["task"]["status"]) {
  return status === "finished" || status === "failed";
}

async function disposeCliContext(context: CliContext, options: CliDisposeOptions) {
  const report = await context.orchestrator.dispose(options.awaitPendingTaskRuns);
  const output = renderOpenCodeCleanupReport(report);
  if (output) {
    process.stdout.write(output);
  }
  return report;
}

async function createCliContext(input: {
  cwd: string;
  commandName: string;
  userDataPath: string;
  compiledTopology: ReturnType<typeof compileTeamDsl>;
}): Promise<CliContext> {
  // 2026-05-28: 用户要求 CLI 支持通过 --cmd 替换默认命令名，serve 启动与 attach 文案必须共用同一个命令名。
  // 2026-05-28: 用户要求 `--cmd` 只表示单个可执行命令名，不支持包含空白字符的复合 shell 前缀。
  const userDataPath = input.userDataPath;
  const cwd = resolveWorkspaceCwdFromFilesystem(input.cwd, process.cwd());
  await ensureRuntimeAssets(userDataPath);
  const server = await OpenCodeClient.startServer(
    cwd,
    buildInjectedConfigFromAgents(input.compiledTopology.agents),
    input.commandName,
  );
  const opencodeClient = new OpenCodeClient({
    server,
  });
  try {
    const orchestrator = new Orchestrator({
      cwd,
      commandName: input.commandName,
      userDataPath,
      opencodeClient,
      terminalLauncher: launchTerminalCommand,
    });
    await orchestrator.initialize();
    return {
      orchestrator,
      userDataPath,
    };
  } catch (error) {
    await opencodeClient.shutdown();
    throw error;
  }
}

async function ensureYamlTopologyApplied(
  context: CliContext,
  workspace: WorkspaceSnapshot,
  compiled: ReturnType<typeof compileTeamDsl>,
): Promise<WorkspaceSnapshot> {
  if (matchesAppliedTeamDsl(workspace.agents, workspace.topology, compiled)) {
    return workspace;
  }
  return context.orchestrator.applyTeamDsl({
    compiled,
  });
}

function validateTaskUiCommand(
  command: Extract<ParsedCliCommand, { kind: "task.ui" }>,
) {
  const hasFile = command.file.trim().length > 0;
  const hasMessage = command.message.trim().length > 0;

  if (!isCliCommandNameSupported(command.cmd)) {
    fail("新建 Task 打开网页界面时传入的 --cmd 必须是单个命令名，只允许字母、数字、_、.、/、\\、:、-。");
  }
  if (!hasFile) {
    fail("新建 Task 打开网页界面时必须传 --file <topology-file>。");
  }
  if (!isSupportedTopologyFile(command.file.trim())) {
    fail("新建 Task 打开网页界面时传入的 --file 必须是 .yaml 或 .yml。");
  }
  if (!hasMessage) {
    fail("新建 Task 打开网页界面时必须传 --message <message>。");
  }
}

function buildTaskAttachEntries(task: TaskSnapshot, commandName: string): TaskAttachCommandEntry[] {
  // 2026-05-28: 用户要求 CLI 支持通过 --cmd 替换默认 opencode 命令，打印出的 attach 调试命令必须与 serve 启动命令一致。
  return task.agents.map((agent) => {
    if (agent.opencodeAttachBaseUrl && agent.opencodeSessionId) {
      return {
        kind: "attached",
        agentId: agent.id,
        opencodeAttachCommand: buildCliAttachCommand(
          commandName,
          agent.opencodeAttachBaseUrl,
          agent.opencodeSessionId,
        ),
      };
    }
    return {
      kind: "pending",
      agentId: agent.id,
    };
  });
}

async function renderTaskMessages(
  context: CliContext,
  commandName: string,
  previousMessages: TaskSnapshot["messages"],
) {
  let lastMessages = previousMessages;
  let attachPrinted = false;
  let lastAttachEntries: TaskAttachCommandEntry[] = [];

  while (true) {
    const snapshot = await context.orchestrator.getTaskSnapshot();
    const attachEntries = buildTaskAttachEntries(snapshot, commandName);

    if (!attachPrinted) {
      const attachCommands = renderTaskAttachCommands(attachEntries);
      if (attachCommands.length > 0) {
        process.stdout.write(`attach:\n${attachCommands}`);
        attachPrinted = true;
      }
      lastAttachEntries = attachEntries;
    } else {
      const newAttachEntries = collectNewTaskAttachCommandEntries(lastAttachEntries, attachEntries);
      if (newAttachEntries.length > 0) {
        process.stdout.write(renderTaskAttachCommands(newAttachEntries));
      }
      lastAttachEntries = attachEntries;
    }

    const entries = collectIncrementalAgentFinalMessages(lastMessages, snapshot.messages);

    if (entries.length > 0) {
      process.stdout.write(renderChatStreamEntries(entries));
    }
    lastMessages = snapshot.messages;

    if (isSettledTaskStatus(snapshot.task.status)) {
      return {
        snapshot,
        messages: lastMessages,
      };
    }

    await sleep(800);
  }
}

async function resolveUiHostBinding() {
  const bindHosts = await resolveAvailableLoopbackBindHosts();
  if (bindHosts.length === 0) {
    fail("当前机器没有可用的 loopback 监听地址。");
  }
  if (await canReserveLoopbackPortOnHosts(DEFAULT_UI_PORT, bindHosts)) {
    return {
      bindHosts,
      port: DEFAULT_UI_PORT,
    };
  }
  for (const host of bindHosts) {
    const reservation = await reserveLoopbackPort(host, 0);
    if (!reservation.ok) {
      continue;
    }
    const candidatePort = reservation.reservation.port;
    await reservation.reservation.close();
    if (await canReserveLoopbackPortOnHosts(candidatePort, bindHosts)) {
      return {
        bindHosts,
        port: candidatePort,
      };
    }
  }
  fail("无法为网页界面分配同时适用于 IPv4 和 IPv6 loopback 的端口。");
}

async function ensureUiHost(
  context: CliContext,
  webRoot: string,
  port: number,
  bindHosts: readonly UiLoopbackBindHost[],
): Promise<{ close: () => Promise<void>; port: number; url: string }> {
  const host = await startWebHost({
    orchestrator: context.orchestrator,
    port,
    staticAssets: {
      kind: "single-page-app",
      webRoot,
    },
    userDataPath: context.userDataPath,
    bindHosts: [...bindHosts],
  });
  return {
    close: host.close,
    port,
    url: buildUiUrl({
      port,
    }),
  };
}

async function ensureUiAssetsAvailable(userDataPath: string): Promise<string> {
  const assets = await ensureRuntimeAssets(userDataPath);
  if (assets.kind === "available") {
    return assets.webRoot;
  }

  fail(
    isCompiledRuntime()
      ? "网页资源不可用：当前编译产物未内嵌可访问的静态入口文件 index.html，无法启动浏览器 UI。请先执行 bun run build，再重新运行 bun run dist:win 生成新的 agent-team.exe。"
      : "网页资源不可用：缺少可访问的静态入口文件 index.html，无法启动浏览器 UI。源码运行前请先执行 bun run build 生成 dist/web。",
  );
}

async function handleTaskUiCommand(
  context: CliContext,
  command: Extract<ParsedCliCommand, { kind: "task.ui" }>,
  compiledTopology: ReturnType<typeof compileTeamDsl>,
): Promise<() => Promise<void>> {
  let workspace = await context.orchestrator.getWorkspaceSnapshot();
  workspace = await ensureYamlTopologyApplied(context, workspace, compiledTopology);
  const webRoot = await ensureUiAssetsAvailable(context.userDataPath);
  const snapshot = await context.orchestrator.submitTask(command.message.trim());
  const uiHostBinding = await resolveUiHostBinding();
  const uiPort = uiHostBinding.port;
  const uiUrl = buildUiUrl({
    port: uiPort,
  });
  activeRunFailureContextForCrash = {
    kind: "task",
    logFilePath: buildTaskLogFilePath(context.userDataPath, snapshot.task.id),
  };
  printRunDiagnosticsWithTaskUrl(activeRunFailureContextForCrash.logFilePath, uiUrl);
  const { close, url } = await ensureUiHost(
    context,
    webRoot,
    uiPort,
    uiHostBinding.bindHosts,
  );
  await open(url);
  await renderTaskMessages(context, command.cmd, []);
  return close;
}

async function run() {
  const command = parseCliCommand(process.argv.slice(2));
  if (command.kind === "help") {
    process.stdout.write(`${buildCliHelpText()}\n`);
    return;
  }

  if (command.kind === "task.ui") {
    validateTaskUiCommand(command);
  }
  const userDataPath = resolveCliUserDataPath();
  const compiledTopology = compileTeamDsl(loadTeamDslDefinitionFile(command.file));
  initAppFileLogger(userDataPath);

  activeRunFailureContextForCrash = WITHOUT_TASK_RUN_FAILURE_CONTEXT;
  didPrintTaskDiagnosticsForCrash = false;

  await ensureOpencodePreflightPassed(command.cmd);

  const context = await createCliContext({
    cwd: resolveCommandCwd(command),
    commandName: command.cmd,
    userDataPath,
    compiledTopology,
  });
  let observedSettledTaskState = false;
  let forceProcessExit = false;
  let interrupted = false;
  let activeUiHost: UiHostState = {
    kind: "inactive",
  };
  const handleSignal = (signal: NodeJS.Signals) => {
    if (interrupted) {
      return;
    }
    interrupted = true;
    const plan = resolveCliSignalPlan({
      signal,
    });
    if (!plan.shouldCleanupOpencode) {
      process.exit(plan.exitCode);
    }
    void Promise.resolve()
      .then(async () => {
        if (activeUiHost.kind === "active") {
          await activeUiHost.close().catch(() => {});
          activeUiHost = {
            kind: "inactive",
          };
        }
        await disposeCliContext(context, {
          awaitPendingTaskRuns: plan.awaitPendingTaskRuns,
          forceProcessExit: false,
          keepAliveUntilSignal: false,
          shouldDisposeContext: true,
        });
      })
      .catch(() => {})
      .finally(() => {
        process.exit(plan.exitCode);
      });
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  try {
    if (command.kind === "task.ui") {
      activeUiHost = {
        kind: "active",
        close: await handleTaskUiCommand(context, command, compiledTopology),
      };
      didPrintTaskDiagnosticsForCrash = true;
      observedSettledTaskState = true;
      const disposeOptions = resolveCliDisposeOptions({
        observedSettledTaskState,
      });
      if (disposeOptions.keepAliveUntilSignal) {
        await new Promise<void>(() => {});
      }
    }
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    if (!interrupted) {
      const disposeOptions = resolveCliDisposeOptions({
        observedSettledTaskState,
      });
      forceProcessExit = disposeOptions.forceProcessExit;
      if (activeUiHost.kind === "active") {
        await activeUiHost.close().catch(() => {});
        activeUiHost = {
          kind: "inactive",
        };
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
  didPrintTaskDiagnosticsForCrash = reportCliRunFailure({
    context: activeRunFailureContextForCrash,
    message,
    cwd: process.cwd(),
    didPrintDiagnostics: didPrintTaskDiagnosticsForCrash,
    printDiagnostics: (logFilePath) => {
      printRunDiagnostics(logFilePath);
    },
  });
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
