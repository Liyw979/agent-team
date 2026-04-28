import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildCliOpencodeAttachCommand } from "@shared/terminal-commands";
import {
  getMessageTargetAgentIds,
  isUserMessageRecord,
  type MessageRecord,
} from "@shared/types";
import type { OpenCodeExecutionResult } from "./opencode-client";
import { Orchestrator, isTerminalTaskStatus } from "./orchestrator";
import { buildAgentSystemPrompt } from "./agent-system-prompt";
import { compileBuiltinVulnerabilityTopology } from "./builtin-topology-test-helpers";
import { buildDownstreamForwardedContextFromMessages } from "./message-forwarding";
import { compileTeamDsl, type TeamDslDefinition } from "./team-dsl";
import { isOpenCodeServeCommand } from "./opencode-process-cleanup";
import { buildInjectedConfigFromAgents } from "./project-agent-source";
import { mergeTaskChatMessages } from "../lib/chat-messages";

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
  typed.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
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
}) {
  return buildOpenCodeExecutionResult({
    ...input,
    status: "completed",
  }) as OpenCodeExecutionResult & { status: "completed" };
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
  }) as OpenCodeExecutionResult & { status: "error" };
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
  nextAgents: Array<{ id: string; prompt: string; isWritable?: boolean }>;
}): TeamDslDefinition {
  return {
    entry: input.workspace.topology.langgraph?.start.targets[0] ?? input.nextAgents[0]?.id ?? "Build",
    nodes: [...new Set([...input.workspace.topology.nodes, ...input.nextAgents.map((agent) => agent.id)])].map((name) => {
      const nextAgent = input.nextAgents.find((agent) => agent.id === name);
      if (nextAgent) {
        return {
          type: "agent" as const,
          id: name,
          prompt: nextAgent.prompt,
          writable: nextAgent.isWritable === true,
        };
      }

      const existingNode = input.workspace.topology.nodeRecords?.find((node) => node.id === name);
      return {
        type: "agent" as const,
        id: name,
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
  nextAgents: Array<{ id: string; prompt: string; isWritable?: boolean }>,
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
  agentIds: string[],
  writableAgentId?: string | null,
) {
  let latestWorkspace = await orchestrator.getWorkspaceSnapshot(cwd);
  for (const agentId of agentIds) {
    const prompt = TEST_AGENT_PROMPTS[agentId];
    assert.notEqual(prompt, undefined, `缺少测试 Agent prompt：${agentId}`);
    const nextAgents = [...latestWorkspace.agents];
    const existingIndex = nextAgents.findIndex((agent) => agent.id === agentId);
    const nextAgent = {
      id: agentId,
      prompt: prompt ?? "",
      isWritable: writableAgentId === agentId,
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
  agentId: string,
  prompt: string,
  isWritable = false,
) {
  const current = await orchestrator.getWorkspaceSnapshot(cwd);
  const nextAgents = [...current.agents];
  const existingIndex = nextAgents.findIndex((agent) => agent.id === agentId);
  const nextAgent = {
    id: agentId,
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
  assert.equal(task.agents.some((agent) => agent.id === "Build"), true);
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

  const compiled = compileBuiltinVulnerabilityTopology();
  await orchestrator.applyTeamDsl({
    cwd: projectPath,
    compiled,
  });

  const task = await orchestrator.initializeTask({ cwd: projectPath, title: "vuln-demo" });
  const agentByName = new Map(task.agents.map((agent) => [agent.id, agent]));

  assert.equal(agentByName.get("线索发现")?.opencodeSessionId, "session:vuln-demo:线索发现");
  assert.equal(agentByName.get("漏洞论证")?.opencodeSessionId, null);
  assert.equal(agentByName.get("漏洞挑战")?.opencodeSessionId, null);
  assert.equal(agentByName.get("讨论总结")?.opencodeSessionId, null);
});

test("单节点任务进入 finished 时不会因为缺少 workspace cwd 而在后台崩溃", async () => {
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
    ) => Promise<Array<{ id: string; agentId: string; promise: Promise<unknown> }>>;
    trackBackgroundTask: (promise: Promise<unknown>, context: { taskId: string; agentId: string }) => void;
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
  typed.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async ({ agent }) =>
    buildOpenCodeExecutionResult({
      agent,
      finalMessage: `${agent} 已完成本轮处理。`,
      messageId: `message:${agent}:finished`,
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
    mentionAgentId: "BA",
  });

  assert.notEqual(backgroundRun, null);
  await assert.doesNotReject(async () => {
    await backgroundRun;
  });

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
    task.task.id,
    (current) => current.task.status === "finished",
    3000,
  );
  assert.equal(snapshot.task.status, "finished");
});

test("任务本轮 finished 后再次 @Agent 时会回到 running 并在同一 Task 内完成下一轮", async () => {
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

  let baRunCount = 0;
  let releaseSecondRound: () => void = () => undefined;
  const secondRoundGate = new Promise<void>((resolve) => {
    releaseSecondRound = resolve;
  });

  typed.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async ({ agent }) => {
    baRunCount += 1;
    if (baRunCount === 2) {
      await secondRoundGate;
    }
    return buildOpenCodeExecutionResult({
      agent,
      finalMessage: `${agent} 第 ${baRunCount} 轮已完成。`,
      messageId: `message:${agent}:${baRunCount}`,
    });
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

  const submitted = await orchestrator.submitTask({
    cwd: project.cwd,
    content: "@BA 请先完成第一轮",
    mentionAgentId: "BA",
  });

  const firstFinished = await waitForTaskSnapshot(
    orchestrator,
    submitted.task.id,
    (current) => current.task.status === "finished",
    3000,
  );
  assert.notEqual(firstFinished.task.completedAt, null);
  assert.equal(
    firstFinished.messages.filter((message) => message.kind === "task-round-finished").length,
    1,
  );

  const reopened = await orchestrator.submitTask({
    cwd: project.cwd,
    taskId: submitted.task.id,
    content: "@BA 请继续第二轮",
    mentionAgentId: "BA",
  });
  assert.equal(reopened.task.status, "running");
  assert.equal(reopened.task.completedAt, null);

  const runningSnapshot = await waitForTaskSnapshot(
    orchestrator,
    submitted.task.id,
    (current) =>
      current.task.status === "running"
      && current.task.completedAt === null
      && current.agents.find((agent) => agent.id === "BA")?.runCount === 2,
    3000,
  );
  assert.equal(runningSnapshot.task.status, "running");

  releaseSecondRound();

  const secondFinished = await waitForTaskSnapshot(
    orchestrator,
    submitted.task.id,
    (current) =>
      current.task.status === "finished"
      && current.messages.filter((message) => message.kind === "task-round-finished").length === 2,
    3000,
  );
  assert.notEqual(secondFinished.task.completedAt, null);
  assert.equal(
    secondFinished.messages.filter((message) => message.kind === "task-round-finished").length,
    2,
  );
});

test("漏洞团队里漏洞挑战先返回 continue、漏洞论证回应后才会继续派发到讨论总结", async () => {
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

  typed.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async ({ agent }) => {
    const count = nextCount(agent);
    if (agent === "线索发现" && count === 1) {
      return {
        ...buildCompletedExecutionResult({
          agent,
          finalMessage: [
            "- 可疑点标题：HTTP/2 请求未强制要求 :authority 或 host",
            "- 涉及文件与函数：a",
            "- 为什么可疑：b",
            "- 初步风险等级：高危",
            "",
            "<continue>发现新的可疑点，继续后续流程。</continue>",
          ].join("\n"),
          messageId: "message:线索发现:1",
          timestamp: "2026-04-22T00:00:00.000Z",
        }),
        rawMessage: {
          id: "message:线索发现:1",
          content: "线索发现第 1 轮已产出 finding",
          sender: agent,
          timestamp: "2026-04-22T00:00:00.000Z",
          completedAt: "2026-04-22T00:00:00.000Z",
          error: null,
          raw: null,
        },
      };
    }

    if (agent === "线索发现") {
      throw new Error("测试在首个讨论总结完成后主动停止后续线索发现回流。");
    }

    if (agent === "漏洞挑战") {
      return {
        ...buildOpenCodeExecutionResult({
          agent,
          finalMessage: "当前还缺少对关键调用链的逐条论证，请继续补证。\n\n<continue>请漏洞论证先回应本轮质疑。</continue>",
          messageId: `message:漏洞挑战:${count}`,
          timestamp: "2026-04-22T00:00:01.000Z",
        }),
        rawMessage: {
          id: `message:漏洞挑战:${count}`,
          content: "漏洞挑战要求漏洞论证先回应本轮质疑",
          sender: agent,
          timestamp: "2026-04-22T00:00:01.000Z",
          completedAt: "2026-04-22T00:00:01.000Z",
          error: null,
          raw: null,
        },
      };
    }

    if (agent === "漏洞论证") {
      return {
        ...buildOpenCodeExecutionResult({
          agent,
          finalMessage: "我已补齐入口到落盘点的关键证据，当前可以进入裁决。\n\n<complete>当前已经完成对上一轮质疑的回应。</complete>",
          messageId: `message:漏洞论证:${count}`,
          timestamp: "2026-04-22T00:00:01.500Z",
        }),
        rawMessage: {
          id: `message:漏洞论证:${count}`,
          content: "漏洞论证完成了对漏洞挑战上一轮质疑的回应",
          sender: agent,
          timestamp: "2026-04-22T00:00:01.500Z",
          completedAt: "2026-04-22T00:00:01.500Z",
          error: null,
          raw: null,
        },
      };
    }

    if (agent === "讨论总结") {
      return {
        ...buildOpenCodeExecutionResult({
          agent,
          finalMessage: "判断：该点更像真实漏洞，输出正式漏洞报告。",
          messageId: `message:讨论总结:${count}`,
          timestamp: "2026-04-22T00:00:02.000Z",
        }),
        rawMessage: {
          id: `message:讨论总结:${count}`,
          content: "讨论总结已输出报告",
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

  const compiled = compileBuiltinVulnerabilityTopology();
  await orchestrator.applyTeamDsl({
    cwd: projectPath,
    compiled,
  });

  const task = await orchestrator.submitTask({
    cwd: projectPath,
    content: "@线索发现 请分析这个漏洞线索",
    mentionAgentId: "线索发现",
  });

  await waitForValue(
    async () => {
      const dispatchMessage = typed.store.listMessages(projectPath, task.task.id).findLast(
        (message) => message.kind === "continue-request" && message.sender === "线索发现",
      );
      return dispatchMessage ? getMessageTargetAgentIds(dispatchMessage)[0] ?? null : null;
    },
    (value) => typeof value === "string" && value.startsWith("漏洞挑战-"),
    3000,
  );

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
    task.task.id,
    (current) => current.messages.some((message) => message.sender.startsWith("讨论总结-")),
    3000,
  );

  assert.equal(
    snapshot.messages.some((message) => message.sender.startsWith("讨论总结-")),
    true,
  );
});

test("漏洞团队里讨论总结以 transfer + none 回到线索发现时，会下发 continue 指令继续找线索", async () => {
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

  typed.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async ({ agent, content }) => {
    const count = recordPrompt(agent, content);
    if (agent === "线索发现") {
      return buildCompletedExecutionResult({
        agent,
        finalMessage:
          count === 1
            ? [
              "1. 可疑点标题",
              "HTTP/2 请求未强制要求 :authority 或 host",
              "",
              "2. 涉及文件与函数",
              "- a",
              "",
              "3. 为什么可疑",
              "b",
              "",
              "4. 初步风险等级",
              "高风险",
              "",
              "<continue>发现新的可疑点，继续后续流程。</continue>",
            ].join("\n")
            : "<complete>当前项目里没有新的可疑点，结束本轮流程。</complete>",
        messageId: `message:${agent}:${count}`,
        timestamp: `2026-04-24T00:00:0${count}.000Z`,
      });
    }

    if (agent === "漏洞挑战") {
      return buildCompletedExecutionResult({
        agent,
        finalMessage: "<continue>当前还缺少关键代码证据，请漏洞论证先回应。</continue>",
        messageId: `message:${agent}:${count}`,
        timestamp: "2026-04-24T00:00:10.000Z",
      });
    }

    if (agent === "漏洞论证") {
      return buildCompletedExecutionResult({
        agent,
        finalMessage: "<complete>我已回应漏洞挑战的关键质疑，当前可以进入讨论总结。</complete>",
        messageId: `message:${agent}:${count}`,
        timestamp: "2026-04-24T00:00:15.000Z",
      });
    }

    if (agent === "讨论总结") {
      return buildCompletedExecutionResult({
        agent,
        finalMessage: "结论：当前这条更像误报，已形成稳定判断。",
        messageId: `message:${agent}:${count}`,
        timestamp: "2026-04-24T00:00:20.000Z",
      });
    }

    return buildCompletedExecutionResult({
      agent,
      finalMessage: `${agent} 已处理完成。`,
      messageId: `message:${agent}:${count}`,
      timestamp: "2026-04-24T00:00:30.000Z",
    });
  };

  const compiled = compileBuiltinVulnerabilityTopology();
  await orchestrator.applyTeamDsl({
    cwd: projectPath,
    compiled,
  });

  const task = await orchestrator.submitTask({
    cwd: projectPath,
    content: "@线索发现 请持续挖掘当前代码中的可疑漏洞点。",
    mentionAgentId: "线索发现",
  });

  await waitForTaskSnapshot(
    orchestrator,
    task.task.id,
    () => (promptByAgent.get("线索发现")?.length ?? 0) >= 2,
    3000,
  );

  const secondPrompt = promptByAgent.get("线索发现")?.[1] ?? "";
  assert.equal(secondPrompt, "continue");
  assert.doesNotMatch(secondPrompt, /更像误报|稳定判断/u);
});

test("漏洞团队第二轮 finding 已经派发到 漏洞挑战-2 时，UI 仍能看到线索发现的第二轮消息", async () => {
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

  const runCountByAgent = new Map<string, number>();
  const nextCount = (agent: string) => {
    const next = (runCountByAgent.get(agent) ?? 0) + 1;
    runCountByAgent.set(agent, next);
    return next;
  };

  typed.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async ({ agent }) => {
    const count = nextCount(agent);

    if (agent === "线索发现") {
      if (count === 1) {
        return buildCompletedExecutionResult({
          agent,
          finalMessage: [
            "1. 可疑点标题",
            "上传文件名可能被直接拼进目标路径",
            "",
            "2. 涉及文件与函数",
            "- upload()",
            "",
            "3. 为什么可疑",
            "文件名直接参与路径拼接。",
            "",
            "4. 初步风险等级",
            "高风险",
            "",
            "<continue>发现新的可疑点，继续后续流程。</continue>",
          ].join("\n"),
          messageId: "message:线索发现:1",
          timestamp: "2026-04-24T00:00:01.000Z",
        });
      }

      if (count === 2) {
        return buildCompletedExecutionResult({
          agent,
          finalMessage: [
            "1. 可疑点标题",
            "内部调试接口似乎缺少鉴权",
            "",
            "2. 涉及文件与函数",
            "- debugRoute()",
            "",
            "3. 为什么可疑",
            "调试路由默认注册且未见鉴权。",
            "",
            "4. 初步风险等级",
            "中风险",
            "",
            "<continue>发现新的可疑点，继续后续流程。</continue>",
          ].join("\n"),
          messageId: "message:线索发现:2",
          timestamp: "2026-04-24T00:00:04.000Z",
        });
      }

      return buildCompletedExecutionResult({
        agent,
        finalMessage: "<complete>当前项目里没有新的可疑点，结束本轮流程。</complete>",
        messageId: `message:线索发现:${count}`,
        timestamp: `2026-04-24T00:00:0${count + 3}.000Z`,
      });
    }

    if (agent === "漏洞挑战") {
      return buildCompletedExecutionResult({
        agent,
        finalMessage: "<continue>当前还缺少关键代码证据，请漏洞论证先回应。</continue>",
        messageId: `message:漏洞挑战:${count}`,
        timestamp: `2026-04-24T00:00:0${count + 1}.000Z`,
      });
    }

    if (agent === "漏洞论证") {
      return buildCompletedExecutionResult({
        agent,
        finalMessage: "<complete>我已回应漏洞挑战的关键质疑，当前可以进入讨论总结。</complete>",
        messageId: `message:漏洞论证:${count}`,
        timestamp: `2026-04-24T00:00:0${count + 1}.500Z`,
      });
    }

    if (agent === "讨论总结") {
      return buildCompletedExecutionResult({
        agent,
        finalMessage: count === 1 ? "结论：当前这条更像真实漏洞。" : "结论：当前这条更像误报。",
        messageId: `message:讨论总结:${count}`,
        timestamp: `2026-04-24T00:00:0${count + 2}.000Z`,
      });
    }

    return buildCompletedExecutionResult({
      agent,
      finalMessage: `${agent} 已处理完成。`,
      messageId: `message:${agent}:${count}`,
      timestamp: "2026-04-24T00:00:09.000Z",
    });
  };

  const compiled = compileBuiltinVulnerabilityTopology();
  await orchestrator.applyTeamDsl({
    cwd: projectPath,
    compiled,
  });

  const task = await orchestrator.submitTask({
    cwd: projectPath,
    content: "@线索发现 请持续挖掘当前代码中的可疑漏洞点，直到没有新 finding 为止。",
    mentionAgentId: "线索发现",
  });

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
    task.task.id,
    (current) => current.messages.some((message) => message.sender === "漏洞挑战-2"),
    3000,
  );

  assert.equal(
    snapshot.messages.some((message) =>
      message.sender === "线索发现" && /内部调试接口似乎缺少鉴权/u.test(message.content)),
    true,
  );

  const mergedMessages = mergeTaskChatMessages(snapshot.messages);
  assert.equal(
    mergedMessages.some((message) =>
      message.sender === "线索发现" && /内部调试接口似乎缺少鉴权/u.test(message.content)),
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
      listTaskAgents: (cwd: string, taskId: string) => Array<{ id: string }>;
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

  typed.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.buildProjectGitDiffSummary = async () => {
    gitSummaryCallCount += 1;
    if (gitSummaryCallCount === 1) {
      return "";
    }
    return gitSummaryBlocked;
  };
  typed.opencodeRunner.run = async ({ agent }) => {
    if (agent === "线索发现") {
      return {
        ...buildOpenCodeExecutionResult({
          agent,
          finalMessage: [
            "- 可疑点标题：HTTP/2 请求未强制要求 :authority 或 host",
            "- 涉及文件与函数：a",
            "- 为什么可疑：b",
            "- 初步风险等级：高危",
            "",
            "<continue>发现新的可疑点，继续后续流程。</continue>",
          ].join("\n"),
          messageId: "message:线索发现:1",
          timestamp: "2026-04-22T00:00:00.000Z",
        }),
        rawMessage: {
          id: "message:线索发现:1",
          content: "线索发现第 1 轮已产出 finding",
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

  const compiled = compileBuiltinVulnerabilityTopology();
  await orchestrator.applyTeamDsl({
    cwd: projectPath,
    compiled,
  });

  const task = await orchestrator.submitTask({
    cwd: projectPath,
    content: "@线索发现 请分析这个漏洞线索",
    mentionAgentId: "线索发现",
  });

  await waitForValue(
    async () => gitSummaryCallCount,
    (value) => value >= 2,
    3000,
  );

  const taskAgentIdsDuringDispatchWindow = typed.store
    .listTaskAgents(projectPath, task.task.id)
    .map((agent) => agent.id);

  const snapshotDuringDispatchWindow = await orchestrator.getTaskSnapshot(task.task.id, projectPath);

  assert.notEqual(snapshotDuringDispatchWindow.task.status, "finished");
  assert.equal(
    typed.store.listMessages(projectPath, task.task.id).some(
      (message) => message.kind === "task-round-finished",
    ),
    false,
  );
  assert.equal(typed.store.getTask(projectPath, task.task.id).status, "continue");

  releaseGitSummary("");
  const settledSnapshot = await waitForTaskSnapshot(
    orchestrator,
    task.task.id,
    (current) => current.task.status === "failed",
    3000,
  );
  const continueRequestMessage = typed.store.listMessages(projectPath, task.task.id).findLast(
    (message) => message.kind === "continue-request" && message.sender === "线索发现",
  );
  const runtimeAgentIdFromContinue = continueRequestMessage
    ? getMessageTargetAgentIds(continueRequestMessage)[0] ?? null
    : null;

  assert.equal(typeof runtimeAgentIdFromContinue, "string");
  assert.equal(runtimeAgentIdFromContinue?.startsWith("漏洞挑战-"), true);
  assert.equal(taskAgentIdsDuringDispatchWindow.includes(runtimeAgentIdFromContinue!), false);
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
    { id: "Build", prompt: TEST_AGENT_PROMPTS["Build"] ?? "", isWritable: true },
    { id: "BA", prompt: TEST_AGENT_PROMPTS["BA"] ?? "" },
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
  typed.opencodeClient.connectEvents = async (target, onEvent) => {
    void target;
    eventHandler = onEvent as (event: unknown) => void;
  };
  typed.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
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
  assert.equal(project.agents.some((agent) => agent.id === "Build"), false);

  const withBuild = await addBuiltinAgents(orchestrator, project.cwd, ["Build"], "Build");
  assert.equal(withBuild.agents.some((agent) => agent.id === "Build"), true);
  assert.equal(withBuild.agents.find((agent) => agent.id === "Build")?.isWritable, true);
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
        id: "Build",
        prompt: "",
        writable: true,
      },
      {
        type: "agent",
        id: "BA",
        prompt: TEST_AGENT_PROMPTS["BA"] ?? "",
        writable: false,
      },
      {
        type: "agent",
        id: "SecurityResearcher",
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
    updated.agents.map((agent) => agent.id).sort(),
    ["BA", "Build", "SecurityResearcher"],
  );
  assert.equal(
    updated.agents.find((agent) => agent.id === "SecurityResearcher")?.prompt,
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
      maxContinueRounds: 4,
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
        id: "BA",
        prompt: "DSL BA prompt",
        writable: false,
      },
      {
        type: "agent",
        id: "Build",
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
    updated.agents.find((agent) => agent.id === "BA")?.prompt,
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

  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["BA", "Build"],
      edges: [{ source: "BA", target: "Build", triggerOn: "transfer", messageMode: "last" }],
    },
  });

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
  project = await addCustomAgent(orchestrator, project.cwd, "线索发现", "你负责线索发现。");
  project = await addCustomAgent(orchestrator, project.cwd, "漏洞论证模板", "你负责漏洞论证。");
  project = await addCustomAgent(orchestrator, project.cwd, "漏洞挑战模板", "你负责漏洞挑战。");
  project = await addCustomAgent(orchestrator, project.cwd, "Summary模板", "你是总结。");

  const saved = await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["Build", "线索发现", "漏洞论证模板", "漏洞挑战模板", "Summary模板"],
      edges: [{ source: "Build", target: "线索发现", triggerOn: "transfer", messageMode: "last" }],
      nodeRecords: [
        { id: "Build", kind: "agent", templateName: "Build" },
        { id: "线索发现", kind: "agent", templateName: "线索发现" },
        { id: "漏洞论证模板", kind: "agent", templateName: "漏洞论证模板" },
        { id: "漏洞挑战模板", kind: "agent", templateName: "漏洞挑战模板" },
        { id: "Summary模板", kind: "agent", templateName: "Summary模板" },
        { id: "疑点辩论工厂", kind: "spawn", templateName: "漏洞论证模板", spawnRuleId: "finding-debate" },
      ],
      spawnRules: [
        {
          id: "finding-debate",
          spawnNodeName: "疑点辩论工厂",
          sourceTemplateName: "线索发现",
          entryRole: "pro",
          spawnedAgents: [
            { role: "pro", templateName: "漏洞论证模板" },
            { role: "con", templateName: "漏洞挑战模板" },
            { role: "summary", templateName: "Summary模板" },
          ],
          edges: [
            { sourceRole: "pro", targetRole: "con", triggerOn: "continue", messageMode: "last" },
            { sourceRole: "con", targetRole: "pro", triggerOn: "continue", messageMode: "last" },
            { sourceRole: "pro", targetRole: "summary", triggerOn: "complete", messageMode: "last" },
            { sourceRole: "con", targetRole: "summary", triggerOn: "complete", messageMode: "last" },
          ],
          exitWhen: "one_side_agrees",
          reportToTemplateName: "线索发现",
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
        id: "UnitTest",
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
  typed.opencodeClient.setInjectedConfigContent = (...args: [string, string | null]) => {
    injectedConfigs.push(args[1] ?? "null");
  };
  typed.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
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
      webfetch: "deny",
      websearch: "deny",
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
    agentId: "Build",
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
      webfetch: "deny",
      websearch: "deny",
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
    project.agents.map((agent) => [agent.id, agent.isWritable === true]),
    [
      ["Build", true],
      ["BA", true],
    ],
  );

  assert.deepEqual(parseInjectedConfig(buildInjectedConfigFromAgents(project.agents)).agent, {
    BA: {
      mode: "primary",
      prompt: "你是 BA。",
    },
  });
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
    project.agents.map((agent) => [agent.id, agent.isWritable === true]),
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

test("handoff 边配置为 none 时，下游 prompt 只传 continue，不保留结构化标题", async () => {
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
          messageMode: "none" | "last" | "last-all";
        }>;
      },
      sourceAgentId: string,
      targetAgentId: string,
      triggerOn: "transfer" | "complete" | "continue_request",
    ) => "none" | "last" | "last-all";
    buildAgentExecutionPrompt: (prompt:
      | {
          mode: "structured";
          from: string;
          userMessage?: string;
          agentMessage?: string;
          gitDiffSummary?: string;
        }
      | {
          mode: "control";
          content: string;
        }
    ) => string;
  };

  const messageMode = typed.getEdgeMessageMode(
    {
      edges: [
        {
          source: "线索发现",
          target: "疑点辩论",
          triggerOn: "transfer",
          messageMode: "none",
        },
      ],
    },
    "线索发现",
    "疑点辩论",
    "transfer",
  );

  assert.equal(messageMode, "none");

  const prompt = typed.buildAgentExecutionPrompt({
    mode: "control",
    content: "continue",
  });

  assert.equal(prompt, "continue");
  assert.doesNotMatch(prompt, /\[Initial Task\]/);
  assert.doesNotMatch(prompt, /\[From 线索发现 Agent\]/);
  assert.doesNotMatch(prompt, /这里是上一条完整正文/);
});

test("message_type = last-all 时，下游结构化 prompt 不重复添加来源标题", async () => {
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
      omitSourceAgentSectionLabel?: boolean;
    }) => string;
  };

  const transcript = [
    "[user] 初始任务：判断当前可疑点是否成立",
    "[线索发现] 发现第 1 个可疑点：HTTP/2 未强制校验 authority",
    "[漏洞挑战-1] 当前材料不足以证明真实漏洞。",
  ].join("\n\n");

  const prompt = typed.buildAgentExecutionPrompt({
    mode: "structured",
    from: "讨论总结-1",
    agentMessage: transcript,
    omitSourceAgentSectionLabel: true,
  });

  assert.equal(prompt, transcript);
  assert.doesNotMatch(prompt, /\[From 讨论总结-1 Agent\]/);
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
          messageMode: "none" | "last" | "last-all";
        }>;
      },
      sourceAgentId: string,
      targetAgentId: string,
      triggerOn: "transfer" | "complete" | "continue_request",
    ) => "none" | "last" | "last-all";
  };

  const messageMode = typed.getEdgeMessageMode(
    {
      edges: [
        {
          source: "线索发现",
          target: "漏洞挑战-1",
          triggerOn: "transfer",
          messageMode: "last-all",
        },
      ],
    },
    "线索发现",
    "漏洞挑战-1",
    "transfer",
  );

  assert.equal(messageMode, "last-all");
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
          messageMode: "none" | "last" | "last-all";
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
    ) => "none" | "last" | "last-all";
  };

  const messageMode = typed.getEdgeMessageMode(
    {
      edges: [
        {
          source: "线索发现",
          target: "疑点辩论",
          triggerOn: "transfer",
          messageMode: "last-all",
        },
      ],
      nodeRecords: [
        {
          id: "漏洞挑战-1",
          kind: "agent",
          templateName: "疑点辩论",
        },
      ],
    },
    "线索发现",
    "漏洞挑战-1",
    "transfer",
  );

  assert.equal(messageMode, "last-all");
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

  typed.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
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

test("单 decisionAgent 判定失败后会把 action_required 回流给 Build", async () => {
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

  typed.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async ({ agent, content }) => {
    const count = recordPrompt(agent, content);
    if (agent === "BA") {
      return completedResponse(agent, count, "需求已澄清，交给 Build 继续实现。");
    }
    if (agent === "Build") {
      return count === 1
        ? completedResponse(agent, count, "构建已完成，交给 CodeReview 判定。")
        : completedResponse(agent, count, "已根据 CodeReview 意见修复完成。");
    }
    return count === 1
        ? completedResponse(
          agent,
          count,
          "判定未通过。\n\n<continue> 请修复构建结果。</continue>",
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
    content: "@BA 请实现 add 方法，并准备判定修复。",
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

test("判定 Agent 的结构化 prompt 不会混入 Project Git Diff Summary", async () => {
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

  typed.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
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

test("修复首个失败 decisionAgent 后，Build 下一轮不会立刻全量重派全部 decisionAgent", async () => {
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
  let taskDecisionRunCount = 0;
  let codeDecisionRunCount = 0;
  let releaseUnitTestSecondRun: () => void = () => undefined;
  let releaseTaskReviewSecondRun: () => void = () => undefined;
  let releaseCodeReviewSecondRun: () => void = () => undefined;
  const unitTestSecondRunGate = new Promise<void>((resolve) => {
    releaseUnitTestSecondRun = resolve;
  });
  const taskDecisionSecondRunGate = new Promise<void>((resolve) => {
    releaseTaskReviewSecondRun = resolve;
  });
  const codeDecisionSecondRunGate = new Promise<void>((resolve) => {
    releaseCodeReviewSecondRun = resolve;
  });

  typed.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
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
      taskDecisionRunCount += 1;
      if (taskDecisionRunCount === 1) {
        return completedResponse(
          agent,
          taskDecisionRunCount,
          "TaskReview 第 1 轮未通过。\n\n<continue>请修复 TaskReview 第 1 轮问题。</continue>",
        );
      }
      await taskDecisionSecondRunGate;
      return completedResponse(agent, taskDecisionRunCount, "TaskReview: ok\n\n<complete>同意当前结果。</complete>");
    }
    codeDecisionRunCount += 1;
    if (codeDecisionRunCount === 1) {
      return completedResponse(
        agent,
        codeDecisionRunCount,
        "CodeReview 第 1 轮未通过。\n\n<continue>请修复 CodeReview 第 1 轮问题。</continue>",
      );
    }
    await codeDecisionSecondRunGate;
    return completedResponse(agent, codeDecisionRunCount, "CodeReview: ok\n\n<complete>同意当前结果。</complete>");
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
        taskDecisionRunCount,
        codeDecisionRunCount,
      }),
      (counts) => counts.buildRunCount === 2 && counts.unitTestRunCount >= 2,
      5000,
    );

    assert.equal(buildRunCount, 2);
    assert.equal(unitTestRunCount, 2);
    assert.equal(
      taskDecisionRunCount,
      1,
      "Build 修完 UnitTest 后，不应该立刻把 TaskReview 拉进第 2 轮",
    );
    assert.equal(
      codeDecisionRunCount,
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

test("判定 Agent 返回 action_required 后会在其余 decisionAgent 收齐后回流到 Build", async () => {
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
  let taskDecisionRunCount = 0;
  let codeDecisionRunCount = 0;
  let unitTestStarted = false;
  let taskDecisionStarted = false;
  let codeDecisionStarted = false;
  const buildPrompts: string[] = [];
  let releaseUnitTest: () => void = () => undefined;
  let releaseTaskReview: () => void = () => undefined;
  let releaseCodeReview: () => void = () => undefined;
  const unitTestGate = new Promise<void>((resolve) => {
    releaseUnitTest = resolve;
  });
  const taskDecisionGate = new Promise<void>((resolve) => {
    releaseTaskReview = resolve;
  });
  const codeDecisionGate = new Promise<void>((resolve) => {
    releaseCodeReview = resolve;
  });

  typed.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
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
      taskDecisionRunCount += 1;
      if (taskDecisionRunCount === 1) {
        taskDecisionStarted = true;
        await taskDecisionGate;
      }
      return completedResponse(agent, taskDecisionRunCount, "TaskReview: ok\n\n<complete>同意当前结果。</complete>");
    }
    codeDecisionRunCount += 1;
    if (codeDecisionRunCount === 1) {
      codeDecisionStarted = true;
      await codeDecisionGate;
    }
    return completedResponse(agent, codeDecisionRunCount, "CodeReview: ok\n\n<complete>同意当前结果。</complete>");
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
    () => unitTestStarted && taskDecisionStarted && codeDecisionStarted,
  );

  assert.equal(buildRunCount, 1);
  assert.equal(unitTestStarted, true);
  assert.equal(taskDecisionStarted, true);
  assert.equal(codeDecisionStarted, true);

  releaseUnitTest();
  const runningSnapshot = await waitForTaskSnapshot(
    orchestrator,
    submittedTask.task.id,
    (snapshot) =>
      snapshot.task.status === "running"
      && unitTestRunCount === 1
      && buildRunCount === 1
      && snapshot.agents.some((agent) => agent.id === "UnitTest" && agent.status === "continue"),
  );
  assert.equal(runningSnapshot.task.status, "running");
  assert.equal(buildRunCount, 1);
  assert.equal(
    runningSnapshot.agents.some((agent) => agent.id === "UnitTest" && agent.status === "continue"),
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
      && taskDecisionRunCount === 2
      && codeDecisionRunCount === 2,
  );
  assert.equal(settledSnapshot.task.status, "finished");
  assert.equal(buildRunCount, 2);
  assert.equal(unitTestRunCount, 2);
  assert.equal(taskDecisionRunCount, 2);
  assert.equal(codeDecisionRunCount, 2);
  assert.equal(buildPrompts.length, 2);
  assert.match(buildPrompts[1] ?? "", /\[From UnitTest Agent\]/u);
  assert.match(buildPrompts[1] ?? "", /请修复第 1 轮单测问题/u);
});

test("判定类 system prompt 会使用真实来源 Agent 名称", () => {
  const systemPrompt = buildAgentSystemPrompt();

  assert.doesNotMatch(systemPrompt, /\[From BA Agent\]/);
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
    { id: "BA", prompt: "你是新的 BA。" },
    { id: "Build", prompt: "" },
  ]);

  assert.equal(
    reapplied.agents.find((agent) => agent.id === "BA")?.prompt,
    "你是新的 BA。",
  );
  assert.equal(reapplied.agents.some((agent) => agent.id === "Build"), true);
});

test("已完成判定但没有可展示结果正文时不再返回通过兜底文案", () => {
  const orchestrator = createTestOrchestrator({
    userDataPath: createTempDir(),
    enableEventStream: false,
  });

  const displayContent = (
    orchestrator as unknown as {
      createDisplayContent: (
        parsedDecision: {
          cleanContent: string;
          decision: "complete" | "continue";
          opinion: string;
        },
      ) => string;
    }
  ).createDisplayContent(
    {
      cleanContent: "",
      decision: "complete",
      opinion: "",
    },
  );

  assert.equal(displayContent, "");
});

test("Agent 返回 completed 但正文为空时，任务必须失败而不是写入通过", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(orchestrator);
  const typed = orchestrator as unknown as Orchestrator & {
    runAgent: (
      cwd: string,
      task: { id: string; cwd: string },
      agentId: string,
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
  const task = await orchestrator.initializeTask({ cwd: project.cwd, title: "demo" });

  typed.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async ({ agent }) =>
    buildCompletedExecutionResult({
      agent,
      finalMessage: "",
      messageId: "msg-empty",
      timestamp: "2026-04-25T00:00:00.000Z",
    });

  await typed.runAgent(
    project.cwd,
    task.task,
    "BA",
    {
      mode: "raw",
      from: "User",
      content: "请输出结果",
    },
  );

  const snapshot = await orchestrator.getTaskSnapshot(task.task.id);
  assert.equal(snapshot.task.status, "failed");
  assert.equal(
    snapshot.messages.some((message) => message.sender === "BA" && message.kind === "agent-final"),
    false,
  );
  assert.equal(
    snapshot.messages.some((message) => message.content.includes("未返回可展示的结果正文")),
    true,
  );
  assert.equal(
    snapshot.messages.some((message) => message.content === "通过"),
    false,
  );
});

test("非判定 Agent 返回 continue 时不应写入 agent-final，而是直接走失败消息", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(orchestrator);
  const typed = orchestrator as unknown as Orchestrator & {
    runAgent: (
      cwd: string,
      task: { id: string; cwd: string },
      agentId: string,
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
  const task = await orchestrator.initializeTask({ cwd: project.cwd, title: "demo" });

  typed.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async ({ agent }) =>
    buildCompletedExecutionResult({
      agent,
      finalMessage: "<continue>请继续修复</continue>",
      messageId: "msg-invalid-continue",
      timestamp: "2026-04-25T00:00:00.000Z",
    });

  await typed.runAgent(
    project.cwd,
    task.task,
    "BA",
    {
      mode: "raw",
      from: "User",
      content: "请输出结果",
    },
  );

  const snapshot = await orchestrator.getTaskSnapshot(task.task.id);
  assert.equal(snapshot.task.status, "failed");
  assert.equal(
    snapshot.messages.some((message) => message.sender === "BA" && message.kind === "agent-final"),
    false,
  );
  assert.equal(
    snapshot.messages.some((message) => message.sender === "BA" && message.kind === "continue-request"),
    false,
  );
  assert.equal(
    snapshot.messages.some((message) => message.content.includes("非判定 Agent 不应返回 continue")),
    true,
  );
  assert.equal(
    snapshot.messages.some((message) => message.content.includes("请继续修复")),
    false,
  );
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
    ensureAgentSession: (task: { id: string; cwd: string }, agent: { id: string }) => Promise<string>;
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
  typed.ensureAgentSession = async (task, agent) => `session:${task.id}:${agent.id}`;
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
    mentionAgentId: "BA",
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
    (message) => message.sender === "system" && message.kind === "task-round-finished",
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
        parsedDecision: {
          cleanContent: string;
          decision: "complete" | "continue";
          opinion: string;
        },
      ) => string;
    }
  ).createDisplayContent(
    {
      cleanContent: "",
      decision: "continue",
      opinion: "请继续补充实现依据。",
    },
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
        parsedDecision: {
          cleanContent: string;
          decision: "complete" | "continue";
          opinion: string;
        },
      ) => string;
    }
  ).createDisplayContent(
    {
      cleanContent,
      decision: "continue",
      opinion: "请继续补充实现依据。",
    },
  );

  assert.equal(displayContent, cleanContent);
});

test("message_type = last-all 的转发会复用运行时生成的群聊语义卡片，不会重复拼接 continue-request", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  const typed = stubOpenCodeSessions(orchestrator) as unknown as Orchestrator & {
    store: {
      listMessages: (cwd: string, taskId: string) => MessageRecord[];
    };
    ensureTaskPanels: (task: { id: string; cwd: string }) => Promise<void>;
    ensureAgentSession: (task: { id: string; cwd: string }, agent: { id: string }) => Promise<string>;
    opencodeRunner: {
      run: (payload: { agent: string }) => Promise<OpenCodeExecutionResult>;
    };
  };

  const finalBody = "当前只能确认这里没有看到强制拒绝缺失主机标识的分支。";
  const decisionBody = "还需要补证：缺失 host 的 HTTP/2 请求是否真的会进入目标敏感应用。";
  const startedAt = Date.now();

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build", "TaskReview"]);
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["Build", "TaskReview"],
      edges: [
        { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
        { source: "TaskReview", target: "Build", triggerOn: "continue", messageMode: "last" },
      ],
    },
  });

  typed.ensureTaskPanels = async () => undefined;
  typed.ensureAgentSession = async (task, agent) => `session:${task.id}:${agent.id}`;
  typed.opencodeRunner.run = async ({ agent }) => {
    if (agent === "Build") {
      return buildCompletedExecutionResult({
        agent,
        finalMessage: "Build 首轮实现完成。",
        messageId: "message:Build:1",
        timestamp: new Date(startedAt + 10).toISOString(),
      });
    }
    return buildCompletedExecutionResult({
      agent,
      finalMessage: `${finalBody}\n\n<continue>\n${decisionBody}`,
      messageId: "message:TaskReview:1",
      timestamp: new Date(startedAt + 20).toISOString(),
    });
  };

  const submittedTask = await orchestrator.submitTask({
    cwd: project.cwd,
    content: "@Build 请完成这个需求。",
    mentionAgentId: "Build",
  });

  await waitForTaskSnapshot(
    orchestrator,
    submittedTask.task.id,
    (snapshot) =>
      snapshot.messages.some(
        (message) =>
          message.sender === "TaskReview"
          && message.kind === "continue-request",
      ),
    8000,
  );

  const taskMessages = typed.store.listMessages(project.cwd, submittedTask.task.id);
  const forwarded = buildDownstreamForwardedContextFromMessages(
    taskMessages,
    decisionBody,
    {
      messageMode: "last-all",
      includeInitialTask: true,
      activeAgentIds: ["Build", "TaskReview"],
    },
  );

  assert.equal(forwarded.userMessage, "请完成这个需求。");
  assert.match(forwarded.agentMessage, /^\[Build\] Build 首轮实现完成。/u);
  assert.equal(forwarded.agentMessage.includes("[TaskReview]"), true);
  assert.equal(forwarded.agentMessage.split(decisionBody).length - 1, 1);
  assert.equal(forwarded.agentMessage.split("[TaskReview]").length - 1, 1);
});

test("判定 Agent 未返回合法标签时默认按 continue 处理", () => {
  const orchestrator = createTestOrchestrator({
    userDataPath: createTempDir(),
    enableEventStream: false,
  });

  const parsedDecision = (
    orchestrator as unknown as {
      parseDecision: (
        content: string,
        decisionAgent: boolean,
      ) => {
        cleanContent: string;
        decision: "complete" | "continue";
        opinion: string;
        rawDecisionBlock: string;
      };
    }
  ).parseDecision("这是普通判定正文，标签写错了。\n\n<chalenge>请继续补充实现依据。</chalenge>", true);

  assert.deepEqual(parsedDecision, {
    cleanContent: "这是普通判定正文，标签写错了。\n\n<chalenge>请继续补充实现依据。</chalenge>",
    decision: "continue",
    opinion: "这是普通判定正文，标签写错了。\n\n<chalenge>请继续补充实现依据。</chalenge>",
    rawDecisionBlock: "",
  });
});

test("判定 Agent 未返回合法标签时会沿 continue 边继续回流", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  const typed = stubOpenCodeSessions(orchestrator) as unknown as Orchestrator & {
    ensureTaskPanels: (task: { id: string; cwd: string }) => Promise<void>;
    ensureAgentSession: (task: { id: string; cwd: string }, agent: { id: string }) => Promise<string>;
    opencodeRunner: {
      run: (payload: { agent: string }) => Promise<OpenCodeExecutionResult>;
    };
  };

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build", "TaskReview"]);
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["Build", "TaskReview"],
      edges: [
        { source: "Build", target: "TaskReview", triggerOn: "transfer", messageMode: "last" },
        { source: "TaskReview", target: "Build", triggerOn: "continue", messageMode: "last" },
      ],
    },
  });

  typed.ensureTaskPanels = async () => undefined;
  typed.ensureAgentSession = async (task, agent) => `session:${task.id}:${agent.id}`;
  typed.opencodeRunner.run = async ({ agent }) => {
    if (agent === "Build") {
      return buildCompletedExecutionResult({
        agent,
        finalMessage: "Build 首轮实现完成。",
        messageId: "message:Build:1",
        timestamp: "2026-04-25T10:00:00.000Z",
      });
    }

    return buildCompletedExecutionResult({
      agent,
      finalMessage: "当前证据链还不完整，请继续补充实现依据。\n\n<chalenge>请继续补充实现依据。</chalenge>",
      messageId: "message:TaskReview:1",
      timestamp: "2026-04-25T10:00:01.000Z",
    });
  };

  const submittedTask = await orchestrator.submitTask({
    cwd: project.cwd,
    content: "@Build 请完成这个需求。",
    mentionAgentId: "Build",
  });

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
    submittedTask.task.id,
    (current) =>
      current.messages.some(
        (message) =>
          message.sender === "TaskReview"
          && message.kind === "continue-request"
          && message.targetAgentIds.includes("Build"),
      ),
    8000,
  );

  const taskDecisionFinal = snapshot.messages.findLast(
    (message) => message.sender === "TaskReview" && message.kind === "agent-final",
  );
  assert.notEqual(taskDecisionFinal, undefined);
  assert.equal(taskDecisionFinal?.kind, "agent-final");
  if (!taskDecisionFinal || taskDecisionFinal.kind !== "agent-final") {
    assert.fail("缺少 TaskReview 的最终消息");
  }
  assert.equal(taskDecisionFinal.decision, "continue");
  assert.equal(taskDecisionFinal.content, "当前证据链还不完整，请继续补充实现依据。\n\n<chalenge>请继续补充实现依据。</chalenge>");

  const continueRequest = snapshot.messages.findLast(
    (message) => message.sender === "TaskReview" && message.kind === "continue-request",
  );
  assert.notEqual(continueRequest, undefined);
  assert.equal(continueRequest?.kind, "continue-request");
  if (!continueRequest || continueRequest.kind !== "continue-request") {
    assert.fail("缺少 TaskReview 的 continue-request 消息");
  }
  assert.equal(continueRequest.followUpMessageId, taskDecisionFinal.id);
  assert.equal(
    continueRequest.content,
    "当前证据链还不完整，请继续补充实现依据。\n\n<chalenge>请继续补充实现依据。</chalenge>\n\n@Build",
  );
});

test("判定 Agent 执行中止时不会伪造成整改意见", async () => {
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
      agentId: string,
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
  typed.ensureAgentSession = async () => "session-code-decision";
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
      agentMessage: "请判定本轮改动",
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
      agentId: string,
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
        agentId: string,
        status: "idle" | "completed" | "failed" | "running" | "continue",
      ) => void;
    };
  };
  stubOpenCodeAttachBaseUrl(orchestrator);

  typed.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
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
  assert.equal(snapshot.task.status, "finished");

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
        message.kind === "task-round-finished" &&
        message.content.includes("本轮已完成，可继续 @Agent 发起下一轮。"),
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
    ensureAgentSession: (task: { id: string; cwd: string }, agent: { id: string }) => Promise<string>;
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
    mentionAgentId: "Build",
  });

  typed.ensureTaskPanels = async () => undefined;
  typed.ensureAgentSession = async (_task, agent) => `session:${agent.id}`;
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
    ensureAgentSession: (task: { id: string; cwd: string }, agent: { id: string }) => Promise<string>;
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
        { source: "UnitTest", target: "Build", triggerOn: "continue", maxContinueRounds: 2, messageMode: "last" },
      ],
    },
  });

  const task = await orchestrator.submitTask({
    cwd: project.cwd,
    content: "@Build 请完成需求并通过 UnitTest",
    mentionAgentId: "Build",
  });

  typed.ensureTaskPanels = async () => undefined;
  typed.ensureAgentSession = async (_task, agent) => `session:${agent.id}`;
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

test("并发判定失败时不会提前追加任务结束系统消息", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();

  let releaseUnitTest: () => void = () => undefined;
  const unitTestGate = new Promise<void>((resolve) => {
    releaseUnitTest = resolve;
  });
  let releaseTaskReview: () => void = () => undefined;
  const taskDecisionGate = new Promise<void>((resolve) => {
    releaseTaskReview = resolve;
  });
  let unitTestStarted = false;
  let taskDecisionStarted = false;
  let buildRunCount = 0;
  let unitTestRunCount = 0;
  let taskDecisionRunCount = 0;

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

  typed.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async ({ agent }) => {
    if (agent === "Build") {
      buildRunCount += 1;
      return buildCompletedExecutionResult({
        agent,
        finalMessage: buildRunCount === 1 ? "Build 已完成" : "Build 已修复 decisionAgent 意见。",
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

    taskDecisionRunCount += 1;
    taskDecisionStarted = true;
    if (taskDecisionRunCount === 1) {
      await taskDecisionGate;
    }
    return buildCompletedExecutionResult({
      agent,
      finalMessage:
        taskDecisionRunCount === 1
          ? "TaskReview 未通过。\n\n<continue>请修复 TaskReview。</continue>"
          : "TaskReview 通过。\n\n<complete>同意当前结果。</complete>",
      messageId: `message:TaskReview:${taskDecisionRunCount}`,
      timestamp: `2026-04-17T00:00:2${taskDecisionRunCount - 1}.000Z`,
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
    () => unitTestStarted && taskDecisionStarted,
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
      && taskDecisionRunCount === 2,
  );

  const failedCompletionMessages = finishedSnapshot.messages.filter(
    (message) =>
      message.sender === "system"
      && message.kind === "task-completed"
      && message.status === "failed",
  );
  assert.equal(failedCompletionMessages.length, 0);
});

test("重新派发 stale decisionAgent 的 dispatch 窗口里，不会被 getTaskSnapshot 提前补成 finished", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();

  let releaseRedispatchSummary: () => void = () => undefined;
  const redispatchSummaryGate = new Promise<void>((resolve) => {
    releaseRedispatchSummary = resolve;
  });
  let buildRunCount = 0;
  let unitTestRunCount = 0;
  let taskDecisionRunCount = 0;

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
    buildProjectGitDiffSummary: (cwd: string) => Promise<string>;
  };
  stubOpenCodeAttachBaseUrl(orchestrator);

  typed.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.buildProjectGitDiffSummary = async () => {
    if (buildRunCount >= 2 && taskDecisionRunCount === 1) {
      await redispatchSummaryGate;
    }
    return "";
  };
  typed.opencodeRunner.run = async ({ agent }) => {
    if (agent === "Build") {
      buildRunCount += 1;
      return buildCompletedExecutionResult({
        agent,
        finalMessage: buildRunCount === 1 ? "Build 首轮实现完成。" : "Build 已根据 UnitTest 意见修复完成。",
        messageId: `message:Build:${buildRunCount}`,
        timestamp: `2026-04-24T15:37:1${buildRunCount}.000Z`,
      });
    }

    if (agent === "UnitTest") {
      unitTestRunCount += 1;
      return buildCompletedExecutionResult({
        agent,
        finalMessage:
          unitTestRunCount === 1
            ? "UnitTest 未通过。\n\n<continue>请修复 UnitTest。</continue>"
            : "UnitTest 通过。\n\n<complete>同意当前结果。</complete>",
        messageId: `message:UnitTest:${unitTestRunCount}`,
        timestamp: `2026-04-24T15:37:2${unitTestRunCount}.000Z`,
      });
    }

    taskDecisionRunCount += 1;
    return buildCompletedExecutionResult({
      agent,
      finalMessage: "TaskReview 通过。\n\n<complete>同意当前结果。</complete>",
      messageId: `message:TaskReview:${taskDecisionRunCount}`,
      timestamp: `2026-04-24T15:37:3${taskDecisionRunCount}.000Z`,
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
      ],
    },
  });

  const submittedTask = await orchestrator.submitTask({
    cwd: project.cwd,
    content: "@Build 请完成这个需求。",
  });

  const snapshotDuringRedispatchWindow = await waitForTaskSnapshot(
    orchestrator,
    submittedTask.task.id,
    (snapshot) =>
      buildRunCount === 2
      && taskDecisionRunCount === 1
      && snapshot.messages.some(
        (message) =>
          message.sender === "Build"
          && message.kind === "agent-dispatch"
          && getMessageTargetAgentIds(message).includes("TaskReview"),
      ),
    8000,
  );

  assert.notEqual(snapshotDuringRedispatchWindow.task.status, "finished");
  assert.equal(
    snapshotDuringRedispatchWindow.messages.some(
      (message) =>
        message.sender === "system"
        && message.kind === "task-round-finished",
    ),
    false,
  );

  releaseRedispatchSummary();

  const settledSnapshot = await waitForTaskSnapshot(
    orchestrator,
    submittedTask.task.id,
    (snapshot) =>
      snapshot.task.status === "finished"
      && taskDecisionRunCount === 2,
    8000,
  );

  assert.equal(
    settledSnapshot.messages.some(
      (message) =>
        message.sender === "system"
        && message.kind === "task-round-finished",
    ),
    true,
  );
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
