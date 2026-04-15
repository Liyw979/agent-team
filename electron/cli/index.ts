#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { mergeTaskChatMessages, type ChatMessageItem } from "../../src/lib/chat-messages";
import {
  buildCliAttachSessionCommand,
  buildCliPanelFocusCommand,
} from "@shared/terminal-commands";
import { buildZellijMissingMessage, buildZellijMissingReminder } from "@shared/zellij";
import { appendAppLog, initAppFileLogger } from "../main/app-log";
import { Orchestrator } from "../main/orchestrator";
import { resolveCliUserDataPath } from "../main/user-data-path";
import { resolveZellijExecutable } from "../main/zellij-executable";
import type {
  AgentFileRecord,
  InitializeTaskPayload,
  ProjectSnapshot,
  TaskSnapshot,
  TopologyEdge,
  TopologyRecord,
} from "@shared/types";
import type { TaskPanelRecord } from "@shared/types";

type OptionValue = boolean | string;

interface ParsedArgv {
  positionals: string[];
  options: Map<string, OptionValue>;
}

interface CliContext {
  orchestrator: Orchestrator;
  userDataPath: string;
  customAgentConfigPath: string;
}

const SYSTEM_SENDER_LABEL = "Ocustrater";

function parseArgv(argv: string[]): ParsedArgv {
  const positionals: string[] = [];
  const options = new Map<string, OptionValue>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";

    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    const key = rawKey.trim();
    const next = argv[index + 1];

    if (inlineValue !== undefined) {
      options.set(key, inlineValue);
      continue;
    }

    if (next && !next.startsWith("--")) {
      options.set(key, next);
      index += 1;
      continue;
    }

    options.set(key, true);
  }

  return {
    positionals,
    options,
  };
}

function getOptionString(parsed: ParsedArgv, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === "string" ? value : undefined;
}

function hasFlag(parsed: ParsedArgv, name: string): boolean {
  return parsed.options.get(name) === true;
}

function assertPositionals(parsed: ParsedArgv, count: number, usage: string) {
  if (parsed.positionals.length < count) {
    throw new Error(`参数不足。\n\n用法：${usage}`);
  }
}

function fail(message: string): never {
  throw new Error(message);
}

function summarizePrompt(prompt: string) {
  return (
    prompt
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  ).slice(0, 120);
}

function createTopologyEdgeId(source: string, target: string, triggerOn: TopologyEdge["triggerOn"]) {
  return `${source}__${target}__${triggerOn}`;
}

function buildOpenPanelCommand(panel: TaskPanelRecord) {
  return buildCliPanelFocusCommand(panel.taskId, panel.agentName);
}

function buildAttachSessionCommand(sessionName: string) {
  const resolved = resolveZellijExecutable();
  return buildCliAttachSessionCommand(sessionName, {
    command: resolved.command,
    platform: process.platform,
  });
}

let cliZellijAvailableCache: boolean | null = null;

function isCliZellijAvailable() {
  if (cliZellijAvailableCache !== null) {
    return cliZellijAvailableCache;
  }

  const resolved = resolveZellijExecutable();
  if (resolved.bundled && !resolved.available) {
    cliZellijAvailableCache = false;
    return cliZellijAvailableCache;
  }

  const result = spawnSync(resolved.command, ["--version"], {
    stdio: "ignore",
  });
  cliZellijAvailableCache = !result.error && result.status === 0;
  return cliZellijAvailableCache;
}

function assertCliZellijAvailable(action: string) {
  if (!isCliZellijAvailable()) {
    fail(buildZellijMissingMessage(action));
  }
}

function printJson(payload: unknown) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function getChatSenderDisplayName(sender: string) {
  if (sender === "system") {
    return SYSTEM_SENDER_LABEL;
  }
  return sender;
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function printSection(title: string) {
  process.stdout.write(`\n${title}\n`);
}

function printKeyValue(label: string, value: string | number | null | undefined) {
  process.stdout.write(`${label}: ${value ?? "-"}\n`);
}

function printAgentList(agentFiles: AgentFileRecord[], customAgentConfigPath: string) {
  if (agentFiles.length === 0) {
    process.stdout.write(
      [
        "当前目录下没有发现任何 agent。",
        `请检查全局配置文件：${customAgentConfigPath}`,
        "该文件位于用户目录，不会写入当前工作区。",
      ].join("\n") + "\n",
    );
    return;
  }

  for (const agent of agentFiles) {
    process.stdout.write(
      [
        `- ${agent.name}`,
        `  prompt: ${summarizePrompt(agent.prompt) || "-"}`,
      ].join("\n") + "\n",
    );
  }
}

function printTaskSummary(taskSnapshot: TaskSnapshot) {
  printKeyValue("Task", taskSnapshot.task.id);
  printKeyValue("Title", taskSnapshot.task.title);
  printKeyValue("Status", taskSnapshot.task.status);
  printKeyValue("Zellij Session", taskSnapshot.task.zellijSessionId);
  if (!isCliZellijAvailable()) {
    printKeyValue("Zellij 提醒", buildZellijMissingReminder());
  }
  printKeyValue("Initialized At", formatTimestamp(taskSnapshot.task.initializedAt));
  printKeyValue("Created At", formatTimestamp(taskSnapshot.task.createdAt));
  printKeyValue("Completed At", formatTimestamp(taskSnapshot.task.completedAt));

  printSection("Agents");
  for (const agent of taskSnapshot.agents) {
    process.stdout.write(
      `- ${agent.name} | status=${agent.status} | runs=${agent.runCount} | session=${agent.opencodeSessionId ?? "-"}\n`,
    );
  }

  printSection("Messages");
  for (const message of taskSnapshot.messages) {
    process.stdout.write(
      `[${formatTimestamp(message.timestamp)}] ${message.sender}: ${message.content}\n`,
    );
  }
}

function printPanelOpenCommand(taskSnapshot: TaskSnapshot, agentName: string) {
  const panel = taskSnapshot.panels.find(
    (item) => item.agentName === agentName,
  );
  process.stdout.write("\nOpen Zellij\n");

  if (!taskSnapshot.task.zellijSessionId) {
    process.stdout.write("当前 Task 没有可用的 Zellij session。\n");
    return;
  }

  if (!panel) {
    process.stdout.write(`${buildAttachSessionCommand(taskSnapshot.task.zellijSessionId)}\n`);
    return;
  }

  process.stdout.write(`${buildOpenPanelCommand(panel)}\n`);
}

function padRight(value: string, width: number) {
  const visible = value.length;
  if (visible >= width) {
    return value;
  }
  return `${value}${" ".repeat(width - visible)}`;
}

function truncate(value: string, width: number) {
  if (value.length <= width) {
    return value;
  }
  if (width <= 1) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 1)}…`;
}

function wrapText(value: string, width: number) {
  const normalized = value.replace(/\t/g, "  ");
  const rawLines = normalized.split(/\r?\n/);
  const result: string[] = [];

  for (const rawLine of rawLines) {
    if (!rawLine) {
      result.push("");
      continue;
    }

    let rest = rawLine;
    while (rest.length > width) {
      result.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    result.push(rest);
  }

  return result;
}

function createBox(title: string, lines: string[], width: number) {
  const innerWidth = Math.max(width - 2, 20);
  const titleText = truncate(` ${title} `, innerWidth);
  const remaining = Math.max(innerWidth - titleText.length, 0);
  const top = `┌${titleText}${"─".repeat(remaining)}┐`;
  const body = lines.map((line) => `│${padRight(truncate(line, innerWidth), innerWidth)}│`);
  const bottom = `└${"─".repeat(innerWidth)}┘`;
  return [top, ...body, bottom];
}

function createKeyValueLines(entries: Array<[string, string]>) {
  const labelWidth = Math.max(...entries.map(([label]) => label.length), 6);
  return entries.map(([label, value]) => `${padRight(label, labelWidth)} : ${value}`);
}

function buildTaskInterface(taskSnapshot: TaskSnapshot) {
  const terminalWidth = process.stdout.columns || 120;
  const width = Math.max(90, Math.min(terminalWidth, 140));
  const leftWidth = Math.max(42, Math.floor(width * 0.38));
  const rightWidth = width - leftWidth - 3;

  const summaryLines = createKeyValueLines([
    ["Task", taskSnapshot.task.id],
    ["Title", taskSnapshot.task.title],
    ["Status", taskSnapshot.task.status],
    ["Zellij Session", taskSnapshot.task.zellijSessionId ?? "-"],
    ["Initialized At", formatTimestamp(taskSnapshot.task.initializedAt)],
    ["Created At", formatTimestamp(taskSnapshot.task.createdAt)],
    ["Completed At", formatTimestamp(taskSnapshot.task.completedAt)],
  ]);

  const agentLines =
    taskSnapshot.agents.length > 0
      ? taskSnapshot.agents.map((agent) =>
          truncate(
            `${agent.name} | ${agent.status} | runs=${agent.runCount} | session=${agent.opencodeSessionId ?? "-"}`,
            leftWidth - 4,
          ),
        )
      : ["当前没有 Agent 运行态记录"];

  const panelLines =
    taskSnapshot.panels.length > 0
      ? taskSnapshot.panels.flatMap((panel) => [
          truncate(`${panel.agentName} | ${panel.paneId}`, leftWidth - 4),
          ...wrapText(`open: ${buildOpenPanelCommand(panel)}`, leftWidth - 4),
        ])
      : taskSnapshot.task.zellijSessionId
        ? wrapText(`open: ${buildAttachSessionCommand(taskSnapshot.task.zellijSessionId)}`, leftWidth - 4)
        : ["当前没有可用的 Zellij session"];

  const messageLines =
    taskSnapshot.messages.length > 0
      ? taskSnapshot.messages.flatMap((message) => {
          const header = `[${formatTimestamp(message.timestamp)}] ${message.sender}`;
          const content = wrapText(message.content, rightWidth - 4);
          return [header, ...content.map((line) => `  ${line}`), ""];
        })
      : ["当前 Task 还没有消息"];

  const header = `Task Console · ${taskSnapshot.task.title}`;
  const divider = "=".repeat(Math.min(header.length, width));
  const leftColumn = [
    ...createBox("Summary", summaryLines, leftWidth),
    "",
    ...createBox("Agents", agentLines, leftWidth),
    "",
    ...createBox("Panels", panelLines, leftWidth),
  ];
  const rightColumn = createBox("Messages", messageLines, rightWidth);
  const rowCount = Math.max(leftColumn.length, rightColumn.length);
  const output: string[] = [header, divider, ""];

  for (let index = 0; index < rowCount; index += 1) {
    const left = padRight(leftColumn[index] ?? "", leftWidth);
    const right = rightColumn[index] ?? "";
    output.push(`${left}   ${right}`);
  }

  return output.join("\n");
}

function printTaskInterface(taskSnapshot: TaskSnapshot) {
  process.stdout.write(`${buildTaskInterface(taskSnapshot)}\n`);
}

async function attachTaskSession(taskSnapshot: TaskSnapshot) {
  const sessionName = taskSnapshot.task.zellijSessionId;
  if (!sessionName) {
    fail(`Task ${taskSnapshot.task.id} 没有可进入的 Zellij session。`);
  }

  assertCliZellijAvailable("无法进入 Zellij Session");

  await new Promise<void>((resolve, reject) => {
    const resolved = resolveZellijExecutable();
    const args = ["attach", sessionName, "--create"];
    const child = spawn(resolved.command, args, {
      cwd: taskSnapshot.task.cwd,
      stdio: "inherit",
    });

    child.on("error", (error) => {
      appendAppLog("error", "cli.zellij_attach_spawn_failed", {
        command: resolved.command,
        args,
        cwd: taskSnapshot.task.cwd,
        message: error.message,
      });
      console.error("[cli] zellij attach spawn failed", {
        command: resolved.command,
        args,
        cwd: taskSnapshot.task.cwd,
        message: error.message,
      });
      reject(error);
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        appendAppLog("error", "cli.zellij_attach_exit_signal", {
          command: resolved.command,
          args,
          cwd: taskSnapshot.task.cwd,
          signal,
        });
        console.error("[cli] zellij attach exited by signal", {
          command: resolved.command,
          args,
          cwd: taskSnapshot.task.cwd,
          signal,
        });
        reject(new Error(`zellij attach 被信号中断：${signal}`));
        return;
      }
      if ((code ?? 0) !== 0) {
        appendAppLog("error", "cli.zellij_attach_exit_non_zero", {
          command: resolved.command,
          args,
          cwd: taskSnapshot.task.cwd,
          code: code ?? 0,
        });
        console.error("[cli] zellij attach exited with non-zero code", {
          command: resolved.command,
          args,
          cwd: taskSnapshot.task.cwd,
          code: code ?? 0,
        });
        reject(new Error(`zellij attach 退出码异常：${code ?? 0}`));
        return;
      }
      resolve();
    });
  });
}

function printProjectSummary(project: ProjectSnapshot) {
  printKeyValue("Project", project.project.name);
  printKeyValue("Project ID", project.project.id);
  printKeyValue("Path", project.project.path);
  printKeyValue("Agents", project.agentFiles.length);
  printKeyValue("Tasks", project.tasks.length);
}

async function createCliContext(): Promise<CliContext> {
  const userDataPath = resolveCliUserDataPath();
  initAppFileLogger(userDataPath);
  const orchestrator = new Orchestrator({
    userDataPath,
    autoOpenTaskSession: false,
    enableEventStream: false,
  });
  await orchestrator.initialize();
  return {
    orchestrator,
    userDataPath,
    customAgentConfigPath: path.join(userDataPath, "custom-agents.json"),
  };
}

async function resolveProject(
  context: CliContext,
  parsed: ParsedArgv,
  createIfMissing = true,
): Promise<ProjectSnapshot> {
  const cwd = getOptionString(parsed, "cwd") || process.cwd();
  const normalized = path.resolve(cwd);

  if (createIfMissing) {
    return context.orchestrator.ensureProjectForPath(normalized);
  }

  const existing = await context.orchestrator.findProjectByPath(normalized);
  if (!existing) {
    throw new Error(`当前目录尚未注册为 Project：${normalized}`);
  }
  return existing;
}

function findTaskOrThrow(project: ProjectSnapshot, taskId: string): TaskSnapshot {
  const task = project.tasks.find((item) => item.task.id === taskId);
  if (!task) {
    fail(`未找到 Task：${taskId}`);
  }
  return task;
}

function resolveTaskForDebug(project: ProjectSnapshot, taskId?: string): TaskSnapshot {
  if (taskId?.trim()) {
    return findTaskOrThrow(project, taskId.trim());
  }

  const latestTask = project.tasks[0];
  if (!latestTask) {
    fail("当前 Project 还没有 Task，无法获取 debug info。");
  }
  return latestTask;
}

function buildChatTranscript(taskSnapshot: TaskSnapshot) {
  const merged = mergeTaskChatMessages(
    [...taskSnapshot.messages].sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
  );

  return merged.map((message) => ({
    sender: getChatSenderDisplayName(message.sender),
    timestamp: message.timestamp,
    content: message.content,
  }));
}

function buildTaskDebugInfo(taskSnapshot: TaskSnapshot) {
  return {
    taskId: taskSnapshot.task.id,
    title: taskSnapshot.task.title,
    status: taskSnapshot.task.status,
    cwd: taskSnapshot.task.cwd,
    zellijSessionId: taskSnapshot.task.zellijSessionId,
    opencodeSessionId: taskSnapshot.task.opencodeSessionId,
    initializedAt: taskSnapshot.task.initializedAt,
    createdAt: taskSnapshot.task.createdAt,
    completedAt: taskSnapshot.task.completedAt,
    agentCount: taskSnapshot.task.agentCount,
    messageCount: taskSnapshot.messages.length,
    latestMessage: taskSnapshot.messages.at(-1) ?? null,
    chatTranscript: buildChatTranscript(taskSnapshot),
    agents: taskSnapshot.agents.map((agent) => ({
      name: agent.name,
      status: agent.status,
      runCount: agent.runCount,
      opencodeSessionId: agent.opencodeSessionId,
    })),
    panels: taskSnapshot.panels.map((panel) => ({
      agentName: panel.agentName,
      sessionName: panel.sessionName,
      paneId: panel.paneId,
      cwd: panel.cwd,
      openCommand: buildOpenPanelCommand(panel),
    })),
    messages: taskSnapshot.messages,
  };
}

function printChatTranscript(messages: Array<{ sender: string; timestamp: string; content: string }>) {
  if (messages.length === 0) {
    process.stdout.write("当前 Task 还没有聊天记录。\n");
    return;
  }

  for (const message of messages) {
    process.stdout.write(`${message.sender}\n`);
    process.stdout.write(`${formatTimestamp(message.timestamp)}\n`);
    process.stdout.write(`${message.content}\n\n`);
  }
}

function printTaskDebugInfo(taskSnapshot: TaskSnapshot, full = false) {
  if (!full) {
    printChatTranscript(buildChatTranscript(taskSnapshot));
    return;
  }

  const debugInfo = buildTaskDebugInfo(taskSnapshot);
  printKeyValue("Task", debugInfo.taskId);
  printKeyValue("Title", debugInfo.title);
  printKeyValue("Status", debugInfo.status);
  printKeyValue("Cwd", debugInfo.cwd);
  printKeyValue("Zellij Session", debugInfo.zellijSessionId);
  printKeyValue("OpenCode Session", debugInfo.opencodeSessionId);
  printKeyValue("Messages", debugInfo.messageCount);
  printKeyValue("Agents", debugInfo.agentCount);
  printKeyValue("Initialized At", formatTimestamp(debugInfo.initializedAt));
  printKeyValue("Created At", formatTimestamp(debugInfo.createdAt));
  printKeyValue("Completed At", formatTimestamp(debugInfo.completedAt));

  printSection("Chat Transcript");
  printChatTranscript(debugInfo.chatTranscript);

  printSection("Panel Open Commands");
  if (debugInfo.panels.length > 0) {
    for (const panel of debugInfo.panels) {
      process.stdout.write(`- ${panel.agentName}: ${panel.openCommand}\n`);
    }
  } else if (debugInfo.zellijSessionId) {
    process.stdout.write(`${buildAttachSessionCommand(debugInfo.zellijSessionId)}\n`);
  } else {
    process.stdout.write("当前 Task 没有可用的 Zellij session。\n");
  }
}

function findAgentOrThrow(project: ProjectSnapshot, agentName: string): AgentFileRecord {
  const agent = project.agentFiles.find((item) => item.name === agentName);
  if (!agent) {
    fail(`未找到 Agent：${agentName}`);
  }
  return agent;
}

function ensureAgentNames(project: ProjectSnapshot, names: string[]) {
  const valid = new Set(project.agentFiles.map((agent) => agent.name));
  for (const name of names) {
    if (!valid.has(name)) {
      fail(`Project 中不存在 Agent：${name}`);
    }
  }
}

async function readInputContent(parsed: ParsedArgv): Promise<string> {
  const inline = getOptionString(parsed, "content");
  if (inline) {
    return inline;
  }

  const file = getOptionString(parsed, "file");
  if (file) {
    return fs.readFileSync(path.resolve(file), "utf8");
  }

  if (hasFlag(parsed, "stdin")) {
    return new Promise<string>((resolve, reject) => {
      let buffer = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
      });
      process.stdin.on("end", () => resolve(buffer));
      process.stdin.on("error", reject);
    });
  }

  throw new Error("请通过 `--content`、`--file` 或 `--stdin` 提供内容。");
}

function buildHelp() {
  return `OpenCode Code Agent CLI

用法：
  npm run cli -- <command> [args] [--options]

命令：
  project list
  project create [--cwd <path>]
  project current [--cwd <path>]

  task list [--cwd <path>]
  task init [--cwd <path>] [--title <title>] [--plain]
  task show <taskId> [--cwd <path>] [--plain]
  task debug-info [taskId] [--cwd <path>] [--full]
  task messages <taskId> [--cwd <path>]
  task panels <taskId> [--cwd <path>]
  task send <agentName> <message...> [--cwd <path>] [--task <taskId>]

  agent list [--cwd <path>]
  agent show <agentName> [--cwd <path>]
  agent cat <agentName> [--cwd <path>]

  topology show [--cwd <path>]
  topology set-downstream <sourceAgent> [targetAgent... ] [--cwd <path>]
  topology allow <sourceAgent> <targetAgent> [--relation <association|review_pass|review_fail>] [--cwd <path>]
  topology deny <sourceAgent> <targetAgent> [--relation <association|review_pass|review_fail>] [--cwd <path>]

  panel focus <taskId> <agentName> [--cwd <path>]

通用参数：
  --cwd <path>    指定 Project 工作目录，默认当前目录
  --plain         不进入 Zellij，回退到纯文本
  --json          输出 JSON
  --full          输出完整排障信息；默认只输出聊天记录

关系语义：
  association     当前 Agent 正常完成本轮任务后，直接传递到下游
  review_pass     当前 Agent 给出审查通过结论后，才传递到下游
  review_fail     当前 Agent 给出需要修改结论后，才传递到下游

  说明：
  - CLI 会直接复用 Orchestrator、文件存储、OpenCode client、Zellij manager 这套主逻辑。
  - 若当前目录尚未注册为 Project，涉及 Project 语义的命令会自动创建该 Project。
  - \`task init\` 会先创建 Task，并把当前 Project 的全部 Agent 会话 / Zellij pane 初始化好；GUI 群聊默认会优先选中当前列表第一个 Agent，CLI 仍通过 \`task send <agent>\` 指定目标。
  - \`task debug-info\` 默认读取当前 Project 最新 Task，并只输出聊天区展示的合并消息；加 \`--full\` 可输出完整排障信息，也可显式传入 \`taskId\`。
  - \`task send\` 会像 GUI 一样通过 Orchestrator 触发真实 Task 创建/推进与下游调度。
  - \`task show\` 在交互式终端里默认直接进入对应 Task 的 Zellij session。`;
}

async function handleProjects(context: CliContext, parsed: ParsedArgv) {
  const action = parsed.positionals[1];
  const json = hasFlag(parsed, "json");

  if (!action || action === "list") {
    const snapshots = await context.orchestrator.bootstrap();
    if (json) {
      printJson(snapshots);
      return;
    }

    if (snapshots.length === 0) {
      process.stdout.write("当前没有任何 Project。\n");
      return;
    }

    for (const project of snapshots) {
      printProjectSummary(project);
      process.stdout.write("\n");
    }
    return;
  }

  if (action === "create") {
    const cwd = path.resolve(getOptionString(parsed, "cwd") || process.cwd());
    const snapshot = await context.orchestrator.ensureProjectForPath(cwd);

    if (json) {
      printJson(snapshot);
      return;
    }

    process.stdout.write(`已就绪 Project：${snapshot.project.name}\n`);
    printProjectSummary(snapshot);
    return;
  }

  if (action === "current") {
    const snapshot = await resolveProject(context, parsed);
    if (json) {
      printJson(snapshot);
      return;
    }

    printProjectSummary(snapshot);
    return;
  }

  fail(`未知命令：projects ${action}`);
}

async function handleTasks(context: CliContext, parsed: ParsedArgv) {
  const action = parsed.positionals[1];
  const json = hasFlag(parsed, "json");
  const project = await resolveProject(context, parsed);

  if (!action || action === "list") {
    if (json) {
      printJson(project.tasks);
      return;
    }

    if (project.tasks.length === 0) {
      process.stdout.write("当前 Project 还没有 Task。\n");
      return;
    }

    for (const task of project.tasks) {
      process.stdout.write(
        `- ${task.task.id} | ${task.task.title} | status=${task.task.status} | init=${task.task.initializedAt ? "yes" : "no"}\n`,
      );
    }
    return;
  }

  if (action === "init") {
    const payload: InitializeTaskPayload = {
      projectId: project.project.id,
      title: getOptionString(parsed, "title"),
    };
    const snapshot = await context.orchestrator.initializeTask(payload);

    if (json) {
      printJson(snapshot);
      return;
    }

    process.stdout.write(
      `已完成 Task 初始化：${snapshot.task.id}。GUI 群聊会默认优先选中当前列表第一个 Agent；若走 CLI，请继续使用 \`task send <agent>\` 指定目标。\n`,
    );

    if (!hasFlag(parsed, "plain") && process.stdout.isTTY && process.stdin.isTTY) {
      await attachTaskSession(snapshot);
      return;
    }

    printTaskSummary(snapshot);
    printPanelOpenCommand(snapshot, "");
    return;
  }

  if (action === "show") {
    assertPositionals(parsed, 3, "tasks show <taskId> [--cwd <path>]");
    const task = findTaskOrThrow(project, parsed.positionals[2] ?? "");
    if (json) {
      printJson(task);
      return;
    }
    if (!hasFlag(parsed, "plain") && process.stdout.isTTY && process.stdin.isTTY) {
      await attachTaskSession(task);
      return;
    }
    printTaskSummary(task);
    return;
  }

  if (action === "debug-info") {
    const task = resolveTaskForDebug(project, parsed.positionals[2]);
    const full = hasFlag(parsed, "full");
    if (json) {
      printJson(full ? buildTaskDebugInfo(task) : buildChatTranscript(task));
      return;
    }
    printTaskDebugInfo(task, full);
    return;
  }

  if (action === "messages") {
    assertPositionals(parsed, 3, "tasks messages <taskId> [--cwd <path>]");
    const task = findTaskOrThrow(project, parsed.positionals[2] ?? "");
    if (json) {
      printJson(task.messages);
      return;
    }
    for (const message of task.messages) {
      process.stdout.write(
        `[${formatTimestamp(message.timestamp)}] ${message.sender}: ${message.content}\n`,
      );
    }
    return;
  }

  if (action === "panels") {
    assertPositionals(parsed, 3, "tasks panels <taskId> [--cwd <path>]");
    const task = findTaskOrThrow(project, parsed.positionals[2] ?? "");
    if (json) {
      printJson(task.panels);
      return;
    }
    for (const panel of task.panels) {
      process.stdout.write(
        `- ${panel.agentName} | session=${panel.sessionName} | pane=${panel.paneId} | cwd=${panel.cwd}\n`,
      );
      process.stdout.write(`  open: ${buildOpenPanelCommand(panel)}\n`);
    }
    return;
  }

  if (action === "send") {
    assertPositionals(parsed, 3, "tasks send <agentName> <message...> [--cwd <path>] [--task <taskId>]");
    const agentName = parsed.positionals[2] ?? "";
    const agent = findAgentOrThrow(project, agentName);
    const message =
      parsed.positionals.length > 3
        ? parsed.positionals.slice(3).join(" ")
        : (await readInputContent(parsed)).trim();
    if (!message) {
      fail("消息内容不能为空。");
    }

    const taskId = getOptionString(parsed, "task");
    const snapshot = await context.orchestrator.submitTask({
      projectId: project.project.id,
      taskId: taskId ?? null,
      content: message,
      mentionAgent: agent.name,
    });

    if (json) {
      printJson(snapshot);
      return;
    }

    process.stdout.write(`已发送给 @${agentName}\n`);
    printTaskSummary(snapshot);
    printPanelOpenCommand(snapshot, agentName);
    return;
  }

  fail(`未知命令：tasks ${action}`);
}

async function handleAgents(context: CliContext, parsed: ParsedArgv) {
  const action = parsed.positionals[1];
  const json = hasFlag(parsed, "json");
  const project = await resolveProject(context, parsed);

  if (!action || action === "list") {
    if (json) {
      printJson(project.agentFiles);
      return;
    }
    printKeyValue("Agent Config", context.customAgentConfigPath);
    printAgentList(project.agentFiles, context.customAgentConfigPath);
    return;
  }

  if (action === "show") {
    assertPositionals(parsed, 3, "agents show <agentName> [--cwd <path>]");
    const agent = findAgentOrThrow(project, parsed.positionals[2] ?? "");
    if (json) {
      printJson(agent);
      return;
    }

    printKeyValue("Agent", agent.name);
    printSection("Prompt");
    process.stdout.write(`${agent.prompt || "-\n"}\n`);
    return;
  }

  if (action === "cat") {
    assertPositionals(parsed, 3, "agents cat <agentName> [--cwd <path>]");
    const agent = findAgentOrThrow(project, parsed.positionals[2] ?? "");
    process.stdout.write(agent.prompt);
    if (!agent.prompt.endsWith("\n")) {
      process.stdout.write("\n");
    }
    return;
  }

  fail(`未知命令：agents ${action}`);
}

function replaceAssociationDownstream(
  topology: TopologyRecord,
  sourceAgent: string,
  targets: string[],
): TopologyRecord {
  const retained = topology.edges.filter(
    (edge) => !(edge.source === sourceAgent && edge.triggerOn === "association"),
  );
  const nextEdges = [
    ...retained,
    ...targets.map((target) => ({
      id: createTopologyEdgeId(sourceAgent, target, "association" as const),
      source: sourceAgent,
      target,
      triggerOn: "association" as const,
    })),
  ];

  return {
    ...topology,
    edges: nextEdges,
  };
}

function parseTopologyRelation(parsed: ParsedArgv): TopologyEdge["triggerOn"] {
  const relation = getOptionString(parsed, "relation");
  if (!relation) {
    return "association";
  }
  if (relation === "association" || relation === "review_pass" || relation === "review_fail") {
    return relation;
  }
  if (relation === "review") {
    return "review_fail";
  }
  fail(`未知关系类型：${relation}。可选值：association / review_pass / review_fail`);
}

async function saveTopology(
  context: CliContext,
  project: ProjectSnapshot,
  topology: TopologyRecord,
) {
  return context.orchestrator.saveTopology({
    projectId: project.project.id,
    topology,
  });
}

async function handleTopology(context: CliContext, parsed: ParsedArgv) {
  const action = parsed.positionals[1];
  const json = hasFlag(parsed, "json");
  const project = await resolveProject(context, parsed);

  if (!action || action === "show") {
    if (json) {
      printJson(project.topology);
      return;
    }

    process.stdout.write("Nodes\n");
    for (const node of project.topology.nodes) {
      process.stdout.write(`- ${node.id}\n`);
    }

    printSection("Edges");
    if (project.topology.edges.length === 0) {
      process.stdout.write("当前没有任何传递边。\n");
      return;
    }
    for (const edge of project.topology.edges) {
      process.stdout.write(`- ${edge.source} -> ${edge.target} (${edge.triggerOn})\n`);
    }
    return;
  }

  if (action === "set-downstream") {
    assertPositionals(parsed, 3, "topology set-downstream <sourceAgent> [targetAgent...] [--cwd <path>]");
    const sourceAgent = parsed.positionals[2] ?? "";
    const targets = parsed.positionals.slice(3);
    ensureAgentNames(project, [sourceAgent, ...targets]);
    const next = replaceAssociationDownstream(project.topology, sourceAgent, [...new Set(targets)]);
    const updated = await saveTopology(context, project, next);
    if (json) {
      printJson(updated.topology);
      return;
    }
    process.stdout.write(`已更新 ${sourceAgent} 的传递下游集合。\n`);
    return;
  }

  if (action === "allow" || action === "deny") {
    assertPositionals(
      parsed,
      4,
      `topology ${action} <sourceAgent> <targetAgent> [--relation <association|review_pass|review_fail>] [--cwd <path>]`,
    );
    const sourceAgent = parsed.positionals[2] ?? "";
    const targetAgent = parsed.positionals[3] ?? "";
    ensureAgentNames(project, [sourceAgent, targetAgent]);
    const trigger = parseTopologyRelation(parsed);

    const edgeId = createTopologyEdgeId(sourceAgent, targetAgent, trigger);
    const exists = project.topology.edges.some((edge) => edge.id === edgeId);

    let nextTopology = project.topology;
    if (action === "allow" && !exists) {
      nextTopology = {
        ...project.topology,
        edges: [
          ...project.topology.edges.filter(
            (edge) => !(edge.source === sourceAgent && edge.target === targetAgent),
          ),
          {
            id: edgeId,
            source: sourceAgent,
            target: targetAgent,
            triggerOn: trigger,
          },
        ],
      };
    }

    if (action === "deny") {
      nextTopology = {
        ...project.topology,
        edges: project.topology.edges.filter((edge) => edge.id !== edgeId),
      };
    }

    const updated = await saveTopology(context, project, nextTopology);
    if (json) {
      printJson(updated.topology);
      return;
    }
    process.stdout.write(
      action === "allow"
        ? `已设置 ${sourceAgent} -> ${targetAgent} (${trigger})`
        : `已移除 ${sourceAgent} -> ${targetAgent} (${trigger})`,
    );
    process.stdout.write("\n");
    return;
  }

  fail(`未知命令：topology ${action}`);
}

async function handlePanels(context: CliContext, parsed: ParsedArgv) {
  const action = parsed.positionals[1];
  const project = await resolveProject(context, parsed);

  if (action === "focus") {
    assertPositionals(parsed, 4, "panels focus <taskId> <agentName> [--cwd <path>]");
    const taskId = parsed.positionals[2] ?? "";
    const agentName = parsed.positionals[3] ?? "";
    findTaskOrThrow(project, taskId);
    await context.orchestrator.focusAgentPANEL({
      projectId: project.project.id,
      taskId,
      agentName,
    });
    process.stdout.write(`已请求打开 ${agentName} 对应的 panel。\n`);
    return;
  }

  fail(`未知命令：panels ${action ?? ""}`.trim());
}

async function run() {
  const parsed = parseArgv(process.argv.slice(2));
  const [rawGroup] = parsed.positionals;
  const group =
    rawGroup === "projects"
      ? "project"
      : rawGroup === "tasks"
        ? "task"
        : rawGroup === "agents"
          ? "agent"
          : rawGroup === "panels"
            ? "panel"
            : rawGroup;

  if (!group || group === "help" || hasFlag(parsed, "help")) {
    process.stdout.write(`${buildHelp()}\n`);
    return;
  }

  const context = await createCliContext();
  try {
    if (group === "project") {
      await handleProjects(context, parsed);
      return;
    }

    if (group === "task") {
      await handleTasks(context, parsed);
      return;
    }

    if (group === "agent") {
      await handleAgents(context, parsed);
      return;
    }

    if (group === "topology") {
      await handleTopology(context, parsed);
      return;
    }

    if (group === "panel") {
      await handlePanels(context, parsed);
      return;
    }

    fail(`未知命令组：${group}\n\n${buildHelp()}`);
  } finally {
    await context.orchestrator.dispose();
  }
}

void run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
