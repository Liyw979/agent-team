#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { buildCliAttachAgentCommand, buildCliOpencodeAttachCommand } from "@shared/terminal-commands";
import type { TaskSnapshot, WorkspaceSnapshot } from "@shared/types";
import { appendAppLog, initAppFileLogger } from "../main/app-log";
import { Orchestrator } from "../main/orchestrator";
import { resolveCliUserDataPath } from "../main/user-data-path";
import { compileTeamDsl, matchesAppliedTeamDsl } from "../main/team-dsl";
import { collectIncrementalChatTranscript, renderChatStreamEntries } from "./chat-stream-printer";
import {
  buildCliProgram,
  parseCliCommand,
  type ParsedCliCommand,
} from "./cli-command";
import { resolveCliDisposeOptions } from "./cli-dispose-policy";
import { renderTaskSessionSummary } from "./task-session-summary";

interface CliContext {
  orchestrator: Orchestrator;
  userDataPath: string;
}

interface TaskRunDiagnostics {
  logFilePath: string;
}

function fail(message: string): never {
  throw new Error(message);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeContent(value?: string) {
  return (value ?? "").trim();
}

function buildTaskRunDiagnostics(userDataPath: string): TaskRunDiagnostics {
  return {
    logFilePath: path.join(userDataPath, "logs", "agentflow.log"),
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

function createCliContext(): Promise<CliContext> {
  const userDataPath = resolveCliUserDataPath();
  initAppFileLogger(userDataPath);
  const orchestrator = new Orchestrator({
    userDataPath,
    autoOpenTaskSession: false,
    enableEventStream: false,
  });
  return orchestrator.initialize().then(() => ({
    orchestrator,
    userDataPath,
  }));
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
  cwd?: string,
): Promise<WorkspaceSnapshot> {
  const resolvedCwd = path.resolve(cwd || process.cwd());
  const task = await context.orchestrator.getTaskSnapshot(taskId, resolvedCwd);
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

function validateTaskRunCommand(
  command: Extract<ParsedCliCommand, { kind: "task.run" }>,
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

function validateTaskChatCommand(
  command: Extract<ParsedCliCommand, { kind: "task.chat" }>,
) {
  const hasTaskId = Boolean(command.taskId?.trim());
  const hasFile = Boolean(command.file?.trim());
  const hasMessage = Boolean(command.message?.trim());

  if (hasTaskId) {
    if (hasFile) {
      fail("恢复已有 Task 时不允许再传 --file。");
    }
    return;
  }

  if (!hasFile) {
    fail("新建 Task 时必须传 --file <topology.json>。");
  }
  if (!hasMessage) {
    fail("新建 Task 时必须传 --message <message>。");
  }
}

function printTaskAttachCommands(task: TaskSnapshot) {
  process.stdout.write("\nattach:\n");
  for (const agent of task.agents) {
    process.stdout.write(`- ${agent.name} | attach: ${buildCliAttachAgentCommand(agent.name)}\n`);
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
      printTaskAttachCommands(snapshot);
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

async function runInteractiveSession(
  context: CliContext,
  cwd: string,
  taskId: string,
  previousMessages: TaskSnapshot["messages"],
) {
  let knownMessages = previousMessages;
  const reader = createInterface({ input, output, terminal: true });
  process.stdout.write("已进入会话，可继续输入消息 @某一个agent；按 Ctrl+C 退出。\n");

  try {
    while (true) {
      const line = normalizeContent(await reader.question("> "));
      if (!line) {
        continue;
      }

      await context.orchestrator.submitTask({
        cwd,
        taskId,
        content: line,
      });

      const drained = await renderTaskMessages(context, taskId, knownMessages);
      knownMessages = drained.messages;
    }
  } finally {
    reader.close();
  }
}

function spawnUi(taskId: string, cwd: string) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(
    command,
    ["run", "electron:dev", "--", "--agentflow-task-id", taskId, "--agentflow-cwd", cwd],
    {
      cwd,
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();
}

async function handleTaskRunCommand(
  context: CliContext,
  command: Extract<ParsedCliCommand, { kind: "task.run" }>,
) {
  validateTaskRunCommand(command);
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

  if (command.ui) {
    spawnUi(snapshot.task.id, snapshot.task.cwd);
    process.stdout.write(`[UI] 已同步启动当前 Task 前端：${snapshot.task.id}\n`);
  }

  await renderTaskMessages(context, snapshot.task.id, [], {
    includeHistory: true,
    printAttach: true,
  });
}

async function handleTaskShowCommand(
  context: CliContext,
  command: Extract<ParsedCliCommand, { kind: "task.show" }>,
) {
  const diagnostics = buildTaskRunDiagnostics(context.userDataPath);
  const workspace = await resolveTaskProject(context, command.taskId);
  const task = findTaskOrThrow(workspace, command.taskId);
  printTaskRunDiagnostics(diagnostics, task.task.id);

  if (command.ui) {
    spawnUi(task.task.id, task.task.cwd);
    process.stdout.write(`[UI] 已同步启动当前 Task 前端：${task.task.id}\n`);
  }

  await renderTaskMessages(context, task.task.id, [], {
    includeHistory: true,
    printAttach: true,
  });
}

async function handleTaskChatCommand(
  context: CliContext,
  command: Extract<ParsedCliCommand, { kind: "task.chat" }>,
) {
  validateTaskChatCommand(command);
  const diagnostics = buildTaskRunDiagnostics(context.userDataPath);

  if (command.taskId) {
    const workspace = await resolveTaskProject(context, command.taskId, command.cwd);
    const task = findTaskOrThrow(workspace, command.taskId);
    printTaskRunDiagnostics(diagnostics, task.task.id);

    if (command.ui) {
      spawnUi(task.task.id, task.task.cwd);
      process.stdout.write(`[UI] 已同步启动当前 Task 前端：${task.task.id}\n`);
    }

    const replayed = await renderTaskMessages(context, task.task.id, [], {
      includeHistory: true,
      printAttach: true,
    });

    if (command.message?.trim()) {
      await context.orchestrator.submitTask({
        cwd: workspace.cwd,
        taskId: task.task.id,
        content: command.message.trim(),
      });
      const drained = await renderTaskMessages(context, task.task.id, replayed.messages);
      await runInteractiveSession(context, workspace.cwd, task.task.id, drained.messages);
      return;
    }

    await runInteractiveSession(context, workspace.cwd, task.task.id, replayed.messages);
    return;
  }

  let workspace = await resolveProject(context, command.cwd);
  workspace = await ensureJsonTopologyApplied(context, workspace, command.file!);
  const initialMessage = command.message!.trim();

  const snapshot = await context.orchestrator.submitTask({
    cwd: workspace.cwd,
    taskId: null,
    content: initialMessage,
  });
  printTaskRunDiagnostics(diagnostics, snapshot.task.id);

  if (command.ui) {
    spawnUi(snapshot.task.id, snapshot.task.cwd);
    process.stdout.write(`[UI] 已同步启动当前 Task 前端：${snapshot.task.id}\n`);
  }

  const drained = await renderTaskMessages(context, snapshot.task.id, [], {
    includeHistory: true,
    printAttach: true,
  });
  await runInteractiveSession(context, workspace.cwd, snapshot.task.id, drained.messages);
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
    "  task run --file <topology-json> --message <message> [--ui] [--cwd <path>]",
    "  task show <taskId> [--ui]",
    "  task chat --file <topology-json> --message <message> [--ui] [--cwd <path>]",
    "  task chat --task <taskId> [--message <message>] [--ui] [--cwd <path>]",
    "  task attach <agentName> [--cwd <path>] [--print-only]",
    "",
    "说明：",
    "  - `task run` 只负责新建任务，运行到本轮任务结束后退出 CLI。",
    "  - `task show <taskId>` 会打印已有 task 的群聊记录；若任务还在运行，会继续打印到结束。",
    "  - `task chat` 会运行到本轮任务结束后继续保留命令行会话，可继续输入消息。",
    "  - 新建任务时必须传 `--file` 和 `--message`。",
    "  - 恢复已有任务继续对话时使用 `task chat --task <taskId>`；会先打印完整历史群聊。",
    "  - 进入会话后，可以继续直接输入消息，也支持用 `@某一个agent` 指定目标。",
    "  - `task attach <agentName>` 会 attach 到当前工作目录最新 task 的对应 Agent。",
  ].join("\n");
  return `${commanderHelp}\n${appendix}`;
}

async function run() {
  const command = parseCliCommand(process.argv.slice(2));
  if (command.kind === "help") {
    process.stdout.write(`${buildHelp()}\n`);
    return;
  }

  const context = await createCliContext();
  let observedSettledTaskState = false;
  let forceProcessExit = false;
  try {
    if (command.kind === "task.run") {
      await handleTaskRunCommand(context, command);
      observedSettledTaskState = true;
    } else if (command.kind === "task.show") {
      await handleTaskShowCommand(context, command);
      observedSettledTaskState = true;
    } else if (command.kind === "task.chat") {
      await handleTaskChatCommand(context, command);
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
