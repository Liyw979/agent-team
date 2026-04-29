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
  type TaskAgentRecord,
  type TaskRecord,
  type TopologyRecord,
} from "@shared/types";
import type { OpenCodeExecutionResult } from "./opencode-client";
import { Orchestrator, isTerminalTaskStatus } from "./orchestrator";
import { buildAgentSystemPrompt } from "./agent-system-prompt";
import { compileBuiltinVulnerabilityTopology } from "./builtin-topology-test-helpers";
import { parseDecision as parseDecisionPure } from "./decision-parser";
import type { GraphDispatchBatch, GraphAgentResult } from "./gating-router";
import type { GraphTaskState } from "./gating-state";
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

type InjectedReadonlyPermission = Record<
  "write" | "edit" | "bash" | "task" | "patch" | "webfetch" | "websearch",
  "deny"
>;

type InjectedAgentConfig =
  | {
      mode: "primary";
      prompt: string;
    }
  | {
      mode: "primary";
      prompt: string;
      permission: InjectedReadonlyPermission;
    };

type TestWorkspaceAgentInput = {
  id: string;
  prompt: string;
  isWritable: boolean;
};

function getTestAgentPrompt(agentId: string): string {
  const prompt = TEST_AGENT_PROMPTS[agentId];
  if (prompt === undefined) {
    assert.fail(`缺少测试 Agent prompt：${agentId}`);
  }
  return prompt;
}

function parseInjectedAgents(content: string): Record<string, InjectedAgentConfig> {
  return (JSON.parse(content) as { agent: Record<string, InjectedAgentConfig> }).agent;
}

const activeOrchestrators = new Set<Orchestrator>();

type TestBatchRunner = {
  id: string;
  agentId: string;
  promise: Promise<GraphAgentResult>;
};

type TestRunAgentPrompt =
  | {
      mode: "raw";
      content: string;
      from: string;
    }
  | {
      mode: "structured";
      from: string;
      agentMessage: string;
    };

type TestOrchestratorDependencies = {
  createLangGraphBatchRunners: (
    cwd: string,
    taskId: string,
    state: GraphTaskState,
    batch: GraphDispatchBatch,
  ) => Promise<TestBatchRunner[]>;
  trackBackgroundTask: (
    promise: Promise<void>,
    context: { taskId: string; agentId: string },
  ) => void;
  buildProjectGitDiffSummary: (cwd: string) => Promise<string>;
  ensureAgentSession: (task: TaskRecord, agent: TaskAgentRecord) => Promise<string>;
  ensureTaskPanels: (task: TaskRecord) => Promise<void>;
};

type ConfigureTestOrchestratorDependencies = (
  defaults: TestOrchestratorDependencies,
) => TestOrchestratorDependencies;

class TestOrchestrator extends Orchestrator {
  private readonly dependencies: TestOrchestratorDependencies;

  constructor(
    options: ConstructorParameters<typeof Orchestrator>[0],
    configureDependencies: ConfigureTestOrchestratorDependencies = (defaults) => defaults,
  ) {
    super(options);
    const defaults: TestOrchestratorDependencies = {
      trackBackgroundTask: (promise, context) => super.trackBackgroundTask(promise, context),
      createLangGraphBatchRunners: (cwd, taskId, state, batch) =>
        super.createLangGraphBatchRunners(cwd, taskId, state, batch),
      buildProjectGitDiffSummary: (cwd) => super.buildProjectGitDiffSummary(cwd),
      ensureAgentSession: (task, agent) => super.ensureAgentSession(task, agent),
      ensureTaskPanels: (task) => super.ensureTaskPanels(task),
    };
    this.dependencies = configureDependencies(defaults);
    activeOrchestrators.add(this);
  }

  protected override trackBackgroundTask(
    promise: Promise<void>,
    context: { taskId: string; agentId: string },
  ) {
    this.dependencies.trackBackgroundTask(promise, context);
  }

  protected override async createLangGraphBatchRunners(
    cwd: string,
    taskId: string,
    state: GraphTaskState,
    batch: GraphDispatchBatch,
  ) {
    return this.dependencies.createLangGraphBatchRunners(cwd, taskId, state, batch);
  }

  protected override async buildProjectGitDiffSummary(cwd: string): Promise<string> {
    return this.dependencies.buildProjectGitDiffSummary(cwd);
  }

  protected override async ensureAgentSession(task: TaskRecord, agent: TaskAgentRecord) {
    return this.dependencies.ensureAgentSession(task, agent);
  }

  protected override async ensureTaskPanels(task: TaskRecord) {
    return this.dependencies.ensureTaskPanels(task);
  }
}

type StandaloneAgentRunInput = {
  cwd: string;
  task: TaskRecord;
  agentId: string;
  prompt: TestRunAgentPrompt;
};

class StandaloneRunTestOrchestrator extends TestOrchestrator {
  public runStandaloneAgent(input: StandaloneAgentRunInput) {
    return this.runAgent(input.cwd, input.task, input.agentId, input.prompt, {
      followTopology: false,
    });
  }
}

function withTaskPanelsAndSessions(
  resolveSessionId: (task: TaskRecord, agent: TaskAgentRecord) => string,
): ConfigureTestOrchestratorDependencies {
  return (defaults) => ({
    ...defaults,
    ensureTaskPanels: async () => undefined,
    ensureAgentSession: async (task, agent) => resolveSessionId(task, agent),
  });
}

function stubOpenCodeSessions(orchestrator: Orchestrator) {
  orchestrator.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  orchestrator.opencodeClient.getAttachBaseUrl = async () => "http://127.0.0.1:43127";
  stubOpenCodeReloadConfig(orchestrator);
}

function stubOpenCodeAttachBaseUrl(orchestrator: Orchestrator) {
  orchestrator.opencodeClient.getAttachBaseUrl = async () => "http://127.0.0.1:43127";
}

function stubOpenCodeReloadConfig(orchestrator: Orchestrator) {
  Reflect.set(orchestrator.opencodeClient, "reloadConfig", async () => undefined);
}

function buildCompletedExecutionResult(input: {
  agent: string;
  finalMessage: string;
  messageId: string;
  timestamp: string;
}): OpenCodeExecutionResult {
  return {
    status: "completed",
    finalMessage: input.finalMessage,
    messageId: input.messageId,
    timestamp: input.timestamp,
    rawMessage: {
      id: input.messageId,
      content: input.finalMessage,
      sender: input.agent,
      timestamp: input.timestamp,
      completedAt: input.timestamp,
      error: null,
      raw: null,
    },
  };
}

function buildErrorExecutionResult(input: {
  agent: string;
  finalMessage: string;
  messageId: string;
  timestamp: string;
  error: string;
}): OpenCodeExecutionResult {
  return {
    status: "error",
    finalMessage: input.finalMessage,
    messageId: input.messageId,
    timestamp: input.timestamp,
    rawMessage: {
      id: input.messageId,
      content: input.finalMessage,
      sender: input.agent,
      timestamp: input.timestamp,
      completedAt: null,
      error: input.error,
      raw: null,
    },
  };
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
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  await orchestrator.getWorkspaceSnapshot(workspacePath);

  assert.equal(fs.existsSync(path.join(workspacePath, ".agent-team", LEGACY_WORKSPACE_STATE_BASENAME)), false);
});

function buildTeamDslFromWorkspaceSnapshot(input: {
  workspace: Awaited<ReturnType<Orchestrator["getWorkspaceSnapshot"]>>;
  entryAgentId: string;
  nextAgents: TestWorkspaceAgentInput[];
}): TeamDslDefinition {
  const workspaceAgents = new Map(
    input.workspace.agents.map((agent) => [agent.id, agent]),
  );
  return {
    entry: input.entryAgentId,
    nodes: [...new Set([...input.workspace.topology.nodes, ...input.nextAgents.map((agent) => agent.id)])].map((name) => {
      const nextAgent = input.nextAgents.find((agent) => agent.id === name);
      if (nextAgent) {
        return {
          type: "agent" as const,
          id: name,
          prompt: nextAgent.prompt,
          writable: nextAgent.isWritable,
        };
      }

      const existingAgent = workspaceAgents.get(name);
      if (!existingAgent) {
        assert.fail(`工作区 Agent 缺失：${name}`);
      }
      return {
        type: "agent" as const,
        id: name,
        prompt: existingAgent.prompt,
        writable: existingAgent.isWritable === true,
      };
    }),
    links: input.workspace.topology.edges.map((edge) => ({
      from: edge.source,
      to: edge.target,
      trigger: edge.trigger,
      message_type: edge.messageMode,
    })),
  };
}

async function replaceWorkspaceAgents(
  orchestrator: Orchestrator,
  cwd: string,
  entryAgentId: string,
  nextAgents: TestWorkspaceAgentInput[],
) {
  const current = await orchestrator.getWorkspaceSnapshot(cwd);
  const compiled = compileTeamDsl(buildTeamDslFromWorkspaceSnapshot({
    workspace: current,
    entryAgentId,
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
  entryAgentId: string,
  writableAgentIds: string[],
) {
  let latestWorkspace = await orchestrator.getWorkspaceSnapshot(cwd);
  const writableAgentIdSet = new Set(writableAgentIds);
  for (const agentId of agentIds) {
    const nextAgents = [...latestWorkspace.agents];
    const existingIndex = nextAgents.findIndex((agent) => agent.id === agentId);
    const nextAgent: TestWorkspaceAgentInput = {
      id: agentId,
      prompt: getTestAgentPrompt(agentId),
      isWritable: writableAgentIdSet.has(agentId),
    };
    if (existingIndex >= 0) {
      nextAgents[existingIndex] = nextAgent;
    } else {
      nextAgents.push(nextAgent);
    }
    latestWorkspace = await replaceWorkspaceAgents(orchestrator, cwd, entryAgentId, nextAgents);
  }
  return latestWorkspace;
}

async function addCustomAgent(
  orchestrator: Orchestrator,
  cwd: string,
  agentId: string,
  prompt: string,
  entryAgentId: string,
  isWritable: boolean,
) {
  const current = await orchestrator.getWorkspaceSnapshot(cwd);
  const nextAgents = [...current.agents];
  const existingIndex = nextAgents.findIndex((agent) => agent.id === agentId);
  const nextAgent: TestWorkspaceAgentInput = {
    id: agentId,
    prompt,
    isWritable,
  };
  if (existingIndex >= 0) {
    nextAgents[existingIndex] = nextAgent;
  } else {
    nextAgents.push(nextAgent);
  }
  return replaceWorkspaceAgents(orchestrator, cwd, entryAgentId, nextAgents);
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
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(orchestrator);

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build"], "Build", ["Build"]);
  const task = await orchestrator.initializeTask({ cwd: project.cwd, title: "demo" });

  assert.equal(task.task.cwd, project.cwd);
  assert.equal(task.messages.some((message) => /session/i.test(message.content)), false);
  assert.equal(task.agents.some((agent) => agent.id === "Build"), true);
  assert.equal(task.task.cwd, projectPath);
});

test("漏洞团队任务初始化时不会为仅作为 spawn 模板存在的静态 agent 预建 session", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
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
  const clueFinder = agentByName.get("线索发现");
  const vulnerabilityArguer = agentByName.get("漏洞论证");
  const vulnerabilityChallenger = agentByName.get("漏洞挑战");
  const summaryAgent = agentByName.get("讨论总结");
  if (!clueFinder || !vulnerabilityArguer || !vulnerabilityChallenger || !summaryAgent) {
    assert.fail("漏洞团队初始化后缺少预期 Agent");
  }

  assert.equal(clueFinder.opencodeSessionId, "session:vuln-demo:线索发现");
  assert.equal(vulnerabilityArguer.opencodeSessionId, null);
  assert.equal(vulnerabilityChallenger.opencodeSessionId, null);
  assert.equal(summaryAgent.opencodeSessionId, null);
});

test("单节点任务进入 finished 时不会因为缺少 workspace cwd 而在后台崩溃", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  let backgroundRun: Promise<void> = Promise.resolve();
  let backgroundRunTracked = false;
  const orchestrator = new TestOrchestrator(
    {
      userDataPath,
      enableEventStream: false,
    },
    (defaults) => ({
      ...defaults,
      trackBackgroundTask: (promise) => {
        backgroundRunTracked = true;
        backgroundRun = promise.then(() => undefined);
      },
      createLangGraphBatchRunners: async () => [],
    }),
  );
  stubOpenCodeAttachBaseUrl(orchestrator);
  orchestrator.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  stubOpenCodeReloadConfig(orchestrator);
  orchestrator.opencodeRunner.run = async ({ agent }) =>
    buildCompletedExecutionResult({
      agent,
      finalMessage: `${agent} 已完成本轮处理。`,
      messageId: `message:${agent}:finished`,
      timestamp: "2026-04-22T00:00:00.000Z",
    });

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addCustomAgent(orchestrator, project.cwd, "BA", "你是 BA。", "BA", false);
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

  assert.equal(backgroundRunTracked, true);
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
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeAttachBaseUrl(orchestrator);

  let baRunCount = 0;
  let releaseSecondRound: () => void = () => undefined;
  const secondRoundGate = new Promise<void>((resolve) => {
    releaseSecondRound = resolve;
  });

  orchestrator.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  stubOpenCodeReloadConfig(orchestrator);
  orchestrator.opencodeRunner.run = async ({ agent }) => {
    baRunCount += 1;
    if (baRunCount === 2) {
      await secondRoundGate;
    }
    return buildCompletedExecutionResult({
      agent,
      finalMessage: `${agent} 第 ${baRunCount} 轮已完成。`,
      messageId: `message:${agent}:${baRunCount}`,
      timestamp: `2026-04-22T00:00:0${baRunCount}.000Z`,
    });
  };

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addCustomAgent(orchestrator, project.cwd, "BA", "你是 BA。", "BA", false);
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

test("漏洞团队里漏洞挑战先返回触发回流的 label、漏洞论证回应后才会继续派发到讨论总结", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeAttachBaseUrl(orchestrator);

  const runCountByAgent = new Map<string, number>();
  const nextCount = (agent: string) => {
    const next = (runCountByAgent.get(agent) ?? 0) + 1;
    runCountByAgent.set(agent, next);
    return next;
  };

  orchestrator.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  stubOpenCodeReloadConfig(orchestrator);
  orchestrator.opencodeRunner.run = async ({ agent }) => {
    const count = nextCount(agent);
    if (agent === "线索发现" && count === 1) {
      return {
        ...buildCompletedExecutionResult({
          agent,
          finalMessage: [
            "HTTP/2 请求未强制要求 :authority 或 host",
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
        ...buildCompletedExecutionResult({
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
        ...buildCompletedExecutionResult({
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
        ...buildCompletedExecutionResult({
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

    return buildCompletedExecutionResult({
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
      const dispatchMessage = orchestrator.store.listMessages(projectPath, task.task.id).findLast(
        (message) => message.kind === "action-required-request" && message.sender === "线索发现",
      );
      if (!dispatchMessage) {
        return "";
      }
      const [targetAgentId] = getMessageTargetAgentIds(dispatchMessage);
      return typeof targetAgentId === "string" ? targetAgentId : "";
    },
    (value) => value.startsWith("漏洞挑战-"),
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

test("漏洞团队里讨论总结以 transfer + none 回到线索发现时，会下发对应的继续查找请求", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeAttachBaseUrl(orchestrator);

  const promptByAgent = new Map<string, string[]>();
  const recordPrompt = (agent: string, content: string) => {
    const current = promptByAgent.get(agent) ?? [];
    current.push(content);
    promptByAgent.set(agent, current);
    return current.length;
  };

  orchestrator.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  stubOpenCodeReloadConfig(orchestrator);
  orchestrator.opencodeRunner.run = async ({ agent, content }) => {
    const count = recordPrompt(agent, content);
    if (agent === "线索发现") {
      return buildCompletedExecutionResult({
        agent,
        finalMessage:
          count === 1
            ? [
              "HTTP/2 请求未强制要求 :authority 或 host",
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

  const clueFinderPrompts = promptByAgent.get("线索发现");
  if (clueFinderPrompts === undefined) {
    assert.fail("缺少线索发现转发记录");
  }
  const secondPrompt = clueFinderPrompts[1] ?? "";
  assert.equal(secondPrompt, "[no-forwarded-message]");
  assert.doesNotMatch(secondPrompt, /更像误报|稳定判断/u);
});

test("漏洞团队第二轮 finding 已经派发到 漏洞挑战-2 时，UI 仍能看到线索发现的第二轮消息", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeAttachBaseUrl(orchestrator);

  const runCountByAgent = new Map<string, number>();
  const nextCount = (agent: string) => {
    const next = (runCountByAgent.get(agent) ?? 0) + 1;
    runCountByAgent.set(agent, next);
    return next;
  };

  orchestrator.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  stubOpenCodeReloadConfig(orchestrator);
  orchestrator.opencodeRunner.run = async ({ agent }) => {
    const count = nextCount(agent);

    if (agent === "线索发现") {
      if (count === 1) {
        return buildCompletedExecutionResult({
          agent,
          finalMessage: [
            "上传文件名可能被直接拼进目标路径",
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
            "内部调试接口似乎缺少鉴权",
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
  let gitSummaryCallCount = 0;
  let releaseGitSummary: (value: string) => void = () => undefined;
  const gitSummaryBlocked = new Promise<string>((resolve) => {
    releaseGitSummary = resolve;
  });

  const orchestrator = new TestOrchestrator(
    {
      userDataPath,
      enableEventStream: false,
    },
    (defaults) => ({
      ...defaults,
      buildProjectGitDiffSummary: async () => {
        gitSummaryCallCount += 1;
        if (gitSummaryCallCount === 1) {
          return "";
        }
        return gitSummaryBlocked;
      },
    }),
  );
  stubOpenCodeSessions(orchestrator);
  orchestrator.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  stubOpenCodeReloadConfig(orchestrator);
  orchestrator.opencodeRunner.run = async ({ agent }) => {
    if (agent === "线索发现") {
      return {
        ...buildCompletedExecutionResult({
          agent,
          finalMessage: [
            "HTTP/2 请求未强制要求 :authority 或 host",
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

  const taskAgentIdsDuringDispatchWindow = orchestrator.store
    .listTaskAgents(projectPath, task.task.id)
    .map((agent) => agent.id);

  const snapshotDuringDispatchWindow = await orchestrator.getTaskSnapshot(task.task.id, projectPath);

  assert.notEqual(snapshotDuringDispatchWindow.task.status, "finished");
  assert.equal(
    snapshotDuringDispatchWindow.messages.some(
      (message) => message.kind === "task-round-finished",
    ),
    false,
  );
  assert.equal(snapshotDuringDispatchWindow.task.status, "action_required");

  releaseGitSummary("");
  const settledSnapshot = await waitForTaskSnapshot(
    orchestrator,
    task.task.id,
    (current) => current.task.status === "failed",
    3000,
  );
  const continueRequestMessage = settledSnapshot.messages.findLast(
    (message) => message.kind === "action-required-request" && message.sender === "线索发现",
  );
  if (!continueRequestMessage) {
    assert.fail("缺少线索发现的 action-required 请求消息");
  }
  const [runtimeAgentIdFromContinue] = getMessageTargetAgentIds(continueRequestMessage);
  if (typeof runtimeAgentIdFromContinue !== "string") {
    assert.fail("缺少 runtime 漏洞挑战 Agent id");
  }
  assert.equal(runtimeAgentIdFromContinue.startsWith("漏洞挑战-"), true);
  assert.equal(taskAgentIdsDuringDispatchWindow.includes(runtimeAgentIdFromContinue), false);
  assert.equal(settledSnapshot.task.status, "failed");
});

test("initializeTask reuses a preallocated task id when provided", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(orchestrator);

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build"], "Build", ["Build"]);
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

  const writer = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(writer);

  let workspace = await writer.getWorkspaceSnapshot(workspacePath);
  workspace = await replaceWorkspaceAgents(writer, workspace.cwd, "Build", [
    { id: "Build", prompt: getTestAgentPrompt("Build"), isWritable: true },
    { id: "BA", prompt: getTestAgentPrompt("BA"), isWritable: false },
  ]);

  const created = await writer.initializeTask({
    cwd: workspace.cwd,
    title: "跨工作区 show",
  });
  const taskId = created.task.id;

  await writer.dispose();
  activeOrchestrators.delete(writer);

  const reader = new TestOrchestrator({
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
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(orchestrator);

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build"], "Build", []);
  const task = await orchestrator.initializeTask({ cwd: project.cwd, title: "demo" });

  assert.equal(task.messages.some((message) => message.kind === undefined), false);
});

test("OpenCode 事件会触发 runtime-updated 前端事件", async () => {
  type RuntimeUpdatedEvent = {
    type: "runtime-updated";
    cwd: string;
    payload: {
      taskId: string;
      sessionId: string;
    };
  };

  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: true,
    runtimeRefreshDebounceMs: 1,
  });
  const sentEvents: unknown[] = [];
  const unsubscribe = orchestrator.subscribe((event) => {
    sentEvents.push(event);
  });

  let eventHandler: (event: unknown) => void = () => undefined;
  orchestrator.opencodeClient.connectEvents = async (target, onEvent) => {
    void target;
    eventHandler = onEvent as (event: unknown) => void;
  };
  orchestrator.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  orchestrator.opencodeClient.getAttachBaseUrl = async () => "http://127.0.0.1:43127";

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build"], "Build", []);
  const task = await orchestrator.initializeTask({ cwd: project.cwd, title: "demo" });
  eventHandler({
    type: "session.updated",
    properties: {
      sessionID: "session-build-1",
    },
  });
  const runtimeUpdatedEvent = await waitForValue(
    async () =>
      sentEvents.find((event): event is RuntimeUpdatedEvent => {
        if (typeof event !== "object" || event === null) {
          return false;
        }
        const candidate = event as Partial<RuntimeUpdatedEvent>;
        return (
          candidate.type === "runtime-updated" &&
          typeof candidate.cwd === "string" &&
          candidate.payload !== undefined &&
          typeof candidate.payload.taskId === "string" &&
          typeof candidate.payload.sessionId === "string"
        );
      }),
    (event): event is RuntimeUpdatedEvent => event !== undefined,
    500,
  );
  if (runtimeUpdatedEvent === undefined) {
    assert.fail("应当收到 runtime-updated 事件");
  }

  assert.equal(runtimeUpdatedEvent.cwd, project.cwd);
  assert.equal(runtimeUpdatedEvent.payload.taskId, task.task.id);
  assert.equal(runtimeUpdatedEvent.payload.sessionId, "session-build-1");
  unsubscribe();
});

test("dispose 之后，迟到结束的 event stream 不会再排 reconnect 定时器", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: true,
  });

  let releaseConnectEvents: () => void = () => undefined;
  orchestrator.opencodeClient.connectEvents = async () =>
    new Promise<void>((resolve) => {
      releaseConnectEvents = resolve;
    });

  await orchestrator.getWorkspaceSnapshot(projectPath);
  await orchestrator.dispose();
  releaseConnectEvents();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(orchestrator.pendingEventReconnects.size, 0);
});

test("dispose 在 CLI 快速退出模式下不会等待悬挂的后台 task promise", async () => {
  const userDataPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  let shutdownCalled = false;
  orchestrator.opencodeClient.shutdown = async () => {
    shutdownCalled = true;
    return {
      killedPids: [43127],
    };
  };
  orchestrator.pendingTaskRuns.add(new Promise<void>(() => undefined));

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
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  orchestrator.opencodeClient.shutdown = async () => ({
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
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  const project = await orchestrator.getWorkspaceSnapshot(projectPath);

  assert.deepEqual(project.agents, []);
});

test("Build 只有在团队 DSL 中声明后才会出现在 agents", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  const project = await orchestrator.getWorkspaceSnapshot(projectPath);
  assert.equal(project.agents.some((agent) => agent.id === "Build"), false);

  const withBuild = await addBuiltinAgents(orchestrator, project.cwd, ["Build"], "Build", ["Build"]);
  const buildAgent = withBuild.agents.find((agent) => agent.id === "Build");
  if (!buildAgent) {
    assert.fail("缺少 Build Agent");
  }
  assert.equal(withBuild.agents.some((agent) => agent.id === "Build"), true);
  assert.equal(buildAgent.isWritable, true);
  assert.equal(buildInjectedConfigFromAgents(withBuild.agents), null);
});

test("applyTeamDsl 会一次性写入当前 Project 的 agents 与 topology", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
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
        prompt: getTestAgentPrompt("BA"),
        writable: false,
      },
      {
        type: "agent",
        id: "SecurityResearcher",
        prompt: "你负责漏洞挖掘。必须输出 <continue>。",
        writable: false,
      },
    ],
    links: [
      { from: "BA", to: "Build", trigger: "<default>", message_type: "last" },
      { from: "Build", to: "SecurityResearcher", trigger: "<default>", message_type: "last" },
      { from: "SecurityResearcher", to: "Build", trigger: "<continue>", message_type: "last" },
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
  const securityResearcher = updated.agents.find((agent) => agent.id === "SecurityResearcher");
  if (!securityResearcher) {
    assert.fail("缺少 SecurityResearcher");
  }
  assert.equal(
    securityResearcher.prompt,
    "你负责漏洞挖掘。必须输出 <continue>。",
  );
  assert.deepEqual(updated.topology.edges, [
    { source: "BA", target: "Build", trigger: "<default>", messageMode: "last" },
    { source: "Build", target: "SecurityResearcher", trigger: "<default>", messageMode: "last" },
    {
      source: "SecurityResearcher",
      target: "Build",
      trigger: "<continue>",
      messageMode: "last",
    },
  ]);
});

test("applyTeamDsl 会直接以 DSL prompt 为唯一真源", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
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
      { from: "BA", to: "Build", trigger: "<default>", message_type: "last" },
    ],
  });

  const updated = await orchestrator.applyTeamDsl({
    cwd: project.cwd,
    compiled,
  });
  const baAgent = updated.agents.find((agent) => agent.id === "BA");
  if (!baAgent) {
    assert.fail("缺少 BA Agent");
  }

  assert.equal(
    baAgent.prompt,
    "DSL BA prompt",
  );
});

test("保存拓扑后不会再生成旧工作区快照文件", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build"], "Build", ["Build"]);
  project = await addCustomAgent(orchestrator, project.cwd, "BA", "你是 BA。", "Build", false);

  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["BA", "Build"],
      edges: [{ source: "BA", target: "Build", trigger: "<default>", messageMode: "last" }],
    },
  });

  assert.equal(fs.existsSync(path.join(projectPath, ".agent-team", LEGACY_WORKSPACE_STATE_BASENAME)), false);
});

test("保存拓扑时不会再把 langgraph.end.sources 隐式恢复成无 trigger 结束边", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addCustomAgent(orchestrator, project.cwd, "漏洞论证", "你负责漏洞论证。", "漏洞论证", false);

  const saved = await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      nodes: ["漏洞论证"],
      edges: [],
      langgraph: {
        start: {
          id: "__start__",
          targets: ["漏洞论证"],
        },
        end: {
          id: "__end__",
          sources: ["漏洞论证"],
          incoming: [],
        },
      },
    },
  });

  assert.equal(saved.topology.langgraph?.end, null);
});

test("保存拓扑时会把 target=__end__ 的 trigger 边提升到 langgraph.end.incoming", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addCustomAgent(orchestrator, project.cwd, "漏洞论证", "你负责漏洞论证。", "漏洞论证", false);

  const saved = await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      nodes: ["漏洞论证"],
      edges: [
        {
          source: "漏洞论证",
          target: "__end__",
          trigger: "<done>",
          messageMode: "last",
        },
      ],
    },
  });

  assert.deepEqual(saved.topology.edges, []);
  assert.deepEqual(saved.topology.langgraph?.end, {
    id: "__end__",
    sources: ["漏洞论证"],
    incoming: [
      {
        source: "漏洞论证",
        trigger: "<done>",
      },
    ],
  });
});

test("保存拓扑后会把动态 spawn 团队配置保留在当前运行时快照里", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build"], "Build", []);
  project = await addCustomAgent(orchestrator, project.cwd, "线索发现", "你负责线索发现。", "Build", false);
  project = await addCustomAgent(orchestrator, project.cwd, "漏洞论证模板", "你负责漏洞论证。", "Build", false);
  project = await addCustomAgent(orchestrator, project.cwd, "漏洞挑战模板", "你负责漏洞挑战。", "Build", false);
  project = await addCustomAgent(orchestrator, project.cwd, "Summary模板", "你是总结。", "Build", false);

  const saved = await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["Build", "线索发现", "漏洞论证模板", "漏洞挑战模板", "Summary模板"],
      edges: [{ source: "Build", target: "线索发现", trigger: "<default>", messageMode: "last" }],
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
            { sourceRole: "pro", targetRole: "con", trigger: "<continue>", messageMode: "last" },
            { sourceRole: "con", targetRole: "pro", trigger: "<continue>", messageMode: "last" },
            { sourceRole: "pro", targetRole: "summary", trigger: "<complete>", messageMode: "last" },
            { sourceRole: "con", targetRole: "summary", trigger: "<complete>", messageMode: "last" },
          ],
          exitWhen: "one_side_agrees",
          reportToTemplateName: "线索发现",
          reportToTrigger: "<default>",
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

test("保存拓扑时会拒绝缺少 reportToTrigger 的 spawn report 配置", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addCustomAgent(orchestrator, project.cwd, "线索发现", "你负责线索发现。", "线索发现", false);
  project = await addCustomAgent(orchestrator, project.cwd, "漏洞论证模板", "你负责漏洞论证。", "线索发现", false);

  await assert.rejects(
    () => orchestrator.saveTopology({
      cwd: project.cwd,
      topology: {
        ...project.topology,
        nodes: ["线索发现", "漏洞论证模板"],
        edges: [],
        nodeRecords: [
          { id: "线索发现", kind: "agent", templateName: "线索发现" },
          { id: "漏洞论证模板", kind: "agent", templateName: "漏洞论证模板" },
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
            ],
            edges: [],
            exitWhen: "one_side_agrees",
            reportToTemplateName: "线索发现",
          } as unknown as NonNullable<TopologyRecord["spawnRules"]>[number],
        ],
      },
    }),
    /必须显式声明 reportToTrigger/u,
  );
});

test("保存拓扑后会保留 spawnEnabled 标记，避免 GUI 点击后回读丢失", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build"], "Build", []);
  project = await addCustomAgent(orchestrator, project.cwd, "UnitTest", "你是 UnitTest。", "Build", false);
  project = await addCustomAgent(orchestrator, project.cwd, "BA", "你是 BA。", "Build", false);

  const saved = await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["Build", "UnitTest", "BA"],
      edges: [{ source: "Build", target: "UnitTest", trigger: "<default>", messageMode: "last" }],
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
          reportToTrigger: "<default>",
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
  type InjectedConfigContent = Parameters<
    TestOrchestrator["opencodeClient"]["setInjectedConfigContent"]
  >[1];

  const userDataPath = createTempDir();
  const projectAPath = createTempDir();
  const projectBPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  const injectedConfigs: InjectedConfigContent[] = [];
  orchestrator.opencodeClient.setInjectedConfigContent = (_projectPath, content) => {
    injectedConfigs.push(content);
  };
  orchestrator.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  orchestrator.opencodeClient.getAttachBaseUrl = async () => "http://127.0.0.1:43127";

  const projectA = await orchestrator.getWorkspaceSnapshot(projectAPath);
  await addCustomAgent(orchestrator, projectA.cwd, "BA", "你是 BA。\n只做需求分析。", "BA", false);
  let projectB = await orchestrator.getWorkspaceSnapshot(projectBPath);
  projectB = await addBuiltinAgents(orchestrator, projectB.cwd, ["Build"], "Build", []);

  await orchestrator.initializeTask({ cwd: projectB.cwd, title: "project-b" });
  await orchestrator.initializeTask({ cwd: projectA.cwd, title: "project-a" });

  assert.equal(injectedConfigs.length >= 2, true);
  assert.equal(injectedConfigs.some((content) => content === null), true);
  const latestInjectedConfig = injectedConfigs.at(-1);
  if (typeof latestInjectedConfig !== "string") {
    assert.fail("应当拿到 project-a 的注入配置");
  }
  assert.deepEqual(parseInjectedAgents(latestInjectedConfig)["BA"], {
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
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
    terminalLauncher: async (input) => {
      launches.push(input);
    },
  });

  stubOpenCodeSessions(orchestrator);
  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build"], "Build", []);
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
  const writer = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(writer);

  let project = await writer.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(writer, project.cwd, ["Build"], "Build", []);
  const created = await writer.initializeTask({ cwd: project.cwd, title: "demo" });
  const buildTaskAgent = created.agents[0];
  if (!buildTaskAgent) {
    assert.fail("缺少 Build 运行态 Agent");
  }

  assert.equal(buildTaskAgent.opencodeSessionId, "session:demo:Build");

  const reloaded = new TestOrchestrator({
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
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  const project = await orchestrator.getWorkspaceSnapshot(projectPath);
  await addCustomAgent(orchestrator, project.cwd, "BA", "你是 BA。", "BA", false);

  const injected = buildInjectedConfigFromAgents((await orchestrator.getWorkspaceSnapshot(project.cwd)).agents);
  if (injected === null) {
    assert.fail("BA 注入配置不能为空");
  }
  assert.deepEqual(parseInjectedAgents(injected)["BA"], {
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
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build"], "Build", ["Build"]);
  project = await addCustomAgent(orchestrator, project.cwd, "BA", "你是 BA。", "Build", true);

  assert.deepEqual(
    project.agents.map((agent) => [agent.id, agent.isWritable === true]),
    [
      ["Build", true],
      ["BA", true],
    ],
  );

  const injected = buildInjectedConfigFromAgents(project.agents);
  if (injected === null) {
    assert.fail("至少应当为 BA 生成注入配置");
  }
  assert.deepEqual(
    parseInjectedAgents(injected),
    {
      BA: {
        mode: "primary",
        prompt: "你是 BA。",
      },
    },
  );
});

test("多个自定义 Agent 可以同时保持可写", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addCustomAgent(orchestrator, project.cwd, "BA", "你是 BA。", "BA", true);
  project = await addCustomAgent(orchestrator, project.cwd, "QA", "你是 QA。", "BA", true);

  assert.deepEqual(
    project.agents.map((agent) => [agent.id, agent.isWritable === true]),
    [
      ["BA", true],
      ["QA", true],
    ],
  );
});

test("saveTopology 会保留同一 source target 下不同 trigger 的多条边", async () => {
  const orchestrator = new TestOrchestrator({
    userDataPath: createTempDir(),
    enableEventStream: false,
  });
  const projectPath = createTempDir();

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addCustomAgent(orchestrator, project.cwd, "漏洞论证", "你负责漏洞论证。", "漏洞论证", false);
  project = await addCustomAgent(orchestrator, project.cwd, "漏洞挑战", "你负责漏洞挑战。", "漏洞论证", false);

  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["漏洞论证", "漏洞挑战"],
      edges: [
        {
          source: "漏洞论证",
          target: "漏洞挑战",
          trigger: "<first>",
          messageMode: "last",
          maxTriggerRounds: 2,
        },
        {
          source: "漏洞论证",
          target: "漏洞挑战",
          trigger: "<second>",
          messageMode: "last-all",
          maxTriggerRounds: 5,
        },
      ],
    },
  });

  const snapshot = await orchestrator.getWorkspaceSnapshot(project.cwd);
  assert.deepEqual(snapshot.topology.edges, [
    {
      source: "漏洞论证",
      target: "漏洞挑战",
      trigger: "<first>",
      messageMode: "last",
      maxTriggerRounds: 2,
    },
    {
      source: "漏洞论证",
      target: "漏洞挑战",
      trigger: "<second>",
      messageMode: "last-all",
      maxTriggerRounds: 5,
    },
  ]);
});

test("saveTopology 允许同一 source 把同一个自定义 trigger 路由到多个下游", async () => {
  const orchestrator = new TestOrchestrator({
    userDataPath: createTempDir(),
    enableEventStream: false,
  });
  const projectPath = createTempDir();

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addCustomAgent(orchestrator, project.cwd, "漏洞论证", "你负责漏洞论证。", "漏洞论证", false);
  project = await addCustomAgent(orchestrator, project.cwd, "漏洞挑战", "你负责漏洞挑战。", "漏洞论证", false);
  project = await addCustomAgent(orchestrator, project.cwd, "讨论总结", "你负责讨论总结。", "漏洞论证", false);

  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["漏洞论证", "漏洞挑战", "讨论总结"],
      edges: [
        {
          source: "漏洞论证",
          target: "漏洞挑战",
          trigger: "<dup>",
          messageMode: "last",
        },
        {
          source: "漏洞论证",
          target: "讨论总结",
          trigger: "<dup>",
          messageMode: "last-all",
        },
      ],
    },
  });

  const snapshot = await orchestrator.getWorkspaceSnapshot(project.cwd);
  assert.deepEqual(snapshot.topology.edges, [
    {
      source: "漏洞论证",
      target: "漏洞挑战",
      trigger: "<dup>",
      messageMode: "last",
    },
    {
      source: "漏洞论证",
      target: "讨论总结",
      trigger: "<dup>",
      messageMode: "last-all",
    },
  ]);
});

test("saveTopology 会拒绝非尖括号 trigger", async () => {
  const orchestrator = new TestOrchestrator({
    userDataPath: createTempDir(),
    enableEventStream: false,
  });
  const projectPath = createTempDir();

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addCustomAgent(orchestrator, project.cwd, "线索发现", "你负责线索发现。", "线索发现", false);
  project = await addCustomAgent(orchestrator, project.cwd, "漏洞挑战", "你负责漏洞挑战。", "线索发现", false);

  await assert.rejects(
    () =>
      orchestrator.saveTopology({
        cwd: project.cwd,
        topology: {
          ...project.topology,
          nodes: ["线索发现", "漏洞挑战"],
          edges: [
            {
              source: "线索发现",
              target: "漏洞挑战",
              trigger: "bad",
              messageMode: "last",
            },
          ],
        },
      }),
    /非法拓扑 trigger/u,
  );
});

test("只有第一次 Agent 间传递会携带 [Initial Task]", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

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

  orchestrator.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  stubOpenCodeReloadConfig(orchestrator);
  orchestrator.opencodeRunner.run = async ({ agent, content }) => {
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
  project = await addBuiltinAgents(orchestrator, project.cwd, ["BA", "Build"], "BA", []);
  project = await addCustomAgent(orchestrator, project.cwd, "QA", "你是 QA。", "BA", false);
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["BA", "Build", "QA"],
      edges: [
        {
          source: "BA",
          target: "Build",
          trigger: "<default>",
          messageMode: "last",
        },
        {
          source: "Build",
          target: "QA",
          trigger: "<default>",
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

  const buildPrompts = promptByAgent.get("Build");
  const qaPrompts = promptByAgent.get("QA");
  if (buildPrompts === undefined || qaPrompts === undefined) {
    assert.fail("缺少 Build 或 QA 的转发记录");
  }
  assert.match(buildPrompts[0] ?? "", /\[Initial Task\]/u);
  assert.match(buildPrompts[0] ?? "", /\[From BA Agent\]/u);
  assert.match(qaPrompts[0] ?? "", /\[From Build Agent\]/u);
  assert.doesNotMatch(qaPrompts[0] ?? "", /\[Initial Task\]/u);
});

test("当前 Project 缺少 Build Agent 时，默认会从 start node 开始，显式 @Build 仍会被拒绝", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(orchestrator);
  orchestrator.opencodeRunner.run = async ({ agent }) =>
    buildCompletedExecutionResult({
      agent,
      finalMessage: `${agent} 已收到任务`,
      messageId: `message:${agent}`,
      timestamp: "2026-04-15T00:00:00.000Z",
    });

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addCustomAgent(orchestrator, project.cwd, "BA", "你是 BA。", "BA", false);

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
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

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

  orchestrator.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  stubOpenCodeReloadConfig(orchestrator);
  orchestrator.opencodeRunner.run = async ({ agent, content }) => {
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
  project = await addBuiltinAgents(orchestrator, project.cwd, ["BA", "Build", "CodeReview"], "BA", []);
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["BA", "Build", "CodeReview"],
      edges: [
        {
          source: "BA",
          target: "Build",
          trigger: "<default>",
          messageMode: "last",
        },
        {
          source: "Build",
          target: "CodeReview",
          trigger: "<default>",
          messageMode: "last",
        },
        {
          source: "CodeReview",
          target: "Build",
          trigger: "<continue>",
          maxTriggerRounds: 4,
          messageMode: "last",
        },
        {
          source: "CodeReview",
          target: "__end__",
          trigger: "<complete>",
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
  const buildPromptHistory = promptByAgent.get("Build");
  const codeReviewPromptHistory = promptByAgent.get("CodeReview");
  if (buildPromptHistory === undefined || codeReviewPromptHistory === undefined) {
    assert.fail("缺少 Build 或 CodeReview 的转发记录");
  }
  assert.match(buildPromptHistory[0] ?? "", /\[Initial Task\]/u);
  assert.match(buildPromptHistory[1] ?? "", /\[From CodeReview Agent\]/u);
  assert.match(buildPromptHistory[1] ?? "", /请修复构建结果/u);
  assert.doesNotMatch(codeReviewPromptHistory[0] ?? "", /\[Initial Task\]/u);
  assert.match(codeReviewPromptHistory[0] ?? "", /\[From Build Agent\]/u);
  assert.equal(buildPromptHistory.length, 2);
  assert.equal(codeReviewPromptHistory.length, 2);
});

test("修复首个失败 decisionAgent 后，Build 下一轮不会立刻全量重派全部 decisionAgent", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

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

  orchestrator.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  stubOpenCodeReloadConfig(orchestrator);
  orchestrator.opencodeRunner.run = async ({ agent }) => {
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
    "Build",
    [],
  );
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
      edges: [
        { source: "Build", target: "UnitTest", trigger: "<default>", messageMode: "last" },
        { source: "Build", target: "TaskReview", trigger: "<default>", messageMode: "last" },
        { source: "Build", target: "CodeReview", trigger: "<default>", messageMode: "last" },
        { source: "UnitTest", target: "Build", trigger: "<continue>", maxTriggerRounds: 4, messageMode: "last" },
        { source: "TaskReview", target: "Build", trigger: "<continue>", maxTriggerRounds: 4, messageMode: "last" },
        { source: "CodeReview", target: "Build", trigger: "<continue>", maxTriggerRounds: 4, messageMode: "last" },
        { source: "UnitTest", target: "__end__", trigger: "<complete>", messageMode: "last" },
        { source: "TaskReview", target: "__end__", trigger: "<complete>", messageMode: "last" },
        { source: "CodeReview", target: "__end__", trigger: "<complete>", messageMode: "last" },
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
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

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

  orchestrator.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  stubOpenCodeReloadConfig(orchestrator);
  orchestrator.opencodeRunner.run = async ({ agent, content }) => {
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
    "Build",
    [],
  );
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
      edges: [
        { source: "Build", target: "UnitTest", trigger: "<default>", messageMode: "last" },
        { source: "Build", target: "TaskReview", trigger: "<default>", messageMode: "last" },
        { source: "Build", target: "CodeReview", trigger: "<default>", messageMode: "last" },
        { source: "UnitTest", target: "Build", trigger: "<continue>", maxTriggerRounds: 4, messageMode: "last" },
        { source: "TaskReview", target: "Build", trigger: "<continue>", maxTriggerRounds: 4, messageMode: "last" },
        { source: "CodeReview", target: "Build", trigger: "<continue>", maxTriggerRounds: 4, messageMode: "last" },
        { source: "UnitTest", target: "__end__", trigger: "<complete>", messageMode: "last" },
        { source: "TaskReview", target: "__end__", trigger: "<complete>", messageMode: "last" },
        { source: "CodeReview", target: "__end__", trigger: "<complete>", messageMode: "last" },
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
      && snapshot.agents.some((agent) => agent.id === "UnitTest" && agent.status === "action_required"),
  );
  assert.equal(runningSnapshot.task.status, "running");
  assert.equal(buildRunCount, 1);
  assert.equal(
    runningSnapshot.agents.some((agent) => agent.id === "UnitTest" && agent.status === "action_required"),
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
      && taskDecisionRunCount === 1
      && codeDecisionRunCount === 1,
  );
  assert.equal(settledSnapshot.task.status, "finished");
  assert.equal(buildRunCount, 2);
  assert.equal(unitTestRunCount, 2);
  assert.equal(taskDecisionRunCount, 1);
  assert.equal(codeDecisionRunCount, 1);
  assert.equal(buildPrompts.length, 2);
  assert.match(buildPrompts[1] ?? "", /\[From UnitTest Agent\]/u);
  assert.match(buildPrompts[1] ?? "", /请修复第 1 轮单测问题/u);
});

test("判定类 system prompt 会使用真实来源 Agent 名称", () => {
  const systemPrompt = buildAgentSystemPrompt(["<revise>", "<approved>"]);

  assert.doesNotMatch(systemPrompt, /\[From BA Agent\]/);
  assert.doesNotMatch(systemPrompt, /\[@来源 Agent Message\]/);
});

test("Task 启动后仍允许重新 applyTeamDsl，让 task headless/task ui 的 --file 继续以 .json5 为准", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(orchestrator);

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addCustomAgent(orchestrator, project.cwd, "BA", "你是 BA。", "BA", false);
  await orchestrator.initializeTask({ cwd: project.cwd, title: "demo" });
  const reapplied = await replaceWorkspaceAgents(orchestrator, project.cwd, "BA", [
    { id: "BA", prompt: "你是新的 BA。", isWritable: false },
    { id: "Build", prompt: getTestAgentPrompt("Build"), isWritable: false },
  ]);
  const updatedBaAgent = reapplied.agents.find((agent) => agent.id === "BA");
  if (!updatedBaAgent) {
    assert.fail("缺少更新后的 BA Agent");
  }

  assert.equal(
    updatedBaAgent.prompt,
    "你是新的 BA。",
  );
  assert.equal(reapplied.agents.some((agent) => agent.id === "Build"), true);
});

test("Agent 返回 completed 但正文为空时，任务必须失败而不是写入通过", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new StandaloneRunTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(orchestrator);

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addCustomAgent(orchestrator, project.cwd, "BA", "你是 BA。", "BA", false);
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      nodes: ["BA"],
      edges: [],
    },
  });
  const task = await orchestrator.initializeTask({ cwd: project.cwd, title: "demo" });

  orchestrator.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  stubOpenCodeReloadConfig(orchestrator);
  orchestrator.opencodeRunner.run = async ({ agent }) =>
    buildCompletedExecutionResult({
      agent,
      finalMessage: "",
      messageId: "msg-empty",
      timestamp: "2026-04-25T00:00:00.000Z",
    });

  await orchestrator.runStandaloneAgent({
    cwd: project.cwd,
    task: task.task,
    agentId: "BA",
    prompt: {
      mode: "raw",
      from: "User",
      content: "请输出结果",
    },
  });

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

test("单 Agent 且没有下游时，任务结束后仍保留该 Agent 的最终聊天消息", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator(
    {
      userDataPath,
      enableEventStream: false,
    },
    withTaskPanelsAndSessions((task, agent) => `session:${task.id}:${agent.id}`),
  );
  stubOpenCodeSessions(orchestrator);

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addCustomAgent(orchestrator, project.cwd, "BA", "你是 BA。", "BA", false);
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      nodes: ["BA"],
      edges: [],
    },
  });

  orchestrator.opencodeRunner.run = async () =>
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
  const baFinalMessage = snapshot.messages[baFinalMessageIndex];
  if (!baFinalMessage) {
    assert.fail("缺少 BA 最终消息");
  }
  assert.equal(baFinalMessage.content, "验证成功。");
  assert.equal(baFinalMessageIndex < completionMessageIndex, true);
});

test("判定 Agent 未返回合法标签时必须判为 invalid", () => {
  const parsedDecision = parseDecisionPure(
    "这是普通判定正文，标签写错了。\n\n<chalenge>请继续补充实现依据。</chalenge>",
    true,
  );

  assert.deepEqual(parsedDecision, {
    cleanContent: "这是普通判定正文，标签写错了。\n\n<chalenge>请继续补充实现依据。</chalenge>",
    opinion: "这是普通判定正文，标签写错了。\n\n<chalenge>请继续补充实现依据。</chalenge>",
    kind: "invalid",
    validationError: "当前 Agent 未配置任何可用 trigger",
  });
});

test("自定义 trigger 会按精确标签触发约定下游", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator(
    {
      userDataPath,
      enableEventStream: false,
    },
    withTaskPanelsAndSessions((task, agent) => `session:${task.id}:${agent.id}`),
  );
  stubOpenCodeSessions(orchestrator);

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addCustomAgent(orchestrator, project.cwd, "漏洞论证", "你负责漏洞论证。", "漏洞论证", false);
  project = await addCustomAgent(orchestrator, project.cwd, "漏洞挑战", "你负责漏洞挑战。", "漏洞论证", false);
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["漏洞论证", "漏洞挑战"],
      edges: [
        {
          source: "漏洞论证",
          target: "漏洞挑战",
          trigger: "<abcd>",
          messageMode: "last",
        },
      ],
    },
  });

  orchestrator.opencodeRunner.run = async ({ agent }) => {
    if (agent === "漏洞论证") {
      return buildCompletedExecutionResult({
        agent,
        finalMessage: "当前需要挑战方继续回应。\n\n<abcd>请漏洞挑战继续回应。</abcd>",
        messageId: "message:漏洞论证:1",
        timestamp: "2026-04-27T10:00:00.000Z",
      });
    }
    return buildCompletedExecutionResult({
      agent,
      finalMessage: "我已收到这条自定义触发。",
      messageId: "message:漏洞挑战:1",
      timestamp: "2026-04-27T10:00:01.000Z",
    });
  };

  const submittedTask = await orchestrator.submitTask({
    cwd: project.cwd,
    content: "@漏洞论证 请继续当前争议点的论证。",
    mentionAgentId: "漏洞论证",
  });

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
    submittedTask.task.id,
    (current) =>
      current.messages.some((message) => message.sender === "漏洞挑战" && message.kind === "agent-final"),
    8000,
  );

  assert.equal(snapshot.task.status, "finished");
  assert.equal(
    snapshot.messages.some(
      (message) =>
        message.sender === "漏洞论证"
        && message.kind === "agent-dispatch",
    ),
    true,
  );
  assert.equal(
    snapshot.messages.some(
      (message) =>
        message.sender === "漏洞挑战"
        && message.kind === "agent-final"
        && message.content === "我已收到这条自定义触发。",
    ),
    true,
  );
});

test("custom-only trigger 返回未声明的示例 label 时会直接失败，不会误派发下游", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator(
    {
      userDataPath,
      enableEventStream: false,
    },
    withTaskPanelsAndSessions((task, agent) => `session:${task.id}:${agent.id}`),
  );
  stubOpenCodeSessions(orchestrator);

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addCustomAgent(orchestrator, project.cwd, "漏洞论证", "你负责漏洞论证。", "漏洞论证", false);
  project = await addCustomAgent(orchestrator, project.cwd, "漏洞挑战", "你负责漏洞挑战。", "漏洞论证", false);
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["漏洞论证", "漏洞挑战"],
      edges: [
        {
          source: "漏洞论证",
          target: "漏洞挑战",
          trigger: "<abcd>",
          messageMode: "last",
        },
      ],
    },
  });

  orchestrator.opencodeRunner.run = async ({ agent }) =>
    buildCompletedExecutionResult({
      agent,
      finalMessage: "<continue>请漏洞挑战继续回应。</continue>",
      messageId: `message:${agent}:1`,
      timestamp: "2026-04-27T10:10:00.000Z",
    });

  const submittedTask = await orchestrator.submitTask({
    cwd: project.cwd,
    content: "@漏洞论证 请继续当前争议点的论证。",
    mentionAgentId: "漏洞论证",
  });

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
    submittedTask.task.id,
    (current) => current.task.status === "failed",
    8000,
  );

  const argumentMessage = snapshot.messages.findLast(
    (message) => message.sender === "漏洞论证" && message.kind === "agent-final",
  );
  if (!argumentMessage || argumentMessage.kind !== "agent-final") {
    assert.fail("缺少漏洞论证的最终消息");
  }
  assert.equal(argumentMessage.routingKind, "invalid");
  assert.match(argumentMessage.content, /当前 Agent 必须返回以下 trigger 之一：<abcd>/u);
  assert.equal(snapshot.messages.some((message) => message.sender === "漏洞挑战"), false);

  const failedCompletionMessage = snapshot.messages.findLast(
    (message) =>
      message.sender === "system"
      && message.kind === "task-completed"
      && message.status === "failed",
  );
  if (!failedCompletionMessage) {
    assert.fail("缺少失败结束系统消息");
  }
  assert.equal(failedCompletionMessage.content, "漏洞论证 返回了无效判定结果");
});

test("自定义结束 trigger 可以直接命中 __end__", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator(
    {
      userDataPath,
      enableEventStream: false,
    },
    withTaskPanelsAndSessions((task, agent) => `session:${task.id}:${agent.id}`),
  );
  stubOpenCodeSessions(orchestrator);

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addCustomAgent(orchestrator, project.cwd, "漏洞论证", "你负责漏洞论证。", "漏洞论证", false);
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      nodes: ["漏洞论证"],
      edges: [],
      langgraph: {
        start: {
          id: "__start__",
          targets: ["漏洞论证"],
        },
        end: {
          id: "__end__",
          sources: ["漏洞论证"],
          incoming: [
            {
              source: "漏洞论证",
              trigger: "<done>",
            },
          ],
        },
      },
    },
  });

  orchestrator.opencodeRunner.run = async ({ agent }) =>
    buildCompletedExecutionResult({
      agent,
      finalMessage: "<done>\n当前争议点已经论证完毕。\n</done>",
      messageId: `message:${agent}:done`,
      timestamp: "2026-04-27T10:20:00.000Z",
    });

  const submittedTask = await orchestrator.submitTask({
    cwd: project.cwd,
    content: "@漏洞论证 请完成本轮论证。",
    mentionAgentId: "漏洞论证",
  });

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
    submittedTask.task.id,
    (current) => current.task.status === "finished",
    8000,
  );

  const argumentMessage = snapshot.messages.findLast(
    (message) => message.sender === "漏洞论证" && message.kind === "agent-final",
  );
  if (!argumentMessage || argumentMessage.kind !== "agent-final") {
    assert.fail("缺少漏洞论证的最终消息");
  }
  assert.equal(argumentMessage.trigger, "<done>");
  assert.equal(argumentMessage.content, "当前争议点已经论证完毕。");
});

test("判定 Agent 未返回合法标签时必须直接判 invalid 并终止任务", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator(
    {
      userDataPath,
      enableEventStream: false,
    },
    withTaskPanelsAndSessions((task, agent) => `session:${task.id}:${agent.id}`),
  );
  stubOpenCodeSessions(orchestrator);

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build", "TaskReview"], "Build", []);
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["Build", "TaskReview"],
      edges: [
        { source: "Build", target: "TaskReview", trigger: "<default>", messageMode: "last" },
        { source: "TaskReview", target: "Build", trigger: "<continue>", maxTriggerRounds: 4, messageMode: "last" },
      ],
    },
  });

  orchestrator.opencodeRunner.run = async ({ agent }) => {
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
    (current) => current.task.status === "failed",
    8000,
  );

  const taskDecisionFinal = snapshot.messages.findLast(
    (message) => message.sender === "TaskReview" && message.kind === "agent-final",
  );
  if (!taskDecisionFinal || taskDecisionFinal.kind !== "agent-final") {
    assert.fail("缺少 TaskReview 的最终消息");
  }
  assert.equal(taskDecisionFinal.routingKind, "invalid");
  assert.match(taskDecisionFinal.content, /当前 Agent 必须返回以下 trigger 之一：<continue>/u);
  assert.equal(
    snapshot.messages.some(
      (message) => message.sender === "TaskReview" && message.kind === "action-required-request",
    ),
    false,
  );
  const failedCompletionMessage = snapshot.messages.findLast(
    (message) =>
      message.sender === "system"
      && message.kind === "task-completed"
      && message.status === "failed",
  );
  if (!failedCompletionMessage) {
    assert.fail("缺少失败结束系统消息");
  }
  assert.equal(failedCompletionMessage.content, "TaskReview 返回了无效判定结果");
});

test("判定 Agent 执行中止时不会伪造成整改意见", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new StandaloneRunTestOrchestrator(
    {
      userDataPath,
      enableEventStream: false,
    },
    withTaskPanelsAndSessions(() => "session-code-decision"),
  );
  stubOpenCodeSessions(orchestrator);

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build", "CodeReview"], "Build", []);
  const topology = {
    ...project.topology,
    edges: [
      ...project.topology.edges.filter((edge) => edge.source !== "CodeReview"),
      {
        source: "Build",
        target: "CodeReview",
        trigger: "<default>" as const,
        messageMode: "last" as const,
      },
      {
        source: "CodeReview",
        target: "Build",
        trigger: "<continue>" as const,
        messageMode: "last" as const,
      },
    ],
  };
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology,
  });
  const task = await orchestrator.initializeTask({ cwd: project.cwd, title: "demo" });

  stubOpenCodeReloadConfig(orchestrator);
  orchestrator.opencodeRunner.run = async () =>
    buildErrorExecutionResult({
      agent: "CodeReview",
      finalMessage: "Aborted",
      messageId: "msg-aborted",
      timestamp: "2026-04-15T00:00:00.000Z",
      error: "Aborted",
    });

  await orchestrator.runStandaloneAgent({
    cwd: project.cwd,
    task: task.task,
    agentId: "CodeReview",
    prompt: {
      mode: "structured",
      from: "Build",
      agentMessage: "请判定本轮改动",
    },
  });

  const snapshot = await orchestrator.getTaskSnapshot(task.task.id);
  assert.equal(snapshot.task.status, "failed");
  assert.equal(
    snapshot.messages.some(
      (message) =>
        message.sender === "CodeReview" &&
        message.kind === "action-required-request",
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

  const orchestrator = new StandaloneRunTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(orchestrator);

  orchestrator.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  stubOpenCodeReloadConfig(orchestrator);
  orchestrator.opencodeRunner.run = async ({ agent }) =>
    buildCompletedExecutionResult({
      agent,
      finalMessage: `${agent} 已完成`,
      messageId: `message:${agent}`,
      timestamp: "2026-04-15T00:00:00.000Z",
    });

  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build"], "Build", []);
  project = await addCustomAgent(orchestrator, project.cwd, "QA", "你是 QA。", "Build", false);
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["Build", "QA"],
      edges: [
        {
          source: "Build",
          target: "QA",
          trigger: "<default>",
          messageMode: "last",
        },
      ],
    },
  });
  const task = await orchestrator.initializeTask({ cwd: project.cwd, title: "demo" });

  await orchestrator.runStandaloneAgent({
    cwd: project.cwd,
    task: task.task,
    agentId: "Build",
    prompt: {
      mode: "raw",
      from: "User",
      content: "先执行 Build",
    },
  });

  let snapshot = await orchestrator.getTaskSnapshot(task.task.id);
  assert.equal(snapshot.task.status, "finished");

  await orchestrator.runStandaloneAgent({
    cwd: project.cwd,
    task: task.task,
    agentId: "QA",
    prompt: {
      mode: "raw",
      from: "User",
      content: "再执行 QA",
    },
  });

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

  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(orchestrator);

  const project = await orchestrator.getWorkspaceSnapshot(projectPath);
  await addBuiltinAgents(orchestrator, project.cwd, ["Build", "UnitTest"], "Build", ["Build"]);
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      nodes: ["Build", "UnitTest"],
      edges: [
        { source: "Build", target: "UnitTest", trigger: "<default>", messageMode: "last" },
        { source: "UnitTest", target: "Build", trigger: "<continue>", maxTriggerRounds: 4, messageMode: "last" },
      ],
    },
  });

  const task = await orchestrator.submitTask({
    cwd: project.cwd,
    content: "@Build 请完成需求并通过 UnitTest",
    mentionAgentId: "Build",
  });

  stubOpenCodeReloadConfig(orchestrator);
  orchestrator.opencodeRunner.run = async ({ agent }) => {
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

  if (!failedCompletionMessage) {
    assert.fail("缺少失败结束系统消息");
  }
  assert.equal(failedCompletionMessage.content, "UnitTest -> Build 已连续交流 4 次，任务已结束");
});

test("聊天页面会按每条 action_required 边的单独上限展示失败原因", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();

  let buildRunCount = 0;
  let unitTestRunCount = 0;

  const orchestrator = new TestOrchestrator(
    {
      userDataPath,
      enableEventStream: false,
    },
    withTaskPanelsAndSessions((_task, agent) => `session:${agent.id}`),
  );
  stubOpenCodeSessions(orchestrator);

  const project = await orchestrator.getWorkspaceSnapshot(projectPath);
  await addBuiltinAgents(orchestrator, project.cwd, ["Build", "UnitTest"], "Build", ["Build"]);
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      nodes: ["Build", "UnitTest"],
      edges: [
        { source: "Build", target: "UnitTest", trigger: "<default>", messageMode: "last" },
        { source: "UnitTest", target: "Build", trigger: "<continue>", maxTriggerRounds: 2, messageMode: "last" },
      ],
    },
  });

  const task = await orchestrator.submitTask({
    cwd: project.cwd,
    content: "@Build 请完成需求并通过 UnitTest",
    mentionAgentId: "Build",
  });

  stubOpenCodeReloadConfig(orchestrator);
  orchestrator.opencodeRunner.run = async ({ agent }) => {
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

  if (!failedCompletionMessage) {
    assert.fail("缺少失败结束系统消息");
  }
  assert.equal(failedCompletionMessage.content, "UnitTest -> Build 已连续交流 2 次，任务已结束");
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

  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeAttachBaseUrl(orchestrator);

  orchestrator.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  stubOpenCodeReloadConfig(orchestrator);
  orchestrator.opencodeRunner.run = async ({ agent }) => {
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
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build", "UnitTest", "TaskReview"], "Build", []);
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["Build", "UnitTest", "TaskReview"],
      edges: [
        { source: "Build", target: "UnitTest", trigger: "<default>", messageMode: "last" },
        { source: "Build", target: "TaskReview", trigger: "<default>", messageMode: "last" },
        { source: "UnitTest", target: "Build", trigger: "<continue>", maxTriggerRounds: 4, messageMode: "last" },
        { source: "TaskReview", target: "Build", trigger: "<continue>", maxTriggerRounds: 4, messageMode: "last" },
        { source: "UnitTest", target: "__end__", trigger: "<complete>", messageMode: "last" },
        { source: "TaskReview", target: "__end__", trigger: "<complete>", messageMode: "last" },
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
    (snapshot) => snapshot.task.status === "finished",
  );

  assert.equal(buildRunCount >= 2, true);
  assert.equal(unitTestRunCount >= 1, true);
  assert.equal(taskDecisionRunCount >= 1, true);
  const failedCompletionMessages = finishedSnapshot.messages.filter(
    (message) =>
      message.sender === "system"
      && message.kind === "task-completed"
      && message.status === "failed",
  );
  assert.equal(failedCompletionMessages.length, 0);
});

test("修复批次的 dispatch 窗口里，不会被 getTaskSnapshot 提前补成 finished", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();

  let releaseRedispatchSummary: () => void = () => undefined;
  const redispatchSummaryGate = new Promise<void>((resolve) => {
    releaseRedispatchSummary = resolve;
  });
  let buildRunCount = 0;
  let unitTestRunCount = 0;
  let taskDecisionRunCount = 0;

  const orchestrator = new TestOrchestrator(
    {
      userDataPath,
      enableEventStream: false,
    },
    (defaults) => ({
      ...defaults,
      buildProjectGitDiffSummary: async () => {
        if (buildRunCount >= 2 && unitTestRunCount === 1) {
          await redispatchSummaryGate;
        }
        return "";
      },
    }),
  );
  stubOpenCodeAttachBaseUrl(orchestrator);
  orchestrator.opencodeClient.createSession = async (...args: [string, string]) => `session:${args[1]}`;
  stubOpenCodeReloadConfig(orchestrator);
  orchestrator.opencodeRunner.run = async ({ agent }) => {
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
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build", "UnitTest", "TaskReview"], "Build", []);
  await orchestrator.saveTopology({
    cwd: project.cwd,
    topology: {
      ...project.topology,
      nodes: ["Build", "UnitTest", "TaskReview"],
      edges: [
        { source: "Build", target: "UnitTest", trigger: "<default>", messageMode: "last" },
        { source: "Build", target: "TaskReview", trigger: "<default>", messageMode: "last" },
        { source: "UnitTest", target: "Build", trigger: "<continue>", maxTriggerRounds: 4, messageMode: "last" },
        { source: "TaskReview", target: "__end__", trigger: "<complete>", messageMode: "last" },
        { source: "UnitTest", target: "__end__", trigger: "<complete>", messageMode: "last" },
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
          && getMessageTargetAgentIds(message).includes("UnitTest")
          && message.content.includes("Build 已根据 UnitTest 意见修复完成。"),
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
      && unitTestRunCount === 2
      && taskDecisionRunCount === 1,
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
  const orchestrator = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(orchestrator);
  let project = await orchestrator.getWorkspaceSnapshot(projectPath);
  project = await addBuiltinAgents(orchestrator, project.cwd, ["Build"], "Build", []);
  const task = await orchestrator.initializeTask({ cwd: project.cwd, title: "demo" });

  const reloaded = new TestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });
  stubOpenCodeSessions(reloaded);
  const snapshot = await reloaded.getWorkspaceSnapshot(project.cwd);

  assert.equal(snapshot.tasks.some((item) => item.task.id === task.task.id), false);
});
