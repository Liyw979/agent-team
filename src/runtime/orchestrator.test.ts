import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildCliOpencodeAttachCommand } from "@shared/terminal-commands";
import {
  getMessageTargetAgentIds,
  isAgentDispatchMessageRecord,
  isUserMessageRecord,
} from "@shared/types";
import type { OpenCodeExecutionResult } from "./opencode-client";
import { Orchestrator, isTerminalTaskStatus } from "./orchestrator";
import { compileTeamDsl, type TeamDslDefinition } from "./team-dsl";
import { isOpenCodeServeCommand } from "./opencode-process-cleanup";
import { buildInjectedConfigFromAgents } from "./project-agent-source";

const TEST_AGENT_PROMPTS: Record<string, string> = {
  Build: "",
  BA: "你是 BA。",
  CodeReview: "你是 CodeReview。",
  UnitTest: "你是 UnitTest。",
  TaskReview: "你是 TaskReview。",
};

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-orchestrator-"));
}

function parseInjectedConfig(content: string | null | undefined): {
  agent?: Record<string, { mode?: string; prompt?: string; permission?: unknown }>;
} {
  return JSON.parse(content ?? "{}") as {
    agent?: Record<string, { mode?: string; prompt?: string; permission?: unknown }>;
  };
}

const activeOrchestrators = new Set<Orchestrator>();

function createTestOrchestrator(
  options: ConstructorParameters<typeof Orchestrator>[0],
): Orchestrator {
  const orchestrator = new Orchestrator(options);
  activeOrchestrators.add(orchestrator);
  return orchestrator;
}

function stubOpenCodeSessions(orchestrator: Orchestrator) {
  const typed = orchestrator as unknown as Orchestrator & {
    opencodeClient: {
      createSession: (projectPath: string, title: string) => Promise<string>;
      getAttachBaseUrl: (projectPath: string) => Promise<string>;
      reloadConfig: () => Promise<void>;
    };
  };
  typed.opencodeClient.createSession = async (_projectPath, title) => `session:${title}`;
  typed.opencodeClient.getAttachBaseUrl = async () => "http://127.0.0.1:43127";
  typed.opencodeClient.reloadConfig = async () => undefined;
  return typed;
}

function stubOpenCodeAttachBaseUrl(orchestrator: Orchestrator) {
  const typed = orchestrator as unknown as Orchestrator & {
    opencodeClient: {
      getAttachBaseUrl: (projectPath: string) => Promise<string>;
    };
  };
  typed.opencodeClient.getAttachBaseUrl = async () => "http://127.0.0.1:43127";
  return typed;
}

function buildOpenCodeExecutionResult(input: {
  agent: string;
  finalMessage: string;
  status?: "completed" | "error";
  fallbackMessage?: string | null;
  messageId?: string;
  timestamp?: string;
  error?: string | null;
}): OpenCodeExecutionResult {
  const timestamp = input.timestamp ?? "2026-04-22T00:00:00.000Z";
  const messageId = input.messageId ?? `message:${input.agent}`;
  const error = input.error ?? null;
  return {
    status: input.status ?? "completed",
    finalMessage: input.finalMessage,
    fallbackMessage: input.fallbackMessage ?? null,
    messageId,
    timestamp,
    rawMessage: {
      id: messageId,
      content: input.finalMessage,
      sender: input.agent,
      timestamp,
      completedAt: input.status === "error" ? null : timestamp,
      error,
      raw: null,
    },
  };
}

function buildCompletedExecutionResult(input: {
  agent: string;
  finalMessage: string;
  messageId?: string;
  timestamp?: string;
  fallbackMessage?: null;
}) {
  return buildOpenCodeExecutionResult({
    ...input,
    status: "completed",
    fallbackMessage: input.fallbackMessage ?? null,
  }) as OpenCodeExecutionResult & { status: "completed"; fallbackMessage: null };
}

function buildErrorExecutionResult(input: {
  agent: string;
  finalMessage: string;
  messageId?: string;
  timestamp?: string;
  error: string;
}) {
  return buildOpenCodeExecutionResult({
    ...input,
    status: "error",
    fallbackMessage: null,
  }) as OpenCodeExecutionResult & { status: "error"; fallbackMessage: null };
}

function forceCleanupCurrentProcessOpenCodeChildren() {
  try {
    const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const childrenByParent = new Map<number, Array<{ pid: number; command: string }>>();
    for (const line of output.split(/\r?\n/)) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) {
        continue;
      }
      const pid = Number(match[1]);
      const parentPid = Number(match[2]);
      const command = match[3] ?? "";
      if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || pid <= 0 || parentPid <= 0) {
        continue;
      }
      const current = childrenByParent.get(parentPid) ?? [];
      current.push({ pid, command });
      childrenByParent.set(parentPid, current);
    }

    const descendants: Array<{ pid: number; command: string }> = [];
    const pending = [...(childrenByParent.get(process.pid) ?? [])];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current || descendants.some((item) => item.pid === current.pid)) {
        continue;
      }
      descendants.push(current);
      for (const child of childrenByParent.get(current.pid) ?? []) {
        pending.push(child);
      }
    }

    for (const child of descendants.reverse()) {
      if (!isOpenCodeServeCommand(child.command)) {
        continue;
      }
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        continue;
      }
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore cleanup errors in tests
  }
}

afterEach(async () => {
  const orchestrators = [...activeOrchestrators];
  activeOrchestrators.clear();
  await Promise.allSettled(orchestrators.map((orchestrator) => orchestrator.dispose()));
  forceCleanupCurrentProcessOpenCodeChildren();
});

const LEGACY_WORKSPACE_STATE_BASENAME = ["state", "json"].join(".");

test("getWorkspaceSnapshot 在空工作区只读读取时不应物化旧工作区快照文件", async () => {
  const userDataPath = createTempDir();
  const workspacePath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  await orchestrator.getWorkspaceSnapshot(workspacePath);

  assert.equal(fs.existsSync(path.join(workspacePath, ".agent-team", LEGACY_WORKSPACE_STATE_BASENAME)), false);
});

function buildTeamDslFromWorkspaceSnapshot(input: {
  workspace: Awaited<ReturnType<Orchestrator["getWorkspaceSnapshot"]>>;
  nextAgents: Array<{ name: string; prompt: string; isWritable?: boolean }>;
}): TeamDslDefinition {
  return {
    entry: input.workspace.topology.langgraph?.start.targets[0] ?? input.nextAgents[0]?.name ?? "Build",
    nodes: [...new Set([...input.workspace.topology.nodes, ...input.nextAgents.map((agent) => agent.name)])].map((name) => {
      const nextAgent = input.nextAgents.find((agent) => agent.name === name);
      if (nextAgent) {
        return {
          type: "agent" as const,
          name,
          prompt: nextAgent.prompt,
          writable: nextAgent.isWritable === true,
        };
      }

      const existingNode = input.workspace.topology.nodeRecords?.find((node) => node.id === name);
      return {
        type: "agent" as const,
        name,
        prompt: existingNode?.prompt ?? "",
        writable: existingNode?.writable === true,
      };
    }),
    links: input.workspace.topology.edges.map((edge) => ({
      from: edge.source,
      to: edge.target,
      trigger_type: edge.triggerOn,
      message_type: edge.messageMode,
    })),
  };
}

async function replaceWorkspaceAgents(
  orchestrator: Orchestrator,
  cwd: string,
  nextAgents: Array<{ name: string; prompt: string; isWritable?: boolean }>,
) {
  const current = await orchestrator.getWorkspaceSnapshot(cwd);
  const compiled = compileTeamDsl(buildTeamDslFromWorkspaceSnapshot({
    workspace: current,
    nextAgents,
  }));
  return orchestrator.applyTeamDsl({
    cwd,
    compiled,
  });
}

async function addBuiltinAgents(
  orchestrator: Orchestrator,
  cwd: string,
  agentNames: string[],
  writableAgentName?: string | null,
) {
  let latestWorkspace = await orchestrator.getWorkspaceSnapshot(cwd);
  for (const agentName of agentNames) {
    const prompt = TEST_AGENT_PROMPTS[agentName];
    assert.notEqual(prompt, undefined, `缺少测试 Agent prompt：${agentName}`);
    const nextAgents = [...latestWorkspace.agents];
    const existingIndex = nextAgents.findIndex((agent) => agent.name === agentName);
    const nextAgent = {
      name: agentName,
      prompt: prompt ?? "",
      isWritable: writableAgentName === agentName,
    };
    if (existingIndex >= 0) {
      nextAgents[existingIndex] = nextAgent;
    } else {
      nextAgents.push(nextAgent);
    }
    latestWorkspace = await replaceWorkspaceAgents(orchestrator, cwd, nextAgents);
  }
  return latestWorkspace;
}

async function addCustomAgent(
  orchestrator: Orchestrator,
  cwd: string,
  agentName: string,
  prompt: string,
  isWritable = false,
) {
  const current = await orchestrator.getWorkspaceSnapshot(cwd);
  const nextAgents = [...current.agents];
  const existingIndex = nextAgents.findIndex((agent) => agent.name === agentName);
  const nextAgent = {
    name: agentName,
    prompt,
    isWritable,
  };
  if (existingIndex >= 0) {
    nextAgents[existingIndex] = nextAgent;
  } else {
    nextAgents.push(nextAgent);
  }
  return replaceWorkspaceAgents(orchestrator, cwd, nextAgents);
}

async function waitForTaskSnapshot(
  orchestrator: Orchestrator,
  taskId: string,
  predicate: (snapshot: Awaited<ReturnType<Orchestrator["getTaskSnapshot"]>>) => boolean,
  timeoutMs = 5000,
): Promise<Awaited<ReturnType<Orchestrator["getTaskSnapshot"]>>> {
  const startedAt = Date.now();
  let latestSnapshot = await orchestrator.getTaskSnapshot(taskId);
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate(latestSnapshot)) {
      return latestSnapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    latestSnapshot = await orchestrator.getTaskSnapshot(taskId);
  }

  throw new Error(
    `Task ${taskId} did not reach the expected state in ${timeoutMs}ms. `
      + `Latest status=${latestSnapshot.task.status}, messageCount=${latestSnapshot.messages.length}.`,
  );
}

async function waitForValue<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 1000,
): Promise<T> {
  const startedAt = Date.now();
  let latestValue = await read();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate(latestValue)) {
      return latestValue;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    latestValue = await read();
  }

  throw new Error(`Value did not satisfy the predicate in ${timeoutMs}ms.`);
}

function readBuiltinTopologyJson(fileName: string) {
  return JSON.parse(
    fs.readFileSync(path.join("config", "team-topologies", fileName), "utf8"),
  ) as TeamDslDefinition;
}

test("task init 会补齐 OpenCode 运行态", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(orchestrator);

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build"], "Build");
  const task = await orchestrator.initializeTask({ cwd: project.cwd, title: "demo" });

  assert.equal(task.task.cwd, project.cwd);
  assert.equal(task.messages.some((message) => /session/i.test(message.content)), false);
  assert.equal(task.agents.some((agent) => agent.name === "Build"), true);
  assert.equal(task.task.cwd, projectPath);
});

test("漏洞团队任务初始化时不会为仅作为 spawn 模板存在的静态 agent 预建 session", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(orchestrator);

  const compiled = compileTeamDsl(readBuiltinTopologyJson("vulnerability-team.topology.json"));
  await orchestrator.applyTeamDsl({
    cwd: projectPath,
    compiled,
  });

  const task = await orchestrator.initializeTask({ cwd: projectPath, title: "vuln-demo" });
  const agentByName = new Map(task.agents.map((agent) => [agent.name, agent]));

  assert.equal(agentByName.get("初筛")?.opencodeSessionId, "session:vuln-demo:初筛");
  assert.equal(agentByName.get("正方")?.opencodeSessionId, null);
  assert.equal(agentByName.get("反方")?.opencodeSessionId, null);
  assert.equal(agentByName.get("裁决总结")?.opencodeSessionId, null);
});

test("单节点任务进入 waiting 时不会因为缺少 workspace cwd 而在后台崩溃", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  const typed = orchestrator as unknown as Orchestrator & {
    createLangGraphBatchRunners: (
      cwd: string,
      taskId: string,
      state: unknown,
      batch: unknown,
    ) => Promise<Array<{ id: string; agentName: string; promise: Promise<unknown> }>>;
    trackBackgroundTask: (promise: Promise<unknown>, context: { taskId: string; agentName: string }) => void;
    opencodeClient: {
      createSession: (projectPath: string, title: string) => Promise<string>;
      reloadConfig: () => Promise<void>;
    };
    opencodeRunner: {
      run: (payload: { agent: string }) => Promise<OpenCodeExecutionResult>;
    };
  };
  stubOpenCodeAttachBaseUrl(orchestrator);

  let backgroundRun: Promise<unknown> | null = null;
  typed.trackBackgroundTask = (promise) => {
    backgroundRun = promise;
  };
  typed.createLangGraphBatchRunners = async () => [];
  typed.opencodeClient.createSession = async (_projectPath, title) => `session:${title}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async ({ agent }) =>
    buildOpenCodeExecutionResult({
      agent,
      finalMessage: `${agent} 已完成本轮处理。`,
      messageId: `message:${agent}:waiting`,
    });

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addCustomAgent(orchestrator, project.cwd, "BA", "你是 BA。");
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      nodes: ["BA"],
      edges: [],
    },
  });

  const task = await orchestrator.submitTask({
    cwd: project.cwd,
    content: "@BA 请分析当前问题",
    mentionAgent: "BA",
  });

  assert.notEqual(backgroundRun, null);
  await assert.doesNotReject(async () => {
    await backgroundRun;
  });

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
    task.task.id,
    (current) => current.task.status === "waiting",
    3000,
  );
  assert.equal(snapshot.task.status, "waiting");
});

test("漏洞团队里反方返回 approved 后会继续派发到裁决总结，而不是后台中断", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  const typed = orchestrator as unknown as Orchestrator & {
    opencodeClient: {
      createSession: (projectPath: string, title: string) => Promise<string>;
      reloadConfig: () => Promise<void>;
    };
    opencodeRunner: {
      run: (payload: { agent: string }) => Promise<OpenCodeExecutionResult>;
    };
  };
  stubOpenCodeAttachBaseUrl(orchestrator);

  const runCountByAgent = new Map<string, number>();
  const nextCount = (agent: string) => {
    const next = (runCountByAgent.get(agent) ?? 0) + 1;
    runCountByAgent.set(agent, next);
    return next;
  };

  typed.opencodeClient.createSession = async (_projectPath, title) => `session:${title}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async ({ agent }) => {
    const count = nextCount(agent);
    if (agent === "初筛" && count === 1) {
      return {
        ...buildCompletedExecutionResult({
          agent,
          finalMessage: [
          "- 可疑点标题：HTTP/2 请求未强制要求 :authority 或 host",
          "- 涉及文件与函数：a",
          "- 为什么可疑：b",
          "- 初步风险等级：高危",
        ].join("\n"),
          messageId: "message:初筛:1",
          timestamp: "2026-04-22T00:00:00.000Z",
        }),
        rawMessage: {
          id: "message:初筛:1",
          content: "初筛第 1 轮已产出 finding",
          sender: agent,
          timestamp: "2026-04-22T00:00:00.000Z",
          completedAt: "2026-04-22T00:00:00.000Z",
          error: null,
          raw: null,
        },
      };
    }

    if (agent === "初筛") {
      throw new Error("测试在首个裁决完成后主动停止后续初筛回流。");
    }

    if (agent === "反方") {
      return {
        ...buildOpenCodeExecutionResult({
          agent,
          finalMessage: "证据链已经闭环，交给裁决。\n\n<complete>同意进入裁决。</complete>",
          messageId: `message:反方:${count}`,
          timestamp: "2026-04-22T00:00:01.000Z",
        }),
        rawMessage: {
          id: `message:反方:${count}`,
          content: "反方认可进入裁决",
          sender: agent,
          timestamp: "2026-04-22T00:00:01.000Z",
          completedAt: "2026-04-22T00:00:01.000Z",
          error: null,
          raw: null,
        },
      };
    }

    if (agent === "裁决总结") {
      return {
        ...buildOpenCodeExecutionResult({
          agent,
          finalMessage: "裁决：该点更像真实漏洞，输出正式漏洞报告。",
          messageId: `message:裁决总结:${count}`,
          timestamp: "2026-04-22T00:00:02.000Z",
        }),
        rawMessage: {
          id: `message:裁决总结:${count}`,
          content: "裁决总结已输出报告",
          sender: agent,
          timestamp: "2026-04-22T00:00:02.000Z",
          completedAt: "2026-04-22T00:00:02.000Z",
          error: null,
          raw: null,
        },
      };
    }

    return buildOpenCodeExecutionResult({
      agent,
      finalMessage: `${agent} 已处理完成。`,
      messageId: `message:${agent}:${count}`,
      timestamp: "2026-04-22T00:00:03.000Z",
    });
  };

  const compiled = compileTeamDsl(readBuiltinTopologyJson("vulnerability-team.topology.json"));
  await orchestrator.applyTeamDsl({
    cwd: projectPath,
    compiled,
  });

  const task = await orchestrator.submitTask({
    cwd: projectPath,
    content: "@初筛 请分析这个漏洞线索",
    mentionAgent: "初筛",
  });

  await waitForValue(
    async () => {
      const dispatchMessage = typed.store.listMessages(projectPath, task.task.id).findLast(
        (message) => isAgentDispatchMessageRecord(message) && message.sender === "初筛",
      );
      return dispatchMessage ? getMessageTargetAgentIds(dispatchMessage)[0] ?? null : null;
    },
    (value) => typeof value === "string" && value.startsWith("反方-"),
    3000,
  );

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
    task.task.id,
    (current) => current.messages.some((message) => message.sender.startsWith("裁决总结-")),
    3000,
  );

  assert.equal(
    snapshot.messages.some((message) => message.sender.startsWith("裁决总结-")),
    true,
  );
});

test("漏洞团队 spawn runtime agent 尚未落库时，getTaskSnapshot 不会把任务提前判 finished", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  const typed = orchestrator as unknown as Orchestrator & {
    store: {
      getTask: (cwd: string, taskId: string) => { status: string };
      listMessages: (cwd: string, taskId: string) => Array<{
        sender: string;
        kind?: string;
        targetAgentIds?: string[];
        status?: string;
      }>;
      listTaskAgents: (cwd: string, taskId: string) => Array<{ name: string }>;
    };
    opencodeClient: {
      createSession: (projectPath: string, title: string) => Promise<string>;
      reloadConfig: () => Promise<void>;
    };
    opencodeRunner: {
      run: (payload: { agent: string }) => Promise<OpenCodeExecutionResult>;
    };
    buildProjectGitDiffSummary: (cwd: string) => Promise<string>;
  };
  stubOpenCodeAttachBaseUrl(orchestrator);

  let gitSummaryCallCount = 0;
  let releaseGitSummary: (value: string) => void = () => undefined;
  const gitSummaryBlocked = new Promise<string>((resolve) => {
    releaseGitSummary = resolve;
  });

  typed.opencodeClient.createSession = async (_projectPath, title) => `session:${title}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.buildProjectGitDiffSummary = async () => {
    gitSummaryCallCount += 1;
    if (gitSummaryCallCount === 1) {
      return "";
    }
    return gitSummaryBlocked;
  };
  typed.opencodeRunner.run = async ({ agent }) => {
    if (agent === "初筛") {
      return {
        ...buildOpenCodeExecutionResult({
          agent,
          finalMessage: [
          "- 可疑点标题：HTTP/2 请求未强制要求 :authority 或 host",
          "- 涉及文件与函数：a",
          "- 为什么可疑：b",
          "- 初步风险等级：高危",
        ].join("\n"),
          messageId: "message:初筛:1",
          timestamp: "2026-04-22T00:00:00.000Z",
        }),
        rawMessage: {
          id: "message:初筛:1",
          content: "初筛第 1 轮已产出 finding",
          sender: agent,
          timestamp: "2026-04-22T00:00:00.000Z",
          completedAt: "2026-04-22T00:00:00.000Z",
          error: null,
          raw: null,
        },
      };
    }

    throw new Error("测试在验证 dispatch 窗口后主动终止后续执行。");
  };

  const compiled = compileTeamDsl(readBuiltinTopologyJson("vulnerability-team.topology.json"));
  await orchestrator.applyTeamDsl({
    cwd: projectPath,
    compiled,
  });

  const task = await orchestrator.submitTask({
    cwd: projectPath,
    content: "@初筛 请分析这个漏洞线索",
    mentionAgent: "初筛",
  });

  const runtimeAgentName = await waitForValue(
    async () => {
      const dispatchMessage = typed.store.listMessages(projectPath, task.task.id).findLast(
        (message) => message.kind === "agent-dispatch" && message.sender === "初筛",
      );
      return dispatchMessage && isAgentDispatchMessageRecord(dispatchMessage)
        ? getMessageTargetAgentIds(dispatchMessage)[0] ?? null
        : null;
    },
    (value) => typeof value === "string" && value.startsWith("反方-"),
    3000,
  );

  assert.equal(typeof runtimeAgentName, "string");
  assert.equal(
    typed.store.listTaskAgents(projectPath, task.task.id).some((agent) => agent.name === runtimeAgentName),
    false,
  );

  const snapshotDuringDispatchWindow = await orchestrator.getTaskSnapshot(task.task.id, projectPath);

  assert.notEqual(snapshotDuringDispatchWindow.task.status, "finished");
  assert.equal(
    typed.store.listMessages(projectPath, task.task.id).some(
      (message) => message.kind === "task-completed" && message.status === "finished",
    ),
    false,
  );
  assert.equal(typed.store.getTask(projectPath, task.task.id).status, "running");

  releaseGitSummary("");
  const settledSnapshot = await waitForTaskSnapshot(
    orchestrator,
    task.task.id,
    (current) => current.task.status === "failed",
    3000,
  );
  assert.equal(settledSnapshot.task.status, "failed");
});

test("initializeTask reuses a preallocated task id when provided", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(orchestrator);

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build"], "Build");
  const task = await orchestrator.initializeTask({
    cwd: project.cwd,
    title: "demo",
    taskId: "task-preallocated",
  });

  assert.equal(task.task.id, "task-preallocated");
});

test("getTaskSnapshot 在新的 Orchestrator 进程里不会再按 taskId 恢复跨进程任务", async () => {
  const userDataPath = createTempDir();
  const workspacePath = createTempDir();

  const writer = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(writer);

  let workspace = await writer.getWorkspaceSnapshot(workspacePath);
  workspace = await replaceWorkspaceAgents(writer, workspace.cwd, [
    { name: "Build", prompt: TEST_AGENT_PROMPTS["Build"] ?? "", isWritable: true },
    { name: "BA", prompt: TEST_AGENT_PROMPTS["BA"] ?? "" },
  ]);

  const created = await writer.initializeTask({
    cwd: workspace.cwd,
    title: "跨工作区 show",
  });
  const taskId = created.task.id;

  await writer.dispose();
  activeOrchestrators.delete(writer);

  const reader = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(reader);

  await assert.rejects(
    () => reader.getTaskSnapshot(taskId, createTempDir()),
    /Task .* not found/,
  );
});

test("task init 不会追加额外系统提醒", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(orchestrator);

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build"]);
  const task = await orchestrator.initializeTask({ cwd: project.cwd, title: "demo" });

  assert.equal(task.messages.some((message) => message.kind === undefined), false);
});

test("buildProjectGitDiffSummary 在系统没有 git 时返回空字符串", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const originalPath = process.env["PATH"];
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  process.env["PATH"] = createTempDir();

  try {
    const summary = await (
      orchestrator as unknown as {
        buildProjectGitDiffSummary(cwd: string): Promise<string>;
      }
    ).buildProjectGitDiffSummary(projectPath);

    assert.equal(summary, "");
  } finally {
    process.env["PATH"] = originalPath;
  }
});

test("buildProjectGitDiffSummary 在非 Git 工作区时返回空字符串", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  const summary = await (
    orchestrator as unknown as {
      buildProjectGitDiffSummary(cwd: string): Promise<string>;
    }
  ).buildProjectGitDiffSummary(projectPath);

  assert.equal(summary, "");
});

test("OpenCode 事件会触发 runtime-updated 前端事件", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: true,
    runtimeRefreshDebounceMs: 1,
  });
  const sentEvents: unknown[] = [];
  const unsubscribe = orchestrator.subscribe((event) => {
    sentEvents.push(event);
  });

  let eventHandler: (event: unknown) => void = () => undefined;
  const typed = orchestrator as unknown as Orchestrator & {
    opencodeClient: {
      connectEvents: (projectPath: string, onEvent: (event: unknown) => void) => Promise<void>;
      createSession: (projectPath: string, title: string) => Promise<string>;
      getAttachBaseUrl: (projectPath: string) => Promise<string>;
    };
  };
  typed.opencodeClient.connectEvents = async (_projectPath, onEvent) => {
    eventHandler = onEvent as (event: unknown) => void;
  };
  typed.opencodeClient.createSession = async (_projectPath, title) => `session:${title}`;
  typed.opencodeClient.getAttachBaseUrl = async () => "http://127.0.0.1:43127";

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build"]);
  const task = await orchestrator.initializeTask({ cwd: project.cwd, title: "demo" });
  eventHandler({
    type: "session.updated",
    properties: {
      sessionID: "session-build-1",
    },
  });
  const runtimeUpdatedEvent = await waitForValue(
    async () =>
      sentEvents.find(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          (event as { type?: string }).type === "runtime-updated",
      ),
    (event) => event !== undefined,
    500,
  ) as {
    type: string;
    cwd: string;
    payload?: { taskId?: string; sessionId?: string | null };
  };

  assert.notEqual(runtimeUpdatedEvent, undefined);
  assert.equal(runtimeUpdatedEvent?.cwd, project.cwd);
  assert.equal(runtimeUpdatedEvent?.payload?.taskId, task.task.id);
  assert.equal(runtimeUpdatedEvent?.payload?.sessionId, "session-build-1");
  unsubscribe();
});

test("dispose 之后，迟到结束的 event stream 不会再排 reconnect 定时器", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: true,
  });
  const typed = orchestrator as unknown as Orchestrator & {
    opencodeClient: {
      connectEvents: (projectPath: string, onEvent: (event: unknown) => void) => Promise<void>;
    };
    pendingEventReconnects: Map<string, ReturnType<typeof setTimeout>>;
  };

  let releaseConnectEvents: () => void = () => undefined;
  typed.opencodeClient.connectEvents = async () =>
    new Promise<void>((resolve) => {
      releaseConnectEvents = resolve;
    });

  await orchestrator.getWorkspaceSnapshot(projectPath);
  await orchestrator.dispose();
  releaseConnectEvents();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(typed.pendingEventReconnects.size, 0);
});

test("dispose 在 CLI 快速退出模式下不会等待悬挂的后台 task promise", async () => {
  const userDataPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  const typed = orchestrator as unknown as Orchestrator & {
    pendingTaskRuns: Set<Promise<void>>;
    opencodeClient: {
      shutdown: () => Promise<{ killedPids: number[] }>;
    };
  };

  let shutdownCalled = false;
  typed.opencodeClient.shutdown = async () => {
    shutdownCalled = true;
    return {
      killedPids: [43127],
    };
  };
  typed.pendingTaskRuns.add(new Promise<void>(() => undefined));

  const disposePromise = orchestrator.dispose({
    awaitPendingTaskRuns: false,
  });
  const completed = await Promise.race([
    disposePromise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
  ]);

  assert.equal(completed, true);
  assert.equal(shutdownCalled, true);
});

test("dispose 会把 OpenCode 清理报告向上返回", async () => {
  const userDataPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  const typed = orchestrator as unknown as Orchestrator & {
    opencodeClient: {
      shutdown: () => Promise<{ killedPids: number[] }>;
    };
  };

  typed.opencodeClient.shutdown = async () => ({
    killedPids: [43127, 5120],
  });

  const report = await orchestrator.dispose();

  assert.deepEqual(report, {
    killedPids: [43127, 5120],
  });
});

test("未应用团队 DSL 时，Project 不再暴露可手工编辑的 agents 配置", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  const project = await orchestrator.getWorkspaceSnapshot(projectPath);

  assert.deepEqual(project.agents, []);
});

test("Build 只有在团队 DSL 中声明后才会出现在 agents", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  const project = await orchestrator.getWorkspaceSnapshot(projectPath);
  assert.equal(project.agents.some((agent) => agent.name === "Build"), false);

  const withBuild = await addBuiltinAgents(orchestrator, project.cwd, ["Build"], "Build");
  assert.equal(withBuild.agents.some((agent) => agent.name === "Build"), true);
  assert.equal(withBuild.agents.find((agent) => agent.name === "Build")?.isWritable, true);
  assert.equal(buildInjectedConfigFromAgents(withBuild.agents), null);
});

test("applyTeamDsl 会一次性写入当前 Project 的 agents 与 topology", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  const project = await orchestrator.getWorkspaceSnapshot(projectPath);
  const compiled = compileTeamDsl({
    entry: "BA",
    nodes: [
      {
        type: "agent",
        name: "Build",
        prompt: "",
        writable: true,
      },
      {
        type: "agent",
        name: "BA",
        prompt: TEST_AGENT_PROMPTS["BA"] ?? "",
        writable: false,
      },
      {
        type: "agent",
        name: "SecurityResearcher",
        prompt: "你负责漏洞挖掘。",
        writable: false,
      },
    ],
    links: [
      { from: "BA", to: "Build", trigger_type: "transfer", message_type: "last" },
      { from: "Build", to: "SecurityResearcher", trigger_type: "transfer", message_type: "last" },
      { from: "SecurityResearcher", to: "Build", trigger_type: "continue", message_type: "last" },
    ],
  });

  const updated = await orchestrator.applyTeamDsl({
    cwd: project.cwd,
    compiled,
  });

  assert.deepEqual(
    updated.agents.map((agent) => agent.name).sort(),
    ["BA", "Build", "SecurityResearcher"],
  );
  assert.equal(
    updated.agents.find((agent) => agent.name === "SecurityResearcher")?.prompt,
    "你负责漏洞挖掘。",
  );
  assert.deepEqual(updated.topology.edges, [
    { source: "BA", target: "Build", triggerOn: "transfer", messageMode: "last" },
    { source: "Build", target: "SecurityResearcher", triggerOn: "transfer", messageMode: "last" },
    {
      source: "SecurityResearcher",
      target: "Build",
      triggerOn: "continue",
      messageMode: "last",
      maxRevisionRounds: 4,
    },
  ]);
});

test("applyTeamDsl 会直接以 DSL prompt 为唯一真源", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  const project = await orchestrator.getWorkspaceSnapshot(projectPath);

  const compiled = compileTeamDsl({
    entry: "BA",
    nodes: [
      {
        type: "agent",
        name: "BA",
        prompt: "DSL BA prompt",
        writable: false,
      },
      {
        type: "agent",
        name: "Build",
        prompt: "",
        writable: true,
      },
    ],
    links: [
      { from: "BA", to: "Build", trigger_type: "transfer", message_type: "last" },
    ],
  });

  const updated = await orchestrator.applyTeamDsl({
    cwd: project.cwd,
    compiled,
  });

  assert.equal(
    updated.agents.find((agent) => agent.name === "BA")?.prompt,
    "DSL BA prompt",
  );
});

test("保存拓扑后不会再生成旧工作区快照文件", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build"], "Build");
  project = await addCustomAgent(orchestrator, project.cwd, "BA", "你是 BA。");

  const saved = await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["BA", "Build"],
      edges: [{ source: "BA", target: "Build", triggerOn: "transfer", messageMode: "last" }],
    },
  });

  assert.equal(Object.prototype.hasOwnProperty.call(saved.topology, "startAgentId"), false);
  assert.equal(fs.existsSync(path.join(projectPath, ".agent-team", LEGACY_WORKSPACE_STATE_BASENAME)), false);
});

test("保存拓扑后会把动态 spawn 团队配置保留在当前运行时快照里", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build"]);
  project = await addCustomAgent(orchestrator, project.cwd, "初筛", "你是初筛。");
  project = await addCustomAgent(orchestrator, project.cwd, "正方模板", "你是正方。");
  project = await addCustomAgent(orchestrator, project.cwd, "反方模板", "你是反方。");
  project = await addCustomAgent(orchestrator, project.cwd, "Summary模板", "你是总结。");

  const saved = await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["Build", "初筛", "正方模板", "反方模板", "Summary模板"],
      edges: [{ source: "Build", target: "初筛", triggerOn: "transfer", messageMode: "last" }],
      nodeRecords: [
        { id: "Build", kind: "agent", templateName: "Build" },
        { id: "初筛", kind: "agent", templateName: "初筛" },
        { id: "正方模板", kind: "agent", templateName: "正方模板" },
        { id: "反方模板", kind: "agent", templateName: "反方模板" },
        { id: "Summary模板", kind: "agent", templateName: "Summary模板" },
        { id: "疑点辩论工厂", kind: "spawn", templateName: "正方模板", spawnRuleId: "finding-debate" },
      ],
      spawnRules: [
        {
	          id: "finding-debate",
	          name: "漏洞疑点辩论",
	          sourceTemplateName: "初筛",
	          entryRole: "pro",
          spawnedAgents: [
            { role: "pro", templateName: "正方模板" },
            { role: "con", templateName: "反方模板" },
            { role: "summary", templateName: "Summary模板" },
          ],
          edges: [
            { sourceRole: "pro", targetRole: "con", triggerOn: "continue", messageMode: "last" },
            { sourceRole: "con", targetRole: "pro", triggerOn: "continue", messageMode: "last" },
            { sourceRole: "pro", targetRole: "summary", triggerOn: "complete", messageMode: "last" },
            { sourceRole: "con", targetRole: "summary", triggerOn: "complete", messageMode: "last" },
          ],
          exitWhen: "one_side_agrees",
          reportToTemplateName: "初筛",
        },
      ],
    },
  });

  assert.equal(saved.topology.spawnRules?.length, 1);
  assert.equal(saved.topology.nodeRecords?.some((node) => node.kind === "spawn"), true);
  const reloaded = await orchestrator.getWorkspaceSnapshot(project.cwd);
  assert.equal(reloaded.topology.spawnRules?.[0]?.id, "finding-debate");
  assert.equal(
    reloaded.topology.nodeRecords?.some((node) => node.id === "疑点辩论工厂" && node.kind === "spawn"),
    true,
  );
  assert.equal(fs.existsSync(path.join(projectPath, ".agent-team", LEGACY_WORKSPACE_STATE_BASENAME)), false);
});

test("保存拓扑后会保留 spawnEnabled 标记，避免 GUI 点击后回读丢失", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build"]);
  project = await addCustomAgent(orchestrator, project.cwd, "UnitTest", "你是 UnitTest。");
  project = await addCustomAgent(orchestrator, project.cwd, "BA", "你是 BA。");

  const saved = await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["Build", "UnitTest", "BA"],
      edges: [{ source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" }],
      nodeRecords: [
        { id: "Build", kind: "agent", templateName: "Build" },
        { id: "UnitTest", kind: "spawn", templateName: "UnitTest", spawnRuleId: "spawn-rule:UnitTest", spawnEnabled: true },
        { id: "BA", kind: "agent", templateName: "BA" },
      ],
      spawnRules: [
        {
	          id: "spawn-rule:UnitTest",
	          name: "UnitTest",
	          sourceTemplateName: "Build",
	          entryRole: "entry",
          spawnedAgents: [
            { role: "entry", templateName: "UnitTest" },
          ],
          edges: [],
          exitWhen: "one_side_agrees",
          reportToTemplateName: "UnitTest",
        },
      ],
    },
  });

  assert.equal(
    saved.topology.nodeRecords?.find((node) => node.id === "UnitTest")?.spawnEnabled,
    true,
  );

  const rehydrated = await orchestrator.getWorkspaceSnapshot(project.cwd);
  assert.equal(
    rehydrated.topology.nodeRecords?.find((node) => node.id === "UnitTest")?.spawnEnabled,
    true,
  );
});

test("为不同 Project 初始化 Task 时会切换 OpenCode 注入配置", async () => {
  const userDataPath = createTempDir();
  const projectAPath = createTempDir();
  const projectBPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  const typed = orchestrator as unknown as Orchestrator & {
    opencodeClient: {
      setInjectedConfigContent: (projectPath: string, content: string | null) => void;
      createSession: (projectPath: string, title: string) => Promise<string>;
      getAttachBaseUrl: (projectPath: string) => Promise<string>;
    };
  };

  const injectedConfigs: string[] = [];
  typed.opencodeClient.setInjectedConfigContent = (_projectPath, content) => {
    injectedConfigs.push(content ?? "null");
  };
  typed.opencodeClient.createSession = async (_projectPath, title) => `session:${title}`;
  typed.opencodeClient.getAttachBaseUrl = async () => "http://127.0.0.1:43127";

  const projectA = await orchestrator.getWorkspaceSnapshot(projectAPath);
  await addCustomAgent(orchestrator, projectA.cwd, "BA", "你是 BA。\n只做需求分析。");
  let projectB = await orchestrator.getWorkspaceSnapshot(projectBPath);
  projectB = await addBuiltinAgents(orchestrator, projectB.cwd, ["Build"]);

  await orchestrator.initializeTask({ cwd: projectB.cwd, title: "project-b" });
  await orchestrator.initializeTask({ cwd: projectA.cwd, title: "project-a" });

  assert.equal(injectedConfigs.length >= 2, true);
  assert.equal(
    injectedConfigs.includes(
      "null",
    ),
    true,
  );
  assert.deepEqual(parseInjectedConfig(injectedConfigs.at(-1)).agent?.["BA"], {
    mode: "primary",
    prompt: "你是 BA。\n只做需求分析。",
    permission: {
      write: "deny",
      edit: "deny",
      bash: "deny",
      task: "deny",
      patch: "deny",
    },
  });
});

test("openAgentTerminal 会通过服务端终端启动器 attach 到对应 session", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const launches: Array<{ cwd: string; command: string }> = [];
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
    terminalLauncher: async (input) => {
      launches.push(input);
    },
  });

  stubOpenCodeSessions(orchestrator);
  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build"]);
  const task = await orchestrator.initializeTask({ cwd: project.cwd, title: "demo" });

  await orchestrator.openAgentTerminal({
    cwd: project.cwd,
    taskId: task.task.id,
    agentName: "Build",
  });

  assert.deepEqual(launches, [
    {
      cwd: project.cwd,
      command: buildCliOpencodeAttachCommand(
        "http://127.0.0.1:43127",
        "session:demo:Build",
      ),
    },
  ]);
});

test("新的 Orchestrator 进程里不会再从旧工作区快照恢复 task attach session", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const writer = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(writer);

  let project = await writer.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(writer, project.cwd, ["Build"]);
  const created = await writer.initializeTask({ cwd: project.cwd, title: "demo" });

  assert.equal(created.agents[0]?.opencodeSessionId, "session:demo:Build");

  const reloaded = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  await assert.rejects(
    () => reloaded.getTaskSnapshot(created.task.id, project.cwd),
    /Task .* not found/,
  );
});

test("未写入 Build 时当前 Project 可以没有可写 Agent", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  const project = await orchestrator.getWorkspaceSnapshot(projectPath);
  await addCustomAgent(orchestrator, project.cwd, "BA", "你是 BA。");

  const injected = buildInjectedConfigFromAgents((await orchestrator.getWorkspaceSnapshot(project.cwd)).agents);
  assert.deepEqual(parseInjectedConfig(injected).agent?.["BA"], {
    mode: "primary",
    prompt: "你是 BA。",
    permission: {
      write: "deny",
      edit: "deny",
      bash: "deny",
      task: "deny",
      patch: "deny",
    },
  });
});

test("Build 与其他显式可写 Agent 可以同时保持可写", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build"], "Build");
  project = await addCustomAgent(orchestrator, project.cwd, "BA", "你是 BA。", true);

  assert.deepEqual(
    project.agents.map((agent) => [agent.name, agent.isWritable === true]),
    [
      ["Build", true],
      ["BA", true],
    ],
  );

  assert.equal(buildInjectedConfigFromAgents(project.agents), null);
});

test("多个自定义 Agent 可以同时保持可写", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addCustomAgent(orchestrator, project.cwd, "BA", "你是 BA。", true);
  project = await addCustomAgent(orchestrator, project.cwd, "QA", "你是 QA。", true);

  assert.deepEqual(
    project.agents.map((agent) => [agent.name, agent.isWritable === true]),
    [
      ["BA", true],
      ["QA", true],
    ],
  );
});

test("下游结构化 prompt 会使用 Initial Task 与真实来源 Agent 段标题", async () => {
  const orchestrator = createTestOrchestrator({
    userDataPath: createTempDir(),
    enableEventStream: false,
  });

  const typed = orchestrator as unknown as Orchestrator & {
    buildAgentExecutionPrompt: (prompt: {
      mode: "structured";
      from: string;
      userMessage?: string;
      agentMessage?: string;
      gitDiffSummary?: string;
    }) => string;
  };

  const prompt = typed.buildAgentExecutionPrompt({
    mode: "structured",
    from: "BA",
    userMessage: "在当前项目的一个临时文件中实现一个加法工具，调用后传入 a 和 b，返回 c",
    agentMessage: "这里应该是真实的 AGENT 名称，而不是 at 一个来源，要换成真实的名称。",
    gitDiffSummary: "当前项目 Git Diff 精简摘要：\n工作区状态：\nM src/runtime/orchestrator.ts",
  });

  assert.match(prompt, /\[Initial Task\]/);
  assert.match(prompt, /\[From BA Agent\]/);
  assert.doesNotMatch(prompt, /\[@来源 Agent Message\]/);
  assert.match(prompt, /\[Project Git Diff Summary\]/);
  assert.doesNotMatch(prompt, /\[Requeirement\]/);
});

test("handoff 边配置为 none 时，下游 structured prompt 保留结构化标题，但正文改为 continue", async () => {
  const orchestrator = createTestOrchestrator({
    userDataPath: createTempDir(),
    enableEventStream: false,
  });

  const typed = orchestrator as unknown as Orchestrator & {
    getEdgeMessageMode: (
      topology: {
        edges: Array<{
          source: string;
          target: string;
          triggerOn: "transfer" | "complete" | "continue";
          messageMode: "none" | "last" | "all";
        }>;
      },
      sourceAgentId: string,
      targetAgentId: string,
      triggerOn: "transfer" | "complete" | "continue_request",
    ) => "none" | "last" | "all";
    buildAgentExecutionPrompt: (prompt: {
      mode: "structured";
      from: string;
      userMessage?: string;
      agentMessage?: string;
      gitDiffSummary?: string;
    }) => string;
  };

  const messageMode = typed.getEdgeMessageMode(
    {
      edges: [
        {
          source: "初筛",
          target: "疑点辩论",
          triggerOn: "transfer",
          messageMode: "none",
        },
      ],
    },
    "初筛",
    "疑点辩论",
    "transfer",
  );

  assert.equal(messageMode, "none");

  const prompt = typed.buildAgentExecutionPrompt({
    mode: "structured",
    from: "初筛",
    userMessage: "请分析这个可疑点。",
    agentMessage: "continue",
  });

  assert.match(prompt, /\[Initial Task\]/);
  assert.match(prompt, /\[From 初筛 Agent\]/);
  assert.match(prompt, /continue/);
  assert.doesNotMatch(prompt, /这里是上一条完整正文/);
});

test("getEdgeMessageMode 支持读取运行时实例边的 messageMode", () => {
  const orchestrator = createTestOrchestrator({
    userDataPath: createTempDir(),
    enableEventStream: false,
  });

  const typed = orchestrator as unknown as Orchestrator & {
    getEdgeMessageMode: (
      topology: {
        edges: Array<{
          source: string;
          target: string;
          triggerOn: "transfer" | "complete" | "continue";
          messageMode: "none" | "last" | "all";
        }>;
      },
      sourceAgentId: string,
      targetAgentId: string,
      triggerOn: "transfer" | "complete" | "continue_request",
    ) => "none" | "last" | "all";
  };

  const messageMode = typed.getEdgeMessageMode(
    {
      edges: [
        {
          source: "初筛",
          target: "反方-1",
          triggerOn: "transfer",
          messageMode: "all",
        },
      ],
    },
    "初筛",
    "反方-1",
    "transfer",
  );

  assert.equal(messageMode, "all");
});

test("getEdgeMessageMode 在运行时实例缺少直连边时，会从模板节点边继承 messageMode", () => {
  const orchestrator = createTestOrchestrator({
    userDataPath: createTempDir(),
    enableEventStream: false,
  });

  const typed = orchestrator as unknown as Orchestrator & {
    getEdgeMessageMode: (
      topology: {
        edges: Array<{
          source: string;
          target: string;
          triggerOn: "transfer" | "complete" | "continue";
          messageMode: "none" | "last" | "all";
        }>;
        nodeRecords?: Array<{
          id: string;
          kind: "agent" | "spawn";
          templateName: string;
        }>;
      },
      sourceAgentId: string,
      targetAgentId: string,
      triggerOn: "transfer" | "complete" | "continue_request",
    ) => "none" | "last" | "all";
  };

  const messageMode = typed.getEdgeMessageMode(
    {
      edges: [
        {
          source: "初筛",
          target: "疑点辩论",
          triggerOn: "transfer",
          messageMode: "all",
        },
      ],
      nodeRecords: [
        {
          id: "反方-1",
          kind: "agent",
          templateName: "疑点辩论",
        },
      ],
    },
    "初筛",
    "反方-1",
    "transfer",
  );

  assert.equal(messageMode, "all");
});

test("只有第一次 Agent 间传递会携带 [Initial Task]", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  const typed = orchestrator as unknown as Orchestrator & {
    opencodeClient: {
      createSession: (projectPath: string, title: string) => Promise<string>;
      reloadConfig: () => Promise<void>;
    };
    opencodeRunner: {
      run: (payload: { agent: string; content: string }) => Promise<OpenCodeExecutionResult>;
    };
  };
  stubOpenCodeAttachBaseUrl(orchestrator);

  const promptByAgent = new Map<string, string[]>();
  const recordPrompt = (agent: string, content: string) => {
    const current = promptByAgent.get(agent) ?? [];
    current.push(content);
    promptByAgent.set(agent, current);
  };
  const completedResponse = (agent: string, content: string) =>
    buildCompletedExecutionResult({
      agent,
      finalMessage: content,
      messageId: `message:${agent}:${(promptByAgent.get(agent) ?? []).length}`,
      timestamp: "2026-04-15T00:00:00.000Z",
    });

  typed.opencodeClient.createSession = async (_projectPath, title) => `session:${title}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async ({ agent, content }) => {
    recordPrompt(agent, content);
    if (agent === "BA") {
      return completedResponse(agent, "需求已澄清，交给 Build 继续实现。");
    }
    if (agent === "Build") {
      return completedResponse(agent, "构建已完成，交给 QA 继续验证。");
    }
    return completedResponse(agent, "验证已完成。");
  };

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["BA", "Build"]);
  project = await addCustomAgent(orchestrator, project.cwd, "QA", "你是 QA。");
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["BA", "Build", "QA"],
      edges: [
        {
          source: "BA",
          target: "Build",
          triggerOn: "transfer",
          messageMode: "last",
        },
        {
          source: "Build",
          target: "QA",
          triggerOn: "transfer",
          messageMode: "last",
        },
      ],
    },
  });

  const submittedTask = await orchestrator.submitTask({
    cwd: project.cwd,
    content: "@BA 请实现 add 方法，并补充验证说明。",
  });

  await waitForTaskSnapshot(
    orchestrator,
    submittedTask.task.id,
    (current) =>
      current.task.status === "finished"
      && current.agents.every((agent) => agent.runCount === 1),
  );

  assert.match(promptByAgent.get("Build")?.[0] ?? "", /\[Initial Task\]/u);
  assert.match(promptByAgent.get("Build")?.[0] ?? "", /\[From BA Agent\]/u);
  assert.match(promptByAgent.get("QA")?.[0] ?? "", /\[From Build Agent\]/u);
  assert.doesNotMatch(promptByAgent.get("QA")?.[0] ?? "", /\[Initial Task\]/u);
});

test("当前 Project 缺少 Build Agent 时，默认会从 start node 开始，显式 @Build 仍会被拒绝", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(orchestrator);
  const typed = orchestrator as unknown as Orchestrator & {
    opencodeRunner: {
      run: (payload: { agent: string }) => Promise<OpenCodeExecutionResult>;
    };
  };
  typed.opencodeRunner.run = async ({ agent }) =>
    buildCompletedExecutionResult({
      agent,
      finalMessage: `${agent} 已收到任务`,
      messageId: `message:${agent}`,
      timestamp: "2026-04-15T00:00:00.000Z",
    });

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addCustomAgent(orchestrator, project.cwd, "BA", "你是 BA。");

  const submittedTask = await orchestrator.submitTask({
    cwd: project.cwd,
    content: "@BA 请先整理需求。",
  });

  const firstUserMessage = submittedTask.messages.find((message) => message.sender === "user");
  assert.deepEqual(
    firstUserMessage && isUserMessageRecord(firstUserMessage)
      ? getMessageTargetAgentIds(firstUserMessage)
      : [],
    ["BA"],
  );

  const defaultSubmittedTask = await orchestrator.submitTask({
    cwd: project.cwd,
    content: "请先整理需求。",
  });

  const defaultUserMessage = defaultSubmittedTask.messages.findLast((message) => message.sender === "user");
  assert.deepEqual(
    defaultUserMessage && isUserMessageRecord(defaultUserMessage)
      ? getMessageTargetAgentIds(defaultUserMessage)
      : [],
    ["BA"],
  );

  await assert.rejects(async () => orchestrator.submitTask({
    cwd: project.cwd,
    content: "@Build 请先实现需求。",
  }), /@Build 不可用/u);
});

test("单 reviewer 审查失败后会把 action_required 回流给 Build", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  const typed = orchestrator as unknown as Orchestrator & {
    opencodeClient: {
      createSession: (projectPath: string, title: string) => Promise<string>;
      reloadConfig: () => Promise<void>;
    };
    opencodeRunner: {
      run: (payload: { agent: string; content: string }) => Promise<OpenCodeExecutionResult>;
    };
  };
  stubOpenCodeAttachBaseUrl(orchestrator);

  const promptByAgent = new Map<string, string[]>();
  const recordPrompt = (agent: string, content: string) => {
    const current = promptByAgent.get(agent) ?? [];
    current.push(content);
    promptByAgent.set(agent, current);
    return current.length;
  };
  const completedResponse = (agent: string, count: number, content: string) =>
    buildCompletedExecutionResult({
      agent,
      finalMessage: content,
      messageId: `message:${agent}:${count}`,
      timestamp: `2026-04-15T00:00:0${count}.000Z`,
    });

  typed.opencodeClient.createSession = async (_projectPath, title) => `session:${title}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async ({ agent, content }) => {
    const count = recordPrompt(agent, content);
    if (agent === "BA") {
      return completedResponse(agent, count, "需求已澄清，交给 Build 继续实现。");
    }
    if (agent === "Build") {
      return count === 1
        ? completedResponse(agent, count, "构建已完成，交给 CodeReview 审查。")
        : completedResponse(agent, count, "已根据 CodeReview 意见修复完成。");
    }
    return count === 1
        ? completedResponse(
          agent,
          count,
          "审查未通过。\n\n<continue> 请修复构建结果。</continue>",
        )
      : completedResponse(agent, count, "CodeReview 通过。\n\n<complete>同意当前结果。</complete>");
  };

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["BA", "Build", "CodeReview"]);
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["BA", "Build", "CodeReview"],
      edges: [
        {
          source: "BA",
          target: "Build",
          triggerOn: "transfer",
          messageMode: "last",
        },
        {
          source: "Build",
          target: "CodeReview",
          triggerOn: "transfer",
          messageMode: "last",
        },
        {
          source: "CodeReview",
          target: "Build",
          triggerOn: "continue",
          messageMode: "last",
        },
      ],
    },
  });

  const submittedTask = await orchestrator.submitTask({
    cwd: project.cwd,
    content: "@BA 请实现 add 方法，并准备审查修复。",
  });

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
    submittedTask.task.id,
    () =>
      (promptByAgent.get("Build")?.length ?? 0) === 2
      && (promptByAgent.get("CodeReview")?.length ?? 0) === 2,
  );

  assert.equal(snapshot.task.status, "finished");
  assert.match(promptByAgent.get("Build")?.[0] ?? "", /\[Initial Task\]/u);
  assert.match(promptByAgent.get("Build")?.[1] ?? "", /\[From CodeReview Agent\]/u);
  assert.match(promptByAgent.get("Build")?.[1] ?? "", /请修复构建结果/u);
  assert.doesNotMatch(promptByAgent.get("CodeReview")?.[0] ?? "", /\[Initial Task\]/u);
  assert.match(promptByAgent.get("CodeReview")?.[0] ?? "", /\[From Build Agent\]/u);
  assert.equal(promptByAgent.get("Build")?.length, 2);
  assert.equal(promptByAgent.get("CodeReview")?.length, 2);
});

test("审查 Agent 的结构化 prompt 不会混入 Project Git Diff Summary", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  const typed = orchestrator as unknown as Orchestrator & {
    opencodeClient: {
      createSession: (projectPath: string, title: string) => Promise<string>;
      reloadConfig: () => Promise<void>;
    };
    opencodeRunner: {
      run: (payload: { agent: string; content: string }) => Promise<OpenCodeExecutionResult>;
    };
    buildProjectGitDiffSummary: (cwd: string) => Promise<string>;
  };
  stubOpenCodeAttachBaseUrl(orchestrator);

  const completedResponse = (agent: string, count: number, content: string) =>
    buildCompletedExecutionResult({
      agent,
      finalMessage: content,
      messageId: `message:${agent}:${count}`,
      timestamp: `2026-04-15T00:01:${String(count).padStart(2, "0")}.000Z`,
    });
  const promptByAgent = new Map<string, string[]>();
  const recordPrompt = (agent: string, content: string) => {
    const current = promptByAgent.get(agent) ?? [];
    current.push(content);
    promptByAgent.set(agent, current);
    return current.length;
  };

  typed.opencodeClient.createSession = async (_projectPath, title) => `session:${title}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.buildProjectGitDiffSummary = async () => "当前项目 Git Diff 精简摘要：\n工作区状态：\nM .opencode/temp-add.js";
  typed.opencodeRunner.run = async ({ agent, content }) => {
    const count = recordPrompt(agent, content);
    if (agent === "BA") {
      return completedResponse(agent, count, "需求已澄清，交给 Build 继续实现。");
    }
    if (agent === "Build") {
      return completedResponse(agent, count, "Build 已给出最终交付说明。");
    }
    if (agent === "TaskReview") {
      assert.doesNotMatch(content, /\[Project Git Diff Summary\]/u);
      assert.match(content, /\[From Build Agent\]/u);
      return completedResponse(agent, count, "TaskReview 通过。\n\n<complete>同意当前结果。</complete>");
    }
    assert.match(content, /\[Project Git Diff Summary\]/u);
    return completedResponse(agent, count, "Ops 已收到 Git Diff 上下文。");
  };

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["BA", "Build", "TaskReview"]);
  project = await addCustomAgent(orchestrator, project.cwd, "Ops", "你是普通执行下游。");
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["BA", "Build", "TaskReview", "Ops"],
      edges: [
        {
          source: "BA",
          target: "Build",
          triggerOn: "transfer",
          messageMode: "last",
        },
        {
          source: "Build",
          target: "TaskReview",
          triggerOn: "transfer",
          messageMode: "last",
        },
        {
          source: "Build",
          target: "Ops",
          triggerOn: "transfer",
          messageMode: "last",
        },
        {
          source: "TaskReview",
          target: "Build",
          triggerOn: "continue",
          messageMode: "last",
        },
      ],
    },
  });

  const submittedTask = await orchestrator.submitTask({
    cwd: project.cwd,
    content: "@BA 请整理并交付当前实现。",
  });

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
    submittedTask.task.id,
    (current) =>
      current.task.status === "finished"
      && (promptByAgent.get("TaskReview")?.length ?? 0) === 1
      && (promptByAgent.get("Ops")?.length ?? 0) === 1,
  );

  assert.equal(snapshot.task.status, "finished");
  assert.equal(promptByAgent.get("TaskReview")?.length, 1);
  assert.equal(promptByAgent.get("Ops")?.length, 1);
});

test("修复首个失败 reviewer 后，Build 下一轮不会立刻全量重派全部 reviewer", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  const typed = orchestrator as unknown as Orchestrator & {
    opencodeClient: {
      createSession: (projectPath: string, title: string) => Promise<string>;
      reloadConfig: () => Promise<void>;
    };
    opencodeRunner: {
      run: (payload: { agent: string; content: string }) => Promise<OpenCodeExecutionResult>;
    };
  };
  stubOpenCodeAttachBaseUrl(orchestrator);

  const completedResponse = (agent: string, count: number, content: string) =>
    buildCompletedExecutionResult({
      agent,
      finalMessage: content,
      messageId: `message:${agent}:${count}`,
      timestamp: `2026-04-16T00:01:${String(count).padStart(2, "0")}.000Z`,
    });

  let buildRunCount = 0;
  let unitTestRunCount = 0;
  let taskReviewRunCount = 0;
  let codeReviewRunCount = 0;
  let releaseUnitTestSecondRun: () => void = () => undefined;
  let releaseTaskReviewSecondRun: () => void = () => undefined;
  let releaseCodeReviewSecondRun: () => void = () => undefined;
  const unitTestSecondRunGate = new Promise<void>((resolve) => {
    releaseUnitTestSecondRun = resolve;
  });
  const taskReviewSecondRunGate = new Promise<void>((resolve) => {
    releaseTaskReviewSecondRun = resolve;
  });
  const codeReviewSecondRunGate = new Promise<void>((resolve) => {
    releaseCodeReviewSecondRun = resolve;
  });

  typed.opencodeClient.createSession = async (_projectPath, title) => `session:${title}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async ({ agent }) => {
    if (agent === "Build") {
      buildRunCount += 1;
      return buildRunCount === 1
        ? completedResponse(agent, buildRunCount, "Build 第 1 轮实现完成。")
        : completedResponse(agent, buildRunCount, "Build 已修复 UnitTest 的问题。");
    }
    if (agent === "UnitTest") {
      unitTestRunCount += 1;
      if (unitTestRunCount === 1) {
        return completedResponse(
          agent,
          unitTestRunCount,
          "UnitTest 第 1 轮未通过。\n\n<continue>请修复 UnitTest 第 1 轮问题。</continue>",
        );
      }
      await unitTestSecondRunGate;
      return completedResponse(agent, unitTestRunCount, "UnitTest: ok\n\n<complete>同意当前结果。</complete>");
    }
    if (agent === "TaskReview") {
      taskReviewRunCount += 1;
      if (taskReviewRunCount === 1) {
        return completedResponse(
          agent,
          taskReviewRunCount,
          "TaskReview 第 1 轮未通过。\n\n<continue>请修复 TaskReview 第 1 轮问题。</continue>",
        );
      }
      await taskReviewSecondRunGate;
      return completedResponse(agent, taskReviewRunCount, "TaskReview: ok\n\n<complete>同意当前结果。</complete>");
    }
    codeReviewRunCount += 1;
    if (codeReviewRunCount === 1) {
      return completedResponse(
        agent,
        codeReviewRunCount,
        "CodeReview 第 1 轮未通过。\n\n<continue>请修复 CodeReview 第 1 轮问题。</continue>",
      );
    }
    await codeReviewSecondRunGate;
    return completedResponse(agent, codeReviewRunCount, "CodeReview: ok\n\n<complete>同意当前结果。</complete>");
  };

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(
    orchestrator,
    project.cwd,
    ["Build", "UnitTest", "TaskReview", "CodeReview"],
  );
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
      edges: [
        { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
        { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
        { source: "Build", target: "CodeReview", triggerOn: "transfer", messageMode: "last" },
        { source: "UnitTest", target: "Build", triggerOn: "continue", messageMode: "last" },
        { source: "TaskReview", target: "Build", triggerOn: "continue", messageMode: "last" },
        { source: "CodeReview", target: "Build", triggerOn: "continue", messageMode: "last" },
      ],
    },
  });

  const submittedTask = await orchestrator.submitTask({
    cwd: project.cwd,
    content: "@Build 请完成这个需求。",
  });

  try {
    await waitForValue(
      () => ({
        buildRunCount,
        unitTestRunCount,
        taskReviewRunCount,
        codeReviewRunCount,
      }),
      (counts) => counts.buildRunCount === 2 && counts.unitTestRunCount >= 2,
      5000,
    );

    assert.equal(buildRunCount, 2);
    assert.equal(unitTestRunCount, 2);
    assert.equal(
      taskReviewRunCount,
      1,
      "Build 修完 UnitTest 后，不应该立刻把 TaskReview 拉进第 2 轮",
    );
    assert.equal(
      codeReviewRunCount,
      1,
      "Build 修完 UnitTest 后，不应该立刻把 CodeReview 拉进第 2 轮",
    );
  } finally {
    releaseUnitTestSecondRun();
    releaseTaskReviewSecondRun();
    releaseCodeReviewSecondRun();
    await waitForTaskSnapshot(
      orchestrator,
      submittedTask.task.id,
      (snapshot) => isTerminalTaskStatus(snapshot.task.status),
      5000,
    ).catch(() => undefined);
  }
});

test("审查 Agent 返回 action_required 后会在其余 reviewer 收齐后回流到 Build", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  const typed = orchestrator as unknown as Orchestrator & {
    opencodeClient: {
      createSession: (projectPath: string, title: string) => Promise<string>;
      reloadConfig: () => Promise<void>;
    };
    opencodeRunner: {
      run: (payload: { agent: string; content: string }) => Promise<OpenCodeExecutionResult>;
    };
  };
  stubOpenCodeAttachBaseUrl(orchestrator);

  const completedResponse = (agent: string, count: number, content: string) =>
    buildCompletedExecutionResult({
      agent,
      finalMessage: content,
      messageId: `message:${agent}:${count}`,
      timestamp: `2026-04-16T00:00:${String(count).padStart(2, "0")}.000Z`,
    });

  let buildRunCount = 0;
  let unitTestRunCount = 0;
  let taskReviewRunCount = 0;
  let codeReviewRunCount = 0;
  let unitTestStarted = false;
  let taskReviewStarted = false;
  let codeReviewStarted = false;
  const buildPrompts: string[] = [];
  let releaseUnitTest: () => void = () => undefined;
  let releaseTaskReview: () => void = () => undefined;
  let releaseCodeReview: () => void = () => undefined;
  const unitTestGate = new Promise<void>((resolve) => {
    releaseUnitTest = resolve;
  });
  const taskReviewGate = new Promise<void>((resolve) => {
    releaseTaskReview = resolve;
  });
  const codeReviewGate = new Promise<void>((resolve) => {
    releaseCodeReview = resolve;
  });

  typed.opencodeClient.createSession = async (_projectPath, title) => `session:${title}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async ({ agent, content }) => {
    if (agent === "Build") {
      buildRunCount += 1;
      buildPrompts.push(content);
      return buildRunCount === 1
        ? completedResponse(agent, buildRunCount, "Build 第 1 轮实现完成。")
        : completedResponse(agent, buildRunCount, "Build 已修复 UnitTest 的问题。");
    }
    if (agent === "UnitTest") {
      unitTestRunCount += 1;
      if (unitTestRunCount === 1) {
        unitTestStarted = true;
        await unitTestGate;
      }
      return unitTestRunCount === 1
        ? completedResponse(
            agent,
            unitTestRunCount,
            "UnitTest 第 1 轮未通过。\n\n<continue> 请修复第 1 轮单测问题。</continue>",
          )
        : completedResponse(agent, unitTestRunCount, "UnitTest: ok\n\n<complete>同意当前结果。</complete>");
    }
    if (agent === "TaskReview") {
      taskReviewRunCount += 1;
      if (taskReviewRunCount === 1) {
        taskReviewStarted = true;
        await taskReviewGate;
      }
      return completedResponse(agent, taskReviewRunCount, "TaskReview: ok\n\n<complete>同意当前结果。</complete>");
    }
    codeReviewRunCount += 1;
    if (codeReviewRunCount === 1) {
      codeReviewStarted = true;
      await codeReviewGate;
    }
    return completedResponse(agent, codeReviewRunCount, "CodeReview: ok\n\n<complete>同意当前结果。</complete>");
  };

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(
    orchestrator,
    project.cwd,
    ["Build", "UnitTest", "TaskReview", "CodeReview"],
  );
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
      edges: [
        { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
        { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
        { source: "Build", target: "CodeReview", triggerOn: "transfer", messageMode: "last" },
        { source: "UnitTest", target: "Build", triggerOn: "continue", messageMode: "last" },
        { source: "TaskReview", target: "Build", triggerOn: "continue", messageMode: "last" },
        { source: "CodeReview", target: "Build", triggerOn: "continue", messageMode: "last" },
      ],
    },
  });

  const submittedTask = await orchestrator.submitTask({
    cwd: project.cwd,
    content: "@Build 请完成这个需求。",
  });

  await waitForTaskSnapshot(
    orchestrator,
    submittedTask.task.id,
    () => unitTestStarted && taskReviewStarted && codeReviewStarted,
  );

  assert.equal(buildRunCount, 1);
  assert.equal(unitTestStarted, true);
  assert.equal(taskReviewStarted, true);
  assert.equal(codeReviewStarted, true);

  releaseUnitTest();
  const runningSnapshot = await waitForTaskSnapshot(
    orchestrator,
    submittedTask.task.id,
    (snapshot) =>
      snapshot.task.status === "running"
      && unitTestRunCount === 1
      && buildRunCount === 1
      && snapshot.agents.some((agent) => agent.name === "UnitTest" && agent.status === "continue"),
  );
  assert.equal(runningSnapshot.task.status, "running");
  assert.equal(buildRunCount, 1);
  assert.equal(
    runningSnapshot.agents.some((agent) => agent.name === "UnitTest" && agent.status === "continue"),
    true,
  );

  releaseTaskReview();
  releaseCodeReview();

  const settledSnapshot = await waitForTaskSnapshot(
    orchestrator,
    submittedTask.task.id,
    (snapshot) =>
      snapshot.task.status === "finished"
      && buildRunCount === 2
      && unitTestRunCount === 2
      && taskReviewRunCount === 2
      && codeReviewRunCount === 2,
  );
  assert.equal(settledSnapshot.task.status, "finished");
  assert.equal(buildRunCount, 2);
  assert.equal(unitTestRunCount, 2);
  assert.equal(taskReviewRunCount, 2);
  assert.equal(codeReviewRunCount, 2);
  assert.equal(buildPrompts.length, 2);
  assert.match(buildPrompts[1] ?? "", /\[From UnitTest Agent\]/u);
  assert.match(buildPrompts[1] ?? "", /请修复第 1 轮单测问题/u);
});

test("审视类 system prompt 会使用真实来源 Agent 名称", () => {
  const orchestrator = createTestOrchestrator({
    userDataPath: createTempDir(),
    enableEventStream: false,
  });

  const typed = orchestrator as unknown as Orchestrator & {
    createSystemPrompt: (
      agent: { name: string },
      prompt: {
        mode: "structured";
        from: string;
        userMessage?: string;
        agentMessage?: string;
        gitDiffSummary?: string;
      },
      reviewAgent: boolean,
    ) => string;
  };

  const systemPrompt = typed.createSystemPrompt(
    { name: "TaskReview" },
    {
      mode: "structured",
      from: "BA",
      agentMessage: "这里应该替换成真实来源 Agent。",
    },
    true,
  );

  assert.match(systemPrompt, /你需要对 `\[From BA Agent\]` 做出回应。/);
  assert.doesNotMatch(systemPrompt, /\[@来源 Agent Message\]/);
});

test("Task 启动后仍允许重新 applyTeamDsl，让 task run --file 继续以 JSON 为准", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(orchestrator);

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addCustomAgent(orchestrator, project.cwd, "BA", "你是 BA。");
  await orchestrator.initializeTask({ cwd: project.cwd, title: "demo" });
  const reapplied = await replaceWorkspaceAgents(orchestrator, project.cwd, [
    { name: "BA", prompt: "你是新的 BA。" },
    { name: "Build", prompt: "" },
  ]);

  assert.equal(
    reapplied.agents.find((agent) => agent.name === "BA")?.prompt,
    "你是新的 BA。",
  );
  assert.equal(reapplied.agents.some((agent) => agent.name === "Build"), true);
});

test("已完成判定但没有可展示结果正文时返回简洁兜底文案", () => {
  const orchestrator = createTestOrchestrator({
    userDataPath: createTempDir(),
    enableEventStream: false,
  });

  const displayContent = (
    orchestrator as unknown as {
      createDisplayContent: (
        parsedReview: {
          cleanContent: string;
          decision: "complete" | "continue" | "invalid";
          opinion: string | null;
          rawDecisionBlock: string | null;
          validationError: string | null;
        },
        fallbackMessage?: string | null,
      ) => string;
    }
  ).createDisplayContent(
    {
      cleanContent: "",
      decision: "complete",
      opinion: null,
      rawDecisionBlock: null,
      validationError: null,
    },
    null,
  );

  assert.equal(displayContent, "通过");
});

test("单 Agent 且没有下游时，任务结束后仍保留该 Agent 的最终聊天消息", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  const typed = stubOpenCodeSessions(orchestrator) as unknown as Orchestrator & {
    ensureTaskPanels: (task: { id: string; cwd: string }) => Promise<void>;
    ensureAgentSession: (cwd: string, task: { id: string; cwd: string }, agent: { name: string }) => Promise<string>;
    opencodeRunner: {
      run: (input: { agent: string }) => Promise<OpenCodeExecutionResult>;
    };
  };

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addCustomAgent(orchestrator, project.cwd, "BA", "你是 BA。");
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      nodes: ["BA"],
      edges: [],
    },
  });

  typed.ensureTaskPanels = async () => undefined;
  typed.ensureAgentSession = async (_cwd, task, agent) => `session:${task.id}:${agent.name}`;
  typed.opencodeRunner.run = async () =>
    buildCompletedExecutionResult({
      agent: "BA",
      finalMessage: "验证成功。",
      messageId: "msg-single-agent-final",
      timestamp: "2026-04-21T13:10:00.000Z",
    });

  const submittedTask = await orchestrator.submitTask({
    cwd: project.cwd,
    content: "@BA 请输出一句验证成功。",
    mentionAgent: "BA",
  });

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
    submittedTask.task.id,
    (current) => current.task.status === "finished",
    8000,
  );

  const baFinalMessageIndex = snapshot.messages.findIndex(
    (message) => message.sender === "BA" && message.kind === "agent-final",
  );
  const completionMessageIndex = snapshot.messages.findIndex(
    (message) => message.sender === "system" && message.kind === "task-completed",
  );

  assert.notEqual(baFinalMessageIndex, -1);
  assert.notEqual(completionMessageIndex, -1);
  assert.equal(snapshot.messages[baFinalMessageIndex]?.content, "验证成功。");
  assert.equal(baFinalMessageIndex < completionMessageIndex, true);
});

test("继续处理且只返回 action_required 标签时，群聊展示会去掉标签", () => {
  const orchestrator = createTestOrchestrator({
    userDataPath: createTempDir(),
    enableEventStream: false,
  });

  const displayContent = (
    orchestrator as unknown as {
      createDisplayContent: (
        parsedReview: {
          cleanContent: string;
          decision: "complete" | "continue" | "invalid";
          opinion: string | null;
          rawDecisionBlock: string | null;
          validationError: string | null;
        },
        fallbackMessage?: string | null,
      ) => string;
    }
  ).createDisplayContent(
    {
      cleanContent: "",
      decision: "continue",
      opinion: "请继续补充实现依据。",
      rawDecisionBlock: "<continue> 请继续补充实现依据。",
      validationError: null,
    },
    null,
  );

  assert.equal(displayContent, "请继续补充实现依据。");
});

test("继续处理正文包含多个 markdown 标题时，不应只显示最后一个标题章节", () => {
  const orchestrator = createTestOrchestrator({
    userDataPath: createTempDir(),
    enableEventStream: false,
  });

  const cleanContent = `## 我认可的事实
基于已读代码，我认可这些点：
- Stream.receivedEndOfHeaders() 没有把“缺失 serverName”作为结束阶段的硬拒绝条件；

## 但你仍未证明“绕过”成立
你现在的论证仍然有一个跳步：
> “请求进入默认虚拟主机的真实管线”
>  ≠
> “请求绕过了访问控制”

## 结论
所以我仍然维持上一轮的收敛判断：
目前代码证明的是“缺失主机名时回退默认虚拟主机的实现行为”，
但还不足以仅凭源码坐实真实可利用的虚拟主机绕过漏洞。`;

  const displayContent = (
    orchestrator as unknown as {
      createDisplayContent: (
        parsedReview: {
          cleanContent: string;
          decision: "complete" | "continue" | "invalid";
          opinion: string | null;
          rawDecisionBlock: string | null;
          validationError: string | null;
        },
        fallbackMessage?: string | null,
      ) => string;
    }
  ).createDisplayContent(
    {
      cleanContent,
      decision: "continue",
      opinion: "请继续补充实现依据。",
      rawDecisionBlock: "<continue>请继续补充实现依据。</continue>",
      validationError: null,
    },
    null,
  );

  assert.equal(displayContent, cleanContent);
});

test("审查 Agent 未返回合法标签时应标记为 invalid", () => {
  const orchestrator = createTestOrchestrator({
    userDataPath: createTempDir(),
    enableEventStream: false,
  });

  const parsedReview = (
    orchestrator as unknown as {
      parseReview: (
        content: string,
        reviewAgent: boolean,
      ) => {
        cleanContent: string;
        decision: "complete" | "continue" | "invalid";
        opinion: string | null;
        rawDecisionBlock: string | null;
        validationError: string | null;
      };
    }
  ).parseReview("这是普通审查正文，标签写错了。\n\n<chalenge>请继续补充实现依据。</chalenge>", true);

  assert.deepEqual(parsedReview, {
    cleanContent: "这是普通审查正文，标签写错了。\n\n<chalenge>请继续补充实现依据。</chalenge>",
    decision: "invalid",
    opinion: null,
    rawDecisionBlock: null,
    validationError: "审查 Agent 必须用 <complete> 或 <continue> 标签明确给出结论。",
  });
});

test("审视 Agent 执行中止时不会伪造成整改意见", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(orchestrator);
  const typed = orchestrator as unknown as Orchestrator & {
    runAgent: (
      project: { id: string; path: string },
      task: { id: string },
      agentName: string,
      prompt: {
        mode: "structured";
        from: string;
        agentMessage: string;
      },
    ) => Promise<void>;
    opencodeClient: {
      reloadConfig: () => Promise<void>;
    };
    opencodeRunner: {
      run: () => Promise<OpenCodeExecutionResult>;
    };
    ensureTaskPanels: () => Promise<void>;
    ensureAgentSession: () => Promise<string>;
  };

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build", "CodeReview"]);
  const topology = {
    ...project.topology,
    edges: [
      ...project.topology.edges.filter((edge) => edge.source !== "CodeReview"),
      {
        source: "Build",
        target: "CodeReview",
        triggerOn: "transfer" as const,
        messageMode: "last" as const,
      },
      {
        source: "CodeReview",
        target: "Build",
        triggerOn: "continue" as const,
        messageMode: "last" as const,
      },
    ],
  };
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology,
  });
  const task = await orchestrator.initializeTask({ cwd: project.cwd, title: "demo" });

  typed.ensureTaskPanels = async () => undefined;
  typed.ensureAgentSession = async () => "session-code-review";
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async () =>
    buildErrorExecutionResult({
      agent: "CodeReview",
      finalMessage: "Aborted",
      messageId: "msg-aborted",
      timestamp: "2026-04-15T00:00:00.000Z",
      error: "Aborted",
    });

  await typed.runAgent(
    project.cwd,
    task.task,
    "CodeReview",
    {
      mode: "structured",
      from: "Build",
      agentMessage: "请审查本轮改动",
    },
  );

  const snapshot = await orchestrator.getTaskSnapshot(task.task.id);
  assert.equal(snapshot.task.status, "failed");
  assert.equal(
    snapshot.messages.some(
      (message) =>
        message.sender === "CodeReview" &&
        message.kind === "continue-request",
    ),
    false,
  );
  assert.equal(
    snapshot.messages.some(
      (message) => message.content.includes("<continue> Aborted"),
    ),
    false,
  );
  assert.equal(
    snapshot.messages.some(
      (message) => message.content === "[CodeReview] 执行失败：Aborted",
    ),
    true,
  );
});

test("Task 进入 finished 状态时会统一把所有 Agent 节点显示为已完成，并追加结束系统消息", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();

  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  const typed = orchestrator as unknown as Orchestrator & {
    runAgent: (
      cwd: string,
      task: { id: string },
      agentName: string,
      prompt: {
        mode: "raw";
        content: string;
        from: string;
      },
      behavior?: {
        followTopology?: boolean;
      },
    ) => Promise<void>;
    opencodeClient: {
      createSession: (projectPath: string, title: string) => Promise<string>;
      reloadConfig: () => Promise<void>;
    };
    opencodeRunner: {
      run: (payload: { agent: string }) => Promise<OpenCodeExecutionResult>;
    };
    store: {
      updateTaskAgentStatus: (
        cwd: string,
        taskId: string,
        agentName: string,
        status: "idle" | "completed" | "failed" | "running" | "continue",
      ) => void;
    };
  };
  stubOpenCodeAttachBaseUrl(orchestrator);

  typed.opencodeClient.createSession = async (_projectPath, title) => `session:${title}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async ({ agent }) =>
    buildCompletedExecutionResult({
      agent,
      finalMessage: `${agent} 已完成`,
      messageId: `message:${agent}`,
      timestamp: "2026-04-15T00:00:00.000Z",
    });

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build"]);
  project = await addCustomAgent(orchestrator, project.cwd, "QA", "你是 QA。");
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["Build", "QA"],
      edges: [
        {
          source: "Build",
          target: "QA",
          triggerOn: "transfer",
          messageMode: "last",
        },
      ],
    },
  });
  const task = await orchestrator.initializeTask({ cwd: project.cwd, title: "demo" });

  await typed.runAgent(
    project.cwd,
    task.task,
    "Build",
    {
      mode: "raw",
      from: "User",
      content: "先执行 Build",
    },
    {
      followTopology: false,
    },
  );

  let snapshot = await orchestrator.getTaskSnapshot(task.task.id);
  assert.equal(snapshot.task.status, "waiting");

  await typed.runAgent(
    project.cwd,
    task.task,
    "QA",
    {
      mode: "raw",
      from: "User",
      content: "再执行 QA",
    },
    {
      followTopology: false,
    },
  );

  snapshot = await orchestrator.getTaskSnapshot(task.task.id);
  assert.equal(snapshot.task.status, "finished");
  assert.notEqual(snapshot.task.completedAt, null);
  assert.equal(
    snapshot.messages.some(
      (message) =>
        message.sender === "system" &&
        message.kind === "task-completed" &&
        message.status === "finished" &&
        message.content.includes("所有Agent任务已完成"),
    ),
    true,
  );
});

test("最大连续回流达到上限后，聊天页面会直接展示明确失败原因", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();

  let buildRunCount = 0;
  let unitTestRunCount = 0;

  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  const typed = stubOpenCodeSessions(orchestrator) as unknown as Orchestrator & {
    ensureTaskPanels: (cwd: string, taskId: string) => Promise<void>;
    ensureAgentSession: (projectPath: string, taskId: string, agentName: string) => Promise<string>;
    opencodeClient: {
      reloadConfig: () => Promise<void>;
    };
    opencodeRunner: {
      run: (input: { agent: string }) => Promise<OpenCodeExecutionResult>;
    };
  };

  const project = await orchestrator.getWorkspaceSnapshot(projectPath);
  await addBuiltinAgents(orchestrator, project.cwd, ["Build", "UnitTest"], "Build");
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      nodes: ["Build", "UnitTest"],
      edges: [
        { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
        { source: "UnitTest", target: "Build", triggerOn: "continue", messageMode: "last" },
      ],
    },
  });

  const task = await orchestrator.submitTask({
    cwd: project.cwd,
    content: "@Build 请完成需求并通过 UnitTest",
    mentionAgent: "Build",
  });

  typed.ensureTaskPanels = async () => undefined;
  typed.ensureAgentSession = async (_projectPath, _taskId, agentName) => `session:${agentName}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async ({ agent }) => {
    if (agent === "Build") {
      buildRunCount += 1;
      return buildCompletedExecutionResult({
        agent,
        finalMessage: `Build 第 ${buildRunCount} 轮修复完成`,
        messageId: `msg-build-${buildRunCount}`,
        timestamp: "2026-04-19T00:00:00.000Z",
      });
    }

    unitTestRunCount += 1;
    if (unitTestRunCount <= 5) {
      return {
        ...buildCompletedExecutionResult({
          agent,
          finalMessage: `UnitTest 第 ${unitTestRunCount} 轮未通过。\n\n<continue>请修复第 ${unitTestRunCount} 轮问题。</continue>`,
          messageId: `msg-unit-${unitTestRunCount}`,
          timestamp: "2026-04-19T00:00:00.000Z",
        }),
        rawMessage: {
          id: `msg-unit-${unitTestRunCount}`,
          content: `UnitTest 第 ${unitTestRunCount} 轮未通过`,
          sender: agent,
          timestamp: "2026-04-19T00:00:00.000Z",
          completedAt: "2026-04-19T00:00:00.000Z",
          error: null,
          raw: null,
        },
      };
    }

    return {
      ...buildCompletedExecutionResult({
        agent,
        finalMessage: "UnitTest 通过。\n\n<complete>同意当前结果。</complete>",
        messageId: `msg-unit-${unitTestRunCount}`,
        timestamp: "2026-04-19T00:00:00.000Z",
      }),
      rawMessage: {
        id: `msg-unit-${unitTestRunCount}`,
        content: "UnitTest 通过",
        sender: agent,
        timestamp: "2026-04-19T00:00:00.000Z",
        completedAt: "2026-04-19T00:00:00.000Z",
        error: null,
        raw: null,
      },
    };
  };

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
    task.task.id,
    (current) => current.task.status === "failed",
    8000,
  );

  const failedCompletionMessage = snapshot.messages.findLast(
    (message) =>
      message.sender === "system"
      && message.kind === "task-completed"
      && message.status === "failed",
  );

  assert.notEqual(failedCompletionMessage, undefined);
  assert.equal(
    failedCompletionMessage?.content,
    "UnitTest -> Build 已连续交流 4 次，任务已结束",
  );
});

test("聊天页面会按每条 action_required 边的单独上限展示失败原因", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();

  let buildRunCount = 0;
  let unitTestRunCount = 0;

  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  const typed = stubOpenCodeSessions(orchestrator) as unknown as Orchestrator & {
    ensureTaskPanels: (cwd: string, taskId: string) => Promise<void>;
    ensureAgentSession: (projectPath: string, taskId: string, agentName: string) => Promise<string>;
    opencodeClient: {
      reloadConfig: () => Promise<void>;
    };
    opencodeRunner: {
      run: (input: { agent: string }) => Promise<OpenCodeExecutionResult>;
    };
  };

  const project = await orchestrator.getWorkspaceSnapshot(projectPath);
  await addBuiltinAgents(orchestrator, project.cwd, ["Build", "UnitTest"], "Build");
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      nodes: ["Build", "UnitTest"],
      edges: [
        { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
        { source: "UnitTest", target: "Build", triggerOn: "continue", maxRevisionRounds: 2, messageMode: "last" },
      ],
    },
  });

  const task = await orchestrator.submitTask({
    cwd: project.cwd,
    content: "@Build 请完成需求并通过 UnitTest",
    mentionAgent: "Build",
  });

  typed.ensureTaskPanels = async () => undefined;
  typed.ensureAgentSession = async (_projectPath, _taskId, agentName) => `session:${agentName}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async ({ agent }) => {
    if (agent === "Build") {
      buildRunCount += 1;
      return buildCompletedExecutionResult({
        agent,
        finalMessage: `Build 第 ${buildRunCount} 轮修复完成`,
        messageId: `msg-build-limit-${buildRunCount}`,
        timestamp: "2026-04-19T00:00:00.000Z",
      });
    }

    unitTestRunCount += 1;
    return {
      ...buildCompletedExecutionResult({
        agent,
        finalMessage: `UnitTest 第 ${unitTestRunCount} 轮未通过。\n\n<continue>请修复第 ${unitTestRunCount} 轮问题。</continue>`,
        messageId: `msg-unit-limit-${unitTestRunCount}`,
        timestamp: "2026-04-19T00:00:00.000Z",
      }),
      rawMessage: {
        id: `msg-unit-limit-${unitTestRunCount}`,
        content: `UnitTest 第 ${unitTestRunCount} 轮未通过`,
        sender: agent,
        timestamp: "2026-04-19T00:00:00.000Z",
        completedAt: "2026-04-19T00:00:00.000Z",
        error: null,
        raw: null,
      },
    };
  };

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
    task.task.id,
    (current) => current.task.status === "failed",
    8000,
  );

  const failedCompletionMessage = snapshot.messages.findLast(
    (message) =>
      message.sender === "system"
      && message.kind === "task-completed"
      && message.status === "failed",
  );

  assert.notEqual(failedCompletionMessage, undefined);
  assert.equal(
    failedCompletionMessage?.content,
    "UnitTest -> Build 已连续交流 2 次，任务已结束",
  );
});

test("并发审查失败时不会提前追加任务结束系统消息", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();

  let releaseUnitTest: () => void = () => undefined;
  const unitTestGate = new Promise<void>((resolve) => {
    releaseUnitTest = resolve;
  });
  let releaseTaskReview: () => void = () => undefined;
  const taskReviewGate = new Promise<void>((resolve) => {
    releaseTaskReview = resolve;
  });
  let unitTestStarted = false;
  let taskReviewStarted = false;
  let buildRunCount = 0;
  let unitTestRunCount = 0;
  let taskReviewRunCount = 0;

  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  const typed = orchestrator as unknown as Orchestrator & {
    opencodeClient: {
      createSession: (projectPath: string, title: string) => Promise<string>;
      reloadConfig: () => Promise<void>;
    };
    opencodeRunner: {
      run: (payload: { agent: string }) => Promise<OpenCodeExecutionResult>;
    };
  };
  stubOpenCodeAttachBaseUrl(orchestrator);

  typed.opencodeClient.createSession = async (_projectPath, title) => `session:${title}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async ({ agent }) => {
    if (agent === "Build") {
      buildRunCount += 1;
      return buildCompletedExecutionResult({
        agent,
        finalMessage: buildRunCount === 1 ? "Build 已完成" : "Build 已修复 reviewer 意见。",
        messageId: `message:Build:${buildRunCount}`,
        timestamp: `2026-04-17T00:00:0${buildRunCount - 1}.000Z`,
      });
    }

    if (agent === "UnitTest") {
      unitTestRunCount += 1;
      unitTestStarted = true;
      if (unitTestRunCount === 1) {
        await unitTestGate;
      }
      return buildCompletedExecutionResult({
        agent,
        finalMessage:
          unitTestRunCount === 1
            ? "UnitTest 未通过。\n\n<continue>请修复 UnitTest。</continue>"
            : "UnitTest 通过。\n\n<complete>同意当前结果。</complete>",
        messageId: `message:UnitTest:${unitTestRunCount}`,
        timestamp: `2026-04-17T00:00:1${unitTestRunCount - 1}.000Z`,
      });
    }

    taskReviewRunCount += 1;
    taskReviewStarted = true;
    if (taskReviewRunCount === 1) {
      await taskReviewGate;
    }
    return buildCompletedExecutionResult({
      agent,
      finalMessage:
        taskReviewRunCount === 1
          ? "TaskReview 未通过。\n\n<continue>请修复 TaskReview。</continue>"
          : "TaskReview 通过。\n\n<complete>同意当前结果。</complete>",
      messageId: `message:TaskReview:${taskReviewRunCount}`,
      timestamp: `2026-04-17T00:00:2${taskReviewRunCount - 1}.000Z`,
    });
  };

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build", "UnitTest", "TaskReview"]);
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["Build", "UnitTest", "TaskReview"],
      edges: [
        { source: "Build", target: "UnitTest", triggerOn: "transfer", messageMode: "last" },
        { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
        { source: "UnitTest", target: "Build", triggerOn: "continue", messageMode: "last" },
        { source: "TaskReview", target: "Build", triggerOn: "continue", messageMode: "last" },
      ],
    },
  });

  const submittedTask = await orchestrator.submitTask({
    cwd: project.cwd,
    content: "@Build 请完成这个需求。",
  });

  await waitForTaskSnapshot(
    orchestrator,
    submittedTask.task.id,
    () => unitTestStarted && taskReviewStarted,
  );

  releaseUnitTest();
  await waitForTaskSnapshot(
    orchestrator,
    submittedTask.task.id,
    (snapshot) =>
      snapshot.messages.filter(
        (message) =>
          message.sender === "system"
          && message.kind === "task-completed"
          && message.status === "failed",
      ).length === 0,
  );

  releaseTaskReview();

  const finishedSnapshot = await waitForTaskSnapshot(
    orchestrator,
    submittedTask.task.id,
    (snapshot) =>
      snapshot.task.status === "finished"
      && buildRunCount === 2
      && unitTestRunCount === 2
      && taskReviewRunCount === 2,
  );

  const failedCompletionMessages = finishedSnapshot.messages.filter(
    (message) =>
      message.sender === "system"
      && message.kind === "task-completed"
      && message.status === "failed",
  );
  assert.equal(failedCompletionMessages.length, 0);
});

test("getWorkspaceSnapshot 不会再跨进程回放当前工作区任务", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(orchestrator);
  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build"]);
  const task = await orchestrator.initializeTask({ cwd: project.cwd, title: "demo" });

  const reloaded = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(reloaded);
  const snapshot = await reloaded.getWorkspaceSnapshot(project.cwd);

  assert.notEqual(snapshot, undefined);
  assert.equal(snapshot.tasks.some((item) => item.task.id === task.task.id), false);
});
