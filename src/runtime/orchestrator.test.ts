import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildTopologyNodeRecords,
  createTopologyFlowRecord,
  getMessageTargetAgentIds,
  isUserMessageRecord,
  type MessageRecord,
  type TopologyNodeRecord,
  type TaskAgentRecord,
  type TopologyRecord,
  type WorkspaceSnapshot,
  toUtcIsoTimestamp,
} from "@shared/types";
import { OpenCodeClient, type OpenCodeExecutionResult } from "./opencode-client";
import { Orchestrator, isTerminalTaskStatus } from "./orchestrator";
import { compileBuiltinTopology } from "../../test-support/runtime/builtin-topology-test-helpers";
import { parseDecision } from "./decision-parser";
import { type GraphDispatchBatch, type GraphAgentResult } from "./gating-router";
import { createEmptyGraphTaskState, type GraphTaskState } from "./gating-state";
import { compileTeamDsl, type TeamDslDefinition } from "./team-dsl";
import { isOpenCodeServeCommand } from "../../test-support/runtime/opencode-process-cleanup";
import { buildInjectedConfigFromAgents } from "./project-agent-source";
import { mergeTaskChatMessages } from "../lib/chat-messages";
import { buildTaskLogFilePath, initAppFileLogger } from "./app-log";

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

function withAgentNodeRecords(
  topology: Omit<TopologyRecord, "nodeRecords" | "flow"> & Partial<Pick<TopologyRecord, "flow">>,
): TopologyRecord {
  const flowInput = topology.flow
    ? {
        startTargets: topology.flow.start.targets,
        endSources: topology.flow.end.sources,
        endIncoming: topology.flow.end.incoming,
      }
    : {};
  const flow = createTopologyFlowRecord({
    nodes: topology.nodes,
    edges: topology.edges,
    ...flowInput,
  });
  return {
    ...topology,
    flow,
    nodeRecords: buildTopologyNodeRecords({
      nodes: topology.nodes,
      groupNodeIds: new Set(),
      templateNameByNodeId: new Map(),
      initialMessageRoutingByNodeId: new Map(),
      groupRuleIdByNodeId: new Map(),
      promptByNodeId: new Map(),
      writableNodeIds: new Set(),
    }),
  };
}

function agentNodeRecord(input: { id: string; templateName: string; prompt: string; writable: boolean }): TopologyNodeRecord {
  return {
    id: input.id,
    kind: "agent",
    templateName: input.templateName,
    initialMessageRouting: { mode: "inherit" },
    prompt: input.prompt,
    writable: input.writable,
  };
}

function groupNodeRecord(input: { id: string; templateName: string; groupRuleId: string }): TopologyNodeRecord {
  return {
    id: input.id,
    kind: "group",
    templateName: input.templateName,
    groupRuleId: input.groupRuleId,
    initialMessageRouting: { mode: "inherit" },
  };
}

const activeOrchestrators = new Set<Orchestrator>();

type TestBatchRunner = {
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
      omitSourceAgentSectionLabel: boolean;
    };

type TestOrchestratorDependencies = {
  createRuntimeBatchRunners: (
    state: GraphTaskState,
    batch: GraphDispatchBatch,
  ) => Promise<TestBatchRunner[]>;
  trackBackgroundTask: (
    promise: Promise<void>,
    context: { agentId: string },
  ) => void;
  ensureAgentSession: (agent: TaskAgentRecord) => Promise<string>;
  ensureTaskPanels: () => Promise<void>;
};

type ConfigureTestOrchestratorDependencies = (
  defaults: TestOrchestratorDependencies,
) => TestOrchestratorDependencies;

type BaseOrchestratorOptions = ConstructorParameters<typeof Orchestrator>[0];
type TestOrchestratorOptions = {
  cwd: string;
  userDataPath: string;
};

function requireSingleMessage<T extends MessageRecord>(
  messages: T[],
  description: string,
): T {
  assert.equal(messages.length, 1, description);
  const message = messages[0];
  assert.ok(message);
  return message;
}

function requireSingleTriggeredAgentFinalMessage(
  messages: MessageRecord[],
  description: string,
) {
  return requireSingleMessage(
    messages.filter(
      (message): message is Extract<MessageRecord, { kind: "agent-final"; routingKind: "triggered" }> =>
        message.kind === "agent-final" && message.routingKind === "triggered",
    ),
    description,
  );
}

function createTestOpenCodeClient(): OpenCodeClient {
  const client = new OpenCodeClient({
    server: {
      commandName: "opencode",
      process: {
        pid: 0,
        killed: true,
        kill() {
          return true;
        },
        on() {
          return this;
        },
        off() {
          return this;
        },
        stderr: {
          on() {
            return this;
          },
        },
        stdout: {
          on() {
            return this;
          },
        },
      } as never,
      port: 43127,
    },
  });
  client.submitMessage = async () => buildCompletedExecutionResult({
      agent: "Build",
      finalMessage: "",
      messageId: "msg-test",
      timestamp: new Date().toISOString(),
    });
  return client;
}

class TestOrchestrator extends Orchestrator {
  private readonly dependencies: TestOrchestratorDependencies;

  constructor(
    options: TestOrchestratorOptions,
    configureDependencies: ConfigureTestOrchestratorDependencies = (defaults) => defaults,
  ) {
    super({
      ...options,
      commandName: "opencode",
      opencodeClient: createTestOpenCodeClient(),
      terminalLauncher: async () => {},
    });
    const defaults: TestOrchestratorDependencies = {
      trackBackgroundTask: (promise, context) => super.trackBackgroundTask(promise, context),
      createRuntimeBatchRunners: (state, batch) =>
        super.createRuntimeBatchRunners(state, batch),
      ensureAgentSession: (agent) => super.ensureAgentSession(agent),
      ensureTaskPanels: () => super.ensureTaskPanels(),
    };
    this.dependencies = configureDependencies(defaults);
    activeOrchestrators.add(this);
  }

  protected override trackBackgroundTask(
    promise: Promise<void>,
    context: { agentId: string },
  ) {
    this.dependencies.trackBackgroundTask(promise, context);
  }

  protected override async createRuntimeBatchRunners(
    state: GraphTaskState,
    batch: GraphDispatchBatch,
  ) {
    return this.dependencies.createRuntimeBatchRunners(state, batch);
  }

  protected override async ensureAgentSession(agent: TaskAgentRecord) {
    return this.dependencies.ensureAgentSession(agent);
  }

  protected override async ensureTaskPanels() {
    return this.dependencies.ensureTaskPanels();
  }

  public initializeTestOpenCodeRuntime() {
    this.opencodeClient.submitMessage = async () => buildCompletedExecutionResult({
        agent: "Build",
        finalMessage: "",
        messageId: "msg-test",
        timestamp: new Date().toISOString(),
      });
  }
}

type StandaloneAgentRunInput = {
  agentId: string;
  prompt: TestRunAgentPrompt;
};

class StandaloneRunTestOrchestrator extends TestOrchestrator {
  public runStandaloneAgent(input: StandaloneAgentRunInput) {
    return this.runAgent(input.agentId, input.prompt, {
      followTopology: false,
    });
  }
}

class BatchRunnerTestOrchestrator extends StandaloneRunTestOrchestrator {
  public runBatchRunners(
    state: GraphTaskState,
    batch: GraphDispatchBatch,
  ) {
    return this.createRuntimeBatchRunners(state, batch);
  }
}

function stubOpenCodeSessions(orchestrator: TestOrchestrator) {
  orchestrator.initializeTestOpenCodeRuntime();
  orchestrator.opencodeClient.createSession = async (title: string) => `session:${title}`;
  orchestrator.opencodeClient.getAttachBaseUrl = async () => "http://127.0.0.1:43127";
}

function stubOpenCodeAttachBaseUrl(orchestrator: TestOrchestrator) {
  orchestrator.initializeTestOpenCodeRuntime();
  orchestrator.opencodeClient.getAttachBaseUrl = async () => "http://127.0.0.1:43127";
}

function buildCompletedExecutionResult(input: {
  agent: string;
  finalMessage: string;
  messageId: string;
  timestamp: string;
}): OpenCodeExecutionResult {
  return {
    finalMessage: input.finalMessage,
    messageId: input.messageId,
    timestamp: toUtcIsoTimestamp(input.timestamp),
    rawMessage: {
      id: input.messageId,
      content: input.finalMessage,
      sender: input.agent,
      timestamp: toUtcIsoTimestamp(input.timestamp),
      error: "",
      raw: {},
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
    cwd: workspacePath,
    userDataPath,
  });

  await orchestrator.getWorkspaceSnapshot();

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
  const nodeRecordsById = new Map(
    input.workspace.topology.nodeRecords.map((node) => [node.id, node]),
  );
  const resolveInitialMessage = (agentId: string) => {
    const nodeRecord = nodeRecordsById.get(agentId);
    if (!nodeRecord) {
      return {};
    }
    const routing = nodeRecord.initialMessageRouting;
    if (routing.mode === "inherit") {
      return {};
    }
    if (routing.mode === "none") {
      return { initialMessage: [] };
    }
    return {
      initialMessage: [...routing.agentIds],
    };
  };
  return {
    entry: input.entryAgentId,
    nodes: [...new Set([...input.workspace.topology.nodes, ...input.nextAgents.map((agent) => agent.id)])].map((name) => {
      const nextAgent = input.nextAgents.find((agent) => agent.id === name);
      if (nextAgent) {
        return {
          type: "agent" as const,
          id: name,
          system_prompt: nextAgent.prompt,
          writable: nextAgent.isWritable,
          ...resolveInitialMessage(name),
        };
      }

      const existingAgent = workspaceAgents.get(name);
      if (!existingAgent) {
        assert.fail(`工作区 Agent 缺失：${name}`);
      }
        return {
          type: "agent" as const,
          id: name,
          system_prompt: existingAgent.prompt,
          writable: existingAgent.isWritable === true,
          ...resolveInitialMessage(name),
        };
      }),
    links: input.workspace.topology.edges.map((edge) => ({
      from: edge.source,
      to: edge.target,
      trigger: edge.trigger,
      message_type: edge.messageMode,
      maxTriggerRounds: edge.maxTriggerRounds,
    })),
  };
}

async function replaceWorkspaceAgents(
  orchestrator: Orchestrator,
  entryAgentId: string,
  nextAgents: TestWorkspaceAgentInput[],
) {
  const current = await orchestrator.getWorkspaceSnapshot();
  const compiled = compileTeamDsl(buildTeamDslFromWorkspaceSnapshot({
    workspace: current,
    entryAgentId,
    nextAgents,
  }));
  return orchestrator.applyTeamDsl({ compiled });
}

async function addBuiltinAgents(
  orchestrator: Orchestrator,
  agentIds: string[],
  entryAgentId: string,
  writableAgentIds: string[],
) {
  let latestWorkspace = await orchestrator.getWorkspaceSnapshot();
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
    latestWorkspace = await replaceWorkspaceAgents(orchestrator, entryAgentId, nextAgents);
  }
  return latestWorkspace;
}

async function addCustomAgent(
  orchestrator: Orchestrator,
  agentId: string,
  prompt: string,
  entryAgentId: string,
  isWritable: boolean,
) {
  const current = await orchestrator.getWorkspaceSnapshot();
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
  return replaceWorkspaceAgents(orchestrator, entryAgentId, nextAgents);
}

async function waitForTaskSnapshot(
  orchestrator: Orchestrator,
  predicate: (snapshot: Awaited<ReturnType<Orchestrator["getTaskSnapshot"]>>) => boolean,
  timeoutMs = 5000,
): Promise<Awaited<ReturnType<Orchestrator["getTaskSnapshot"]>>> {
  const startedAt = Date.now();
  let latestSnapshot = await orchestrator.getTaskSnapshot();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate(latestSnapshot)) {
      return latestSnapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    latestSnapshot = await orchestrator.getTaskSnapshot();
  }

  throw new Error(
    `Task did not reach the expected state in ${timeoutMs}ms. `
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
  const originalStartServer = OpenCodeClient.startServer;
  let startServerCount = 0;
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeSessions(orchestrator);
  OpenCodeClient.startServer = async (...args) => {
    startServerCount += 1;
    return originalStartServer(...args);
  };

  try {
    let project = await orchestrator.getWorkspaceSnapshot();
    project = await addBuiltinAgents(orchestrator, ["Build"], "Build", ["Build"]);
    const task = await orchestrator.initializeTask();

    assert.equal(task.task.cwd, project.cwd);
    assert.equal(task.messages.some((message) => /session/i.test(message.content)), false);
    assert.equal(task.agents.some((agent) => agent.id === "Build"), true);
    assert.equal(task.task.cwd, projectPath);
    assert.equal(startServerCount, 0);
  } finally {
    OpenCodeClient.startServer = originalStartServer;
  }
});

test("漏洞团队任务初始化时不会为仅作为 group 模板存在的静态 agent 预建 session", async () => {
  const userDataPath = createTempDir();
  initAppFileLogger(userDataPath);
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeSessions(orchestrator);

  const compiled = compileBuiltinTopology("vulnerability.yaml");
  await orchestrator.applyTeamDsl({
    compiled,
  });

  const task = await orchestrator.initializeTask();
  const agentByName = new Map(task.agents.map((agent) => [agent.id, agent]));
  const clueFinder = agentByName.get("线索发现");
  const vulnerabilityArguer = agentByName.get("漏洞论证");
  const vulnerabilityChallenger = agentByName.get("误报论证");
  const summaryAgent = agentByName.get("讨论总结");
  if (!clueFinder || !vulnerabilityArguer || !vulnerabilityChallenger || !summaryAgent) {
    assert.fail("漏洞团队初始化后缺少预期 Agent");
  }

  assert.equal(clueFinder.opencodeSessionId, "session:线索发现");
  assert.equal(vulnerabilityArguer.opencodeSessionId, "");
  assert.equal(vulnerabilityChallenger.opencodeSessionId, "");
  assert.equal(summaryAgent.opencodeSessionId, "");

  await orchestrator.openAgentTerminal("线索发现");

  const taskLogPath = buildTaskLogFilePath(userDataPath, task.task.id);
  assert.equal(fs.existsSync(taskLogPath), false);
});

test("单节点任务进入 finished 时不会因为缺少 workspace cwd 而在后台崩溃", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  let backgroundRun: Promise<void> = Promise.resolve();
  let backgroundRunTracked = false;
  const orchestrator = new TestOrchestrator(
    {
      cwd: projectPath,
      userDataPath,
    },
    (defaults) => ({
      ...defaults,
      trackBackgroundTask: (promise) => {
        backgroundRunTracked = true;
        backgroundRun = promise.then(() => undefined);
      },
      createRuntimeBatchRunners: async () => [],
    }),
  );
  stubOpenCodeAttachBaseUrl(orchestrator);
  orchestrator.opencodeClient.createSession = async (_title: string) => `session:`;
  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent }) =>
    buildCompletedExecutionResult({
      agent,
      finalMessage: `${agent} 已完成本轮处理。`,
      messageId: `message:${agent}:finished`,
      timestamp: toUtcIsoTimestamp("2026-04-22T00:00:00.000Z"),
    });

  await orchestrator.getWorkspaceSnapshot();
  await addCustomAgent(orchestrator, "BA", "你是 BA。", "BA", false);
  await orchestrator.saveTopology(withAgentNodeRecords({
      nodes: ["BA"],
      edges: [],
    }),
  );

  await orchestrator.submitTask({ content: "@BA 请分析当前问题" });

  assert.equal(backgroundRunTracked, true);
  await assert.doesNotReject(async () => {
    await backgroundRun;
  });

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
    (current) => current.task.status === "finished",
    3000,
  );
  assert.equal(snapshot.task.status, "finished");
});

test("任务本轮 finished 后再次 @Agent 时会回到 running 并在同一 Task 内完成下一轮", async () => {
  const userDataPath = createTempDir();
  initAppFileLogger(userDataPath);
  const projectPath = createTempDir();
  const backgroundRuns: Promise<void>[] = [];
  const orchestrator = new TestOrchestrator(
    {
      cwd: projectPath,
      userDataPath,
    },
    (defaults) => ({
      ...defaults,
      trackBackgroundTask: (promise, context) => {
        backgroundRuns.push(promise.then(() => undefined));
        defaults.trackBackgroundTask(promise, context);
      },
    }),
  );
  stubOpenCodeAttachBaseUrl(orchestrator);

  let baRunCount = 0;
  let releaseSecondRound: () => void = () => undefined;
  const secondRoundGate = new Promise<void>((resolve) => {
    releaseSecondRound = resolve;
  });
  let resolveSecondRoundStarted: () => void = () => undefined;
  const secondRoundStarted = new Promise<void>((resolve) => {
    resolveSecondRoundStarted = resolve;
  });

  orchestrator.opencodeClient.createSession = async (_title: string) => `session:`;
  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent }) => {
    baRunCount += 1;
    if (baRunCount === 2) {
      resolveSecondRoundStarted();
      await secondRoundGate;
    }
    return buildCompletedExecutionResult({
      agent,
      finalMessage: `${agent} 第 ${baRunCount} 轮已完成。`,
      messageId: `message:${agent}:${baRunCount}`,
      timestamp: toUtcIsoTimestamp(`2026-04-22T00:00:0${baRunCount}.000Z`),
    });
  };

  await orchestrator.getWorkspaceSnapshot();
  await addCustomAgent(orchestrator, "BA", "你是 BA。", "BA", false);
  await orchestrator.saveTopology(withAgentNodeRecords({
      nodes: ["BA"],
      edges: [],
    }),
  );

  await orchestrator.submitTask({ content: "@BA 请先完成第一轮" });

  assert.equal(backgroundRuns.length, 1);
  await assert.doesNotReject(async () => {
    await backgroundRuns[0];
  });
  const firstFinished = await orchestrator.getTaskSnapshot();
  assert.notEqual(firstFinished.task.completedAt, "");
  assert.equal(Number.isFinite(Date.parse(firstFinished.task.completedAt)), true);
  assert.equal(firstFinished.task.status, "finished");
  assert.equal(
    firstFinished.messages.filter((message) => message.kind === "task-round-finished").length,
    1,
  );

  const reopened = await orchestrator.submitTask({ content: "@BA 请继续第二轮" });
  assert.equal(reopened.task.status, "running");
  assert.equal(reopened.task.completedAt, "");

  assert.equal(backgroundRuns.length, 2);
  await assert.doesNotReject(async () => {
    await secondRoundStarted;
  });
  const runningSnapshot = await orchestrator.getTaskSnapshot();
  assert.equal(runningSnapshot.task.status, "running");
  assert.equal(runningSnapshot.task.completedAt, "");
  assert.equal(
    runningSnapshot.agents.find((agent) => agent.id === "BA")?.runCount,
    2,
  );

  releaseSecondRound();

  await assert.doesNotReject(async () => {
    await backgroundRuns[1];
  });
  const secondFinished = await orchestrator.getTaskSnapshot();
  assert.notEqual(secondFinished.task.completedAt, "");
  assert.equal(Number.isFinite(Date.parse(secondFinished.task.completedAt)), true);
  assert.equal(secondFinished.task.status, "finished");
  assert.equal(
    secondFinished.messages.filter((message) => message.kind === "task-round-finished").length,
    2,
  );
  const roundFinishedLogs = fs.readFileSync(
    buildTaskLogFilePath(userDataPath, secondFinished.task.id),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((record) => record.event === "task.round_finished");
  assert.equal(roundFinishedLogs.length, 2);
  assert.deepEqual(
    roundFinishedLogs.map((record) => record.content),
    [
      "本轮已完成，可继续 @Agent 发起下一轮。",
      "本轮已完成，可继续 @Agent 发起下一轮。",
    ],
  );
});

test("漏洞团队里误报论证先返回触发回流的 label、漏洞论证回应后才会继续派发到讨论总结", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeAttachBaseUrl(orchestrator);

  const runCountByAgent = new Map<string, number>();
  const nextCount = (agent: string) => {
    const next = (runCountByAgent.get(agent) ?? 0) + 1;
    runCountByAgent.set(agent, next);
    return next;
  };

  orchestrator.opencodeClient.createSession = async (_title: string) => `session:`;
  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent }) => {
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
          timestamp: toUtcIsoTimestamp("2026-04-22T00:00:00.000Z"),
        }),
        rawMessage: {
          id: "message:线索发现:1",
          content: "线索发现第 1 轮已产出 finding",
          sender: agent,
          timestamp: toUtcIsoTimestamp("2026-04-22T00:00:00.000Z"),
          error: "",
          raw: {},
        },
      };
    }

    if (agent === "线索发现") {
      return buildCompletedExecutionResult({
        agent,
        finalMessage: "<complete>当前项目里没有新的可疑点，结束本轮流程。</complete>",
        messageId: `message:${agent}:${count}`,
        timestamp: toUtcIsoTimestamp("2026-04-22T00:00:03.000Z"),
      });
    }

    if (agent === "误报论证") {
      return {
        ...buildCompletedExecutionResult({
          agent,
          finalMessage: "当前还缺少对关键调用链的逐条论证，请继续补证。\n\n<continue>请漏洞论证先回应本轮质疑。</continue>",
          messageId: `message:误报论证:${count}`,
          timestamp: toUtcIsoTimestamp("2026-04-22T00:00:01.000Z"),
        }),
        rawMessage: {
          id: `message:误报论证:${count}`,
          content: "误报论证要求漏洞论证先回应本轮质疑",
          sender: agent,
          timestamp: toUtcIsoTimestamp("2026-04-22T00:00:01.000Z"),
          error: "",
          raw: {},
        },
      };
    }

    if (agent === "漏洞论证") {
      return {
        ...buildCompletedExecutionResult({
          agent,
          finalMessage: "我已补齐入口到落盘点的关键证据，当前可以进入裁决。\n\n<agree>当前已经完成对上一轮质疑的回应。</agree>",
          messageId: `message:漏洞论证:${count}`,
          timestamp: toUtcIsoTimestamp("2026-04-22T00:00:01.500Z"),
        }),
        rawMessage: {
          id: `message:漏洞论证:${count}`,
          content: "漏洞论证完成了对误报论证上一轮质疑的回应",
          sender: agent,
          timestamp: toUtcIsoTimestamp("2026-04-22T00:00:01.500Z"),
          error: "",
          raw: {},
        },
      };
    }

    if (agent === "讨论总结") {
      return {
        ...buildCompletedExecutionResult({
          agent,
          finalMessage: "判断：该点更像真实漏洞，输出正式漏洞报告。",
          messageId: `message:讨论总结:${count}`,
          timestamp: toUtcIsoTimestamp("2026-04-22T00:00:02.000Z"),
        }),
        rawMessage: {
          id: `message:讨论总结:${count}`,
          content: "讨论总结已输出报告",
          sender: agent,
          timestamp: toUtcIsoTimestamp("2026-04-22T00:00:02.000Z"),
          error: "",
          raw: {},
        },
      };
    }

    if (agent === "线索完备性评估") {
      return buildCompletedExecutionResult({
        agent,
        finalMessage: "<complete>当前项目里没有新的遗漏线索，可以结束本轮。</complete>",
        messageId: `message:${agent}:${count}`,
        timestamp: toUtcIsoTimestamp("2026-04-22T00:00:02.500Z"),
      });
    }

    return buildCompletedExecutionResult({
      agent,
      finalMessage: `${agent} 已处理完成。`,
      messageId: `message:${agent}:${count}`,
      timestamp: toUtcIsoTimestamp("2026-04-22T00:00:03.000Z"),
    });
  };

  const compiled = compileBuiltinTopology("vulnerability.yaml");
  await orchestrator.applyTeamDsl({
    compiled,
  });

  await orchestrator.submitTask({ content: "@线索发现 请分析这个漏洞线索" });

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
    (current) =>
      current.messages.some((message) =>
        message.kind === "agent-final" && message.sender.startsWith("讨论总结-"))
      && current.messages.some((message) =>
        message.kind === "task-round-finished" && /本轮已完成/u.test(message.content)),
    3000,
  );

  assert.equal(
    snapshot.messages.some((message) => message.sender.startsWith("讨论总结-")),
    true,
  );
  const argumentFinalIndex = snapshot.messages.findIndex(
    (message) =>
      message.kind === "agent-final"
      && message.sender.startsWith("漏洞论证-"),
  );
  const summaryFinalIndex = snapshot.messages.findIndex(
    (message) =>
      message.kind === "agent-final"
      && message.sender.startsWith("讨论总结-"),
  );
  assert.notEqual(argumentFinalIndex, -1);
  assert.notEqual(summaryFinalIndex, -1);
  assert.equal(argumentFinalIndex < summaryFinalIndex, true);
  const prematureSummaryIndex = snapshot.messages.findIndex(
    (message, index) =>
      index < argumentFinalIndex
      && message.kind === "agent-final"
      && message.sender.startsWith("讨论总结-"),
  );
  assert.equal(prematureSummaryIndex, -1);
});

test("漏洞团队里讨论总结以 transfer + none 回到线索发现时，会下发对应的继续查找请求", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeAttachBaseUrl(orchestrator);

  const promptByAgent = new Map<string, string[]>();
  const recordPrompt = (agent: string, content: string) => {
    const current = promptByAgent.get(agent) ?? [];
    current.push(content);
    promptByAgent.set(agent, current);
    return current.length;
  };

  orchestrator.opencodeClient.createSession = async (_title: string) => `session:`;
  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent, content }) => {
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
        timestamp: toUtcIsoTimestamp(`2026-04-24T00:00:0${count}.000Z`),
      });
    }

    if (agent === "误报论证") {
      return buildCompletedExecutionResult({
        agent,
        finalMessage: "<continue>当前还缺少关键代码证据，请漏洞论证先回应。</continue>",
        messageId: `message:${agent}:${count}`,
        timestamp: toUtcIsoTimestamp("2026-04-24T00:00:10.000Z"),
      });
    }

    if (agent === "漏洞论证") {
      return buildCompletedExecutionResult({
        agent,
        finalMessage: "<agree>我已回应误报论证的关键质疑，当前可以进入讨论总结。</agree>",
        messageId: `message:${agent}:${count}`,
        timestamp: toUtcIsoTimestamp("2026-04-24T00:00:15.000Z"),
      });
    }

    if (agent === "讨论总结") {
      return buildCompletedExecutionResult({
        agent,
        finalMessage: "结论：当前这条更像误报，已形成稳定判断。",
        messageId: `message:${agent}:${count}`,
        timestamp: toUtcIsoTimestamp("2026-04-24T00:00:20.000Z"),
      });
    }

    return buildCompletedExecutionResult({
      agent,
      finalMessage: `${agent} 已处理完成。`,
      messageId: `message:${agent}:${count}`,
      timestamp: toUtcIsoTimestamp("2026-04-24T00:00:30.000Z"),
    });
  };

  const compiled = compileBuiltinTopology("vulnerability.yaml");
  await orchestrator.applyTeamDsl({
    compiled,
  });

  await orchestrator.submitTask({ content: "@线索发现 请持续挖掘当前代码中的可疑漏洞点。" });

  await waitForTaskSnapshot(
    orchestrator,
    () => (promptByAgent.get("线索发现")?.length ?? 0) >= 2,
    3000,
  );

  const clueFinderPrompts = promptByAgent.get("线索发现");
  if (clueFinderPrompts === undefined) {
    assert.fail("缺少线索发现转发记录");
  }
  const secondPrompt = clueFinderPrompts[1] ?? "";
  assert.equal(secondPrompt, "continue");
  assert.doesNotMatch(secondPrompt, /更像误报|稳定判断/u);
});

test("漏洞团队第二轮 finding 已经派发到 误报论证-2 时，UI 仍能看到线索发现的第二轮消息", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeAttachBaseUrl(orchestrator);

  const runCountByAgent = new Map<string, number>();
  const nextCount = (agent: string) => {
    const next = (runCountByAgent.get(agent) ?? 0) + 1;
    runCountByAgent.set(agent, next);
    return next;
  };

  orchestrator.opencodeClient.createSession = async (_title: string) => `session:`;
  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent }) => {
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
          timestamp: toUtcIsoTimestamp("2026-04-24T00:00:01.000Z"),
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
          timestamp: toUtcIsoTimestamp("2026-04-24T00:00:04.000Z"),
        });
      }

      return buildCompletedExecutionResult({
        agent,
        finalMessage: "<complete>当前项目里没有新的可疑点，结束本轮流程。</complete>",
        messageId: `message:线索发现:${count}`,
        timestamp: toUtcIsoTimestamp(`2026-04-24T00:00:0${count + 3}.000Z`),
      });
    }

    if (agent === "误报论证") {
      return buildCompletedExecutionResult({
        agent,
        finalMessage: "<continue>当前还缺少关键代码证据，请漏洞论证先回应。</continue>",
        messageId: `message:误报论证:${count}`,
        timestamp: toUtcIsoTimestamp(`2026-04-24T00:00:0${count + 1}.000Z`),
      });
    }

    if (agent === "漏洞论证") {
      return buildCompletedExecutionResult({
        agent,
        finalMessage: "<agree>我已回应误报论证的关键质疑，当前可以进入讨论总结。</agree>",
        messageId: `message:漏洞论证:${count}`,
        timestamp: toUtcIsoTimestamp(`2026-04-24T00:00:0${count + 1}.500Z`),
      });
    }

    if (agent === "讨论总结") {
      return buildCompletedExecutionResult({
        agent,
        finalMessage: count === 1 ? "结论：当前这条更像真实漏洞。" : "结论：当前这条更像误报。",
        messageId: `message:讨论总结:${count}`,
        timestamp: toUtcIsoTimestamp(`2026-04-24T00:00:0${count + 2}.000Z`),
      });
    }

    return buildCompletedExecutionResult({
      agent,
      finalMessage: `${agent} 已处理完成。`,
      messageId: `message:${agent}:${count}`,
      timestamp: toUtcIsoTimestamp("2026-04-24T00:00:09.000Z"),
    });
  };

  const compiled = compileBuiltinTopology("vulnerability.yaml");
  await orchestrator.applyTeamDsl({
    compiled,
  });

  await orchestrator.submitTask({ content: "@线索发现 请持续挖掘当前代码中的可疑漏洞点，直到没有新 finding 为止。" });

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
    (current) => current.messages.some((message) => message.sender === "误报论证-2"),
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

test("漏洞团队里误报论证直接返回 <agree> 时会立即派发到讨论总结", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeAttachBaseUrl(orchestrator);

  const runCountByAgent = new Map<string, number>();
  const nextCount = (agent: string) => {
    const next = (runCountByAgent.get(agent) ?? 0) + 1;
    runCountByAgent.set(agent, next);
    return next;
  };

  orchestrator.opencodeClient.createSession = async (_title: string) => `session:`;
  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent }) => {
    const count = nextCount(agent);

    if (agent === "线索发现") {
      return buildCompletedExecutionResult({
        agent,
        finalMessage: count === 1
          ? [
            "内部调试接口似乎缺少鉴权",
            "",
            "<continue>发现新的可疑点，继续后续流程。</continue>",
          ].join("\n")
          : "<complete>当前项目里没有新的可疑点，结束本轮流程。</complete>",
        messageId: `message:${agent}:${count}`,
        timestamp: toUtcIsoTimestamp(`2026-04-24T00:00:0${count}.000Z`),
      });
    }

    if (agent === "误报论证") {
      return buildCompletedExecutionResult({
        agent,
        finalMessage: "<agree>当前材料已经足够进入讨论总结。</agree>",
        messageId: `message:${agent}:${count}`,
        timestamp: toUtcIsoTimestamp("2026-04-24T00:00:02.000Z"),
      });
    }

    if (agent === "讨论总结") {
      return buildCompletedExecutionResult({
        agent,
        finalMessage: "结论：当前这条更像误报。",
        messageId: `message:${agent}:${count}`,
        timestamp: toUtcIsoTimestamp("2026-04-24T00:00:03.000Z"),
      });
    }

    if (agent === "线索完备性评估") {
      return buildCompletedExecutionResult({
        agent,
        finalMessage: "<complete>当前项目里没有新的遗漏线索，可以结束本轮。</complete>",
        messageId: `message:${agent}:${count}`,
        timestamp: toUtcIsoTimestamp("2026-04-24T00:00:04.000Z"),
      });
    }

    return buildCompletedExecutionResult({
      agent,
      finalMessage: `${agent} 已处理完成。`,
      messageId: `message:${agent}:${count}`,
      timestamp: toUtcIsoTimestamp("2026-04-24T00:00:04.000Z"),
    });
  };

  const compiled = compileBuiltinTopology("vulnerability.yaml");
  await orchestrator.applyTeamDsl({
    compiled,
  });

  await orchestrator.submitTask({ content: "@线索发现 请分析这个漏洞线索" });

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
    (current) => current.messages.some((message) => message.sender.startsWith("讨论总结-")),
    3000,
  );

  assert.equal(
    snapshot.messages.some((message) => message.sender.startsWith("讨论总结-")),
    true,
  );
  assert.equal(
    snapshot.messages.some((message) =>
      message.kind === "agent-final" && message.sender.startsWith("讨论总结-")),
    true,
  );
  assert.equal(
    snapshot.messages.some((message) =>
      message.kind === "task-round-finished" && /本轮已完成/u.test(message.content)),
    true,
  );
});

test("漏洞团队 group runtime agent 尚未落库时，getTaskSnapshot 不会把任务提前判 finished", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  let createBatchRunnerCallCount = 0;
  let releaseCreateBatchRunners: () => void = () => undefined;
  const createBatchRunnersGate = new Promise<void>((resolve) => {
    releaseCreateBatchRunners = resolve;
  });

  const orchestrator = new TestOrchestrator(
    {
      cwd: projectPath,
      userDataPath,
    },
    (defaults) => ({
      ...defaults,
      createRuntimeBatchRunners: async (state, batch) => {
        createBatchRunnerCallCount += 1;
        if (createBatchRunnerCallCount >= 2) {
          await createBatchRunnersGate;
        }
        return defaults.createRuntimeBatchRunners(state, batch);
      },
    }),
  );
  stubOpenCodeSessions(orchestrator);
  orchestrator.opencodeClient.createSession = async (_title: string) => `session:`;
  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent }) => {
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
          timestamp: toUtcIsoTimestamp("2026-04-22T00:00:00.000Z"),
        }),
        rawMessage: {
          id: "message:线索发现:1",
          content: "线索发现第 1 轮已产出 finding",
          sender: agent,
          timestamp: toUtcIsoTimestamp("2026-04-22T00:00:00.000Z"),
          error: "",
          raw: {},
        },
      };
    }

    throw new Error("测试在验证 dispatch 窗口后主动终止后续执行。");
  };

  const compiled = compileBuiltinTopology("vulnerability.yaml");
  await orchestrator.applyTeamDsl({
    compiled,
  });

  await orchestrator.submitTask({ content: "@线索发现 请分析这个漏洞线索" });

  await waitForValue(
    async () => createBatchRunnerCallCount,
    (value) => value >= 2,
    3000,
  );

  const taskAgentIdsDuringDispatchWindow = orchestrator.store
    .listTaskAgents()
    .map((agent) => agent.id);

  const snapshotDuringDispatchWindow = await orchestrator.getTaskSnapshot();

  assert.notEqual(snapshotDuringDispatchWindow.task.status, "finished");
  assert.equal(
    snapshotDuringDispatchWindow.messages.some(
      (message) => message.kind === "task-round-finished",
    ),
    false,
  );
  assert.equal(snapshotDuringDispatchWindow.task.status, "running");

  releaseCreateBatchRunners();
  const settledSnapshot = await waitForTaskSnapshot(
    orchestrator,
    (current) => current.task.status === "failed",
    3000,
  );
  const continueRequestMessage = settledSnapshot.messages.findLast(
    (message) => message.kind === "agent-dispatch" && message.sender === "线索发现",
  );
  if (!continueRequestMessage) {
    assert.fail("缺少线索发现的 trigger 派发消息");
  }
  const [runtimeAgentIdFromContinue] = getMessageTargetAgentIds(continueRequestMessage);
  if (typeof runtimeAgentIdFromContinue !== "string") {
    assert.fail("缺少 runtime 误报论证 Agent id");
  }
  assert.equal(runtimeAgentIdFromContinue.startsWith("误报论证-"), true);
  assert.equal(taskAgentIdsDuringDispatchWindow.includes(runtimeAgentIdFromContinue), false);
  assert.equal(settledSnapshot.task.status, "failed");
});

test("getTaskSnapshot 在新的 Orchestrator 进程里不会恢复跨进程任务", async () => {
  const userDataPath = createTempDir();
  const workspacePath = createTempDir();

  const writer = new TestOrchestrator({
    cwd: workspacePath,
    userDataPath,
  });
  stubOpenCodeSessions(writer);

  await replaceWorkspaceAgents(writer, "Build", [
    { id: "Build", prompt: getTestAgentPrompt("Build"), isWritable: true },
    { id: "BA", prompt: getTestAgentPrompt("BA"), isWritable: false },
  ]);

  await writer.initializeTask();

  await writer.dispose();
  activeOrchestrators.delete(writer);

  const reader = new TestOrchestrator({
    cwd: workspacePath,
    userDataPath,
  });
  stubOpenCodeSessions(reader);

  await assert.rejects(
    () => reader.getTaskSnapshot(),
    /当前没有 Task/,
  );
});

test("task init 不会追加额外系统提醒", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeSessions(orchestrator);

  await orchestrator.getWorkspaceSnapshot();
  await addBuiltinAgents(orchestrator, ["Build"], "Build", []);
  const task = await orchestrator.initializeTask();

  assert.equal(task.messages.some((message) => message.kind === undefined), false);
});

test("dispose 在 CLI 快速退出模式下不会等待悬挂的后台 task promise", async () => {
  const userDataPath = createTempDir();
  const cwd = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd,
    userDataPath,
  });
  orchestrator.initializeTestOpenCodeRuntime();

  let shutdownCalled = false;
  orchestrator.opencodeClient.shutdown = async () => {
    shutdownCalled = true;
    return [43127];
  };
  orchestrator.pendingTaskRuns.add(new Promise<void>(() => {}));

  const disposePromise = orchestrator.dispose(false);
  const completed = await Promise.race([
    disposePromise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
  ]);

  assert.equal(completed, true);
  assert.equal(shutdownCalled, true);
});

test("dispose 会把 OpenCode 清理报告向上返回", async () => {
  const userDataPath = createTempDir();
  const cwd = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd,
    userDataPath,
  });
  orchestrator.initializeTestOpenCodeRuntime();

  orchestrator.opencodeClient.shutdown = async () => {
    return [43127];
  };

  const report = await orchestrator.dispose();

  assert.deepEqual(report, [43127]);
});

test("未应用团队 DSL 时，Project 不再暴露可手工编辑的 agents 配置", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });

  const project = await orchestrator.getWorkspaceSnapshot();

  assert.deepEqual(project.agents, []);
});

test("Build 只有在团队 DSL 中声明后才会出现在 agents", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });

  const project = await orchestrator.getWorkspaceSnapshot();
  assert.equal(project.agents.some((agent) => agent.id === "Build"), false);

  const withBuild = await addBuiltinAgents(orchestrator, ["Build"], "Build", ["Build"]);
  const buildAgent = withBuild.agents.find((agent) => agent.id === "Build");
  if (!buildAgent) {
    assert.fail("缺少 Build Agent");
  }
  assert.equal(withBuild.agents.some((agent) => agent.id === "Build"), true);
  assert.equal(buildAgent.isWritable, true);
  assert.deepEqual(buildInjectedConfigFromAgents(withBuild.agents), {});
});

test("applyTeamDsl 会一次性写入当前 Project 的 agents 与 topology", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });

  const compiled = compileTeamDsl({
    entry: "BA",
    nodes: [
      {
        type: "agent",
        id: "Build",
        system_prompt: "",
        writable: true,
      },
      {
        type: "agent",
        id: "BA",
        system_prompt: getTestAgentPrompt("BA"),
        writable: false,
      },
      {
        type: "agent",
        id: "SecurityResearcher",
        system_prompt: "你负责漏洞挖掘。必须输出 <continue>。",
        writable: false,
      },
    ],
    links: [
      { from: "BA", to: "Build", trigger: "<default>", message_type: "last" , maxTriggerRounds: 4 },
      { from: "Build", to: "SecurityResearcher", trigger: "<default>", message_type: "last" , maxTriggerRounds: 4 },
      { from: "SecurityResearcher", to: "Build", trigger: "<continue>", message_type: "last" , maxTriggerRounds: 4 },
    ],
  });

  const updated = await orchestrator.applyTeamDsl({
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
    { source: "BA", target: "Build", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
    { source: "Build", target: "SecurityResearcher", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
    {
      source: "SecurityResearcher",
      target: "Build",
      trigger: "<continue>",
      messageMode: "last", maxTriggerRounds: 4,
    },
  ]);
});

test("applyTeamDsl 写入后会保留 agent 的 initialMessageAgentIds", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });

  const compiled = compileTeamDsl({
    entry: "线索发现",
    nodes: [
      {
        type: "agent",
        id: "线索发现",
        system_prompt: "你是线索发现。请在完成时返回 <complete>。",
        writable: false,
      },
      {
        type: "agent",
        id: "漏洞讨论",
        system_prompt: "你是漏洞讨论。请在完成时返回 <complete>。",
        writable: false,
      },
      {
        type: "agent",
        id: "线索完备性评估",
        system_prompt: "你是线索完备性评估。",
        writable: false,
        initialMessage: ["线索发现", "漏洞讨论"],
      },
    ],
    links: [
      {
        from: "线索发现",
        to: "漏洞讨论",
        trigger: "<complete>",
        message_type: "last",
        maxTriggerRounds: 4,
      },
      {
        from: "漏洞讨论",
        to: "线索完备性评估",
        trigger: "<complete>",
        message_type: "last",
        maxTriggerRounds: 4,
      },
    ],
  });

  const updated = await orchestrator.applyTeamDsl({
    compiled,
  });

  assert.deepEqual(updated.topology.edges, [
    {
      source: "线索发现",
      target: "漏洞讨论",
      trigger: "<complete>",
      messageMode: "last", maxTriggerRounds: 4,
    },
    {
      source: "漏洞讨论",
      target: "线索完备性评估",
      trigger: "<complete>",
      messageMode: "last", maxTriggerRounds: 4,
    },
  ]);
  assert.deepEqual(
    updated.topology.nodeRecords.find((node) => node.id === "线索完备性评估"),
    {
      id: "线索完备性评估",
      kind: "agent",
      templateName: "线索完备性评估",
      prompt: "你是线索完备性评估。",
      writable: false,
      initialMessageRouting: {
        mode: "list",
        agentIds: ["线索发现", "漏洞讨论"],
      },
    },
  );
});

test("applyTeamDsl 会直接以 DSL system_prompt 为唯一真源", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });

  const compiled = compileTeamDsl({
    entry: "BA",
    nodes: [
      {
        type: "agent",
        id: "BA",
        system_prompt: "DSL BA prompt",
        writable: false,
      },
      {
        type: "agent",
        id: "Build",
        system_prompt: "",
        writable: true,
      },
    ],
    links: [
      { from: "BA", to: "Build", trigger: "<default>", message_type: "last" , maxTriggerRounds: 4 },
    ],
  });

  const updated = await orchestrator.applyTeamDsl({
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
    cwd: projectPath,
    userDataPath,
  });

  let project = await orchestrator.getWorkspaceSnapshot();
  project = await addBuiltinAgents(orchestrator, ["Build"], "Build", ["Build"]);
  project = await addCustomAgent(orchestrator, "BA", "你是 BA。", "Build", false);

  await orchestrator.saveTopology({
      ...project.topology,
      nodes: ["BA", "Build"],
      edges: [{ source: "BA", target: "Build", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 }],
    },
  );

  assert.equal(fs.existsSync(path.join(projectPath, ".agent-team", LEGACY_WORKSPACE_STATE_BASENAME)), false);
});

test("保存拓扑时不会再把 flow.end.sources 隐式恢复成无 trigger 结束边", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });

  await orchestrator.getWorkspaceSnapshot();
  await addCustomAgent(orchestrator, "漏洞论证", "你负责漏洞论证。", "漏洞论证", false);

  const saved = await orchestrator.saveTopology(withAgentNodeRecords({
      nodes: ["漏洞论证"],
      edges: [],
      flow: {
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
    }),
  );

  assert.deepEqual(saved.topology.flow.end, {
    id: "__end__",
    sources: [],
    incoming: [],
  });
});

test("保存拓扑时会把 target=__end__ 的 trigger 边提升到 flow.end.incoming", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });

  await orchestrator.getWorkspaceSnapshot();
  await addCustomAgent(orchestrator, "漏洞论证", "你负责漏洞论证。", "漏洞论证", false);

  const saved = await orchestrator.saveTopology(withAgentNodeRecords({
      nodes: ["漏洞论证"],
      edges: [
        {
          source: "漏洞论证",
          target: "__end__",
          trigger: "<done>",
          messageMode: "last", maxTriggerRounds: 4,
        },
      ],
    }),
  );

  assert.deepEqual(saved.topology.edges, []);
  assert.deepEqual(saved.topology.flow.end, {
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

test("openAgentTerminal 使用配置的自定义命令名", async () => {
  class AttachCommandTestOrchestrator extends Orchestrator {
    constructor(options: TestOrchestratorOptions, terminalLauncher: BaseOrchestratorOptions["terminalLauncher"]) {
      super({
        ...options,
        commandName: "nga",
        opencodeClient: createTestOpenCodeClient(),
        terminalLauncher,
      });
      activeOrchestrators.add(this);
    }
  }

  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  let launchedCommand = "";
  const orchestrator = new AttachCommandTestOrchestrator(
    {
      cwd: projectPath,
      userDataPath,
    },
    async (command) => {
      launchedCommand = command;
    },
  );
  orchestrator.opencodeClient.createSession = async (title: string) => `session:${title}`;
  orchestrator.opencodeClient.getAttachBaseUrl = async () => "http://127.0.0.1:43127";

  const compiled = compileBuiltinTopology("vulnerability.yaml");
  await orchestrator.applyTeamDsl({
    compiled,
  });
  await orchestrator.initializeTask();
  await orchestrator.openAgentTerminal("线索发现");

  assert.equal(
    launchedCommand,
    "nga attach 'http://127.0.0.1:43127' --session 'session:线索发现'",
  );
});

test("保存拓扑后会把动态 group 团队配置保留在当前运行时快照里", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });

  let project = await orchestrator.getWorkspaceSnapshot();
  project = await addBuiltinAgents(orchestrator, ["Build"], "Build", []);
  project = await addCustomAgent(orchestrator, "线索发现", "你负责线索发现。", "Build", false);
  project = await addCustomAgent(orchestrator, "漏洞论证模板", "你负责漏洞论证。", "Build", false);
  project = await addCustomAgent(orchestrator, "误报论证模板", "你负责误报论证。", "Build", false);
  project = await addCustomAgent(orchestrator, "Summary模板", "你是总结。", "Build", false);

  const saved = await orchestrator.saveTopology({
      ...project.topology,
      nodes: ["Build", "线索发现", "漏洞论证模板", "误报论证模板", "Summary模板"],
      edges: [{ source: "Build", target: "线索发现", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 }],
      nodeRecords: [
        agentNodeRecord({ id: "Build", templateName: "Build", prompt: "", writable: false }),
        agentNodeRecord({ id: "线索发现", templateName: "线索发现", prompt: "", writable: false }),
        agentNodeRecord({ id: "漏洞论证模板", templateName: "漏洞论证模板", prompt: "", writable: false }),
        agentNodeRecord({ id: "误报论证模板", templateName: "误报论证模板", prompt: "", writable: false }),
        agentNodeRecord({ id: "Summary模板", templateName: "Summary模板", prompt: "", writable: false }),
        groupNodeRecord({ id: "疑点辩论工厂", templateName: "漏洞论证模板", groupRuleId: "finding-debate" }),
      ],
      groupRules: [
        {
          id: "finding-debate",
          groupNodeName: "疑点辩论工厂",
          sourceTemplateName: "线索发现",
          entryRole: "pro",
          members: [
            { role: "pro", templateName: "漏洞论证模板" },
            { role: "con", templateName: "误报论证模板" },
            { role: "summary", templateName: "Summary模板" },
          ],
          edges: [
            { sourceRole: "pro", targetRole: "con", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
            { sourceRole: "con", targetRole: "pro", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
            { sourceRole: "pro", targetRole: "summary", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
            { sourceRole: "con", targetRole: "summary", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
          ],
          report: {
            sourceRole: "summary",
            templateName: "线索发现",
            trigger: "<default>",
            messageMode: "last",
            maxTriggerRounds: -1,
          },
        },
      ],
    },
  );

  assert.equal(saved.topology.groupRules?.length, 1);
  assert.equal(saved.topology.nodeRecords.some((node) => node.kind === "group"), true);
  const reloaded = await orchestrator.getWorkspaceSnapshot();
  assert.equal(reloaded.topology.groupRules?.[0]?.id, "finding-debate");
  assert.equal(
    reloaded.topology.nodeRecords.some((node) => node.id === "疑点辩论工厂" && node.kind === "group"),
    true,
  );
  assert.equal(fs.existsSync(path.join(projectPath, ".agent-team", LEGACY_WORKSPACE_STATE_BASENAME)), false);
});

test("保存拓扑时会拒绝缺少 reportToTrigger 的 group report 配置", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });

  let project = await orchestrator.getWorkspaceSnapshot();
  project = await addCustomAgent(orchestrator, "线索发现", "你负责线索发现。", "线索发现", false);
  project = await addCustomAgent(orchestrator, "漏洞论证模板", "你负责漏洞论证。", "线索发现", false);

  await assert.rejects(
    () => {
      const legacyTopologyInput = {
        ...project.topology,
        nodes: ["线索发现", "漏洞论证模板"],
        edges: [],
        nodeRecords: [
          agentNodeRecord({ id: "线索发现", templateName: "线索发现", prompt: "", writable: false }),
          agentNodeRecord({ id: "漏洞论证模板", templateName: "漏洞论证模板", prompt: "", writable: false }),
          groupNodeRecord({ id: "疑点辩论工厂", templateName: "漏洞论证模板", groupRuleId: "finding-debate" }),
        ] satisfies TopologyNodeRecord[],
        groupRules: [
          {
            id: "finding-debate",
            groupNodeName: "疑点辩论工厂",
            sourceTemplateName: "线索发现",
            entryRole: "pro",
            members: [
              { role: "pro", templateName: "漏洞论证模板" },
            ],
            edges: [],
            reportToTemplateName: "线索发现",
            reportToMessageMode: "last" as const,
            reportToMaxTriggerRounds: -1,
          },
        ],
      };
      return orchestrator.saveTopology(legacyTopologyInput,
      );
    },
    /必须显式声明 reportToTrigger/u,
  );
});

test("保存拓扑后会保留 group 节点类型，避免 GUI 点击后回读丢失", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });

  let project = await orchestrator.getWorkspaceSnapshot();
  project = await addBuiltinAgents(orchestrator, ["Build"], "Build", []);
  project = await addCustomAgent(orchestrator, "UnitTest", "你是 UnitTest。", "Build", false);
  project = await addCustomAgent(orchestrator, "BA", "你是 BA。", "Build", false);

  const saved = await orchestrator.saveTopology({
      ...project.topology,
      nodes: ["Build", "UnitTest", "BA"],
      edges: [{ source: "Build", target: "UnitTest", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 }],
      nodeRecords: [
        agentNodeRecord({ id: "Build", templateName: "Build", prompt: "", writable: false }),
        groupNodeRecord({ id: "UnitTest", templateName: "UnitTest", groupRuleId: "group-rule:UnitTest" }),
        agentNodeRecord({ id: "BA", templateName: "BA", prompt: "", writable: false }),
      ],
      groupRules: [
        {
          id: "UnitTest",
          sourceTemplateName: "Build",
          entryRole: "entry",
          members: [
            { role: "entry", templateName: "UnitTest" },
          ],
          edges: [],
          report: {
            sourceRole: "summary",
            templateName: "UnitTest",
            trigger: "<default>",
            messageMode: "last",
            maxTriggerRounds: -1,
          },
        },
      ],
    },
  );

  assert.equal(
    saved.topology.nodeRecords.some((node) => node.id === "UnitTest" && node.kind === "group"),
    true,
  );

  const rehydrated = await orchestrator.getWorkspaceSnapshot();
  assert.equal(
    rehydrated.topology.nodeRecords.some((node) => node.id === "UnitTest" && node.kind === "group"),
    true,
  );
});

test("第二个不同 cwd 的 Project 会在入口直接失败", async () => {
  const userDataPath = createTempDir();
  const projectAPath = createTempDir();
  const projectBPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectAPath,
    userDataPath,
  });

  await orchestrator.getWorkspaceSnapshot();
  await addCustomAgent(orchestrator, "BA", "你是 BA。\n只做需求分析。", "BA", false);
  await assert.rejects(
    async () => {
      const another = new TestOrchestrator({
        cwd: projectBPath,
        userDataPath,
      });
      try {
        await another.getWorkspaceSnapshot();
      } finally {
        activeOrchestrators.delete(another);
        await another.dispose();
      }
    },
    /当前进程只允许一个 cwd/,
  );
});

test("同一 cwd 下 task 初始化只会读取一次 OpenCode attach 地址", async () => {
  const userDataPath = createTempDir();
  const cwd = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd,
    userDataPath,
  });

  let attachBaseUrlReadCount = 0;
  orchestrator.opencodeClient.createSession = async (title: string) => `session:${title}`;
  orchestrator.opencodeClient.getAttachBaseUrl = async () => {
    attachBaseUrlReadCount += 1;
    return "http://127.0.0.1:43127";
  };

  await orchestrator.getWorkspaceSnapshot();
  await addBuiltinAgents(orchestrator, ["Build"], "Build", []);

  await orchestrator.initializeTask();
  await assert.rejects(
    () => orchestrator.initializeTask(),
    /当前进程只允许一个 Task/,
  );

  assert.equal(attachBaseUrlReadCount, 1);
});

test("新的 Orchestrator 进程里不会再从旧工作区快照恢复 task attach session", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const writer = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeSessions(writer);

  await writer.getWorkspaceSnapshot();
  await addBuiltinAgents(writer, ["Build"], "Build", []);
  const created = await writer.initializeTask();
  const buildTaskAgent = created.agents[0];
  if (!buildTaskAgent) {
    assert.fail("缺少 Build 运行态 Agent");
  }

  assert.equal(buildTaskAgent.opencodeSessionId, "session:Build");

  const reloaded = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });
  await assert.rejects(
    () => reloaded.getTaskSnapshot(),
    /当前没有 Task/,
  );
});

test("未写入 Build 时当前 Project 可以没有可写 Agent", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });

  await orchestrator.getWorkspaceSnapshot();
  await addCustomAgent(orchestrator, "BA", "你是 BA。", "BA", false);

  const injected = buildInjectedConfigFromAgents((await orchestrator.getWorkspaceSnapshot()).agents);
  assert.deepEqual(injected["BA"], {
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
    cwd: projectPath,
    userDataPath,
  });

  let project = await orchestrator.getWorkspaceSnapshot();
  project = await addBuiltinAgents(orchestrator, ["Build"], "Build", ["Build"]);
  project = await addCustomAgent(orchestrator, "BA", "你是 BA。", "Build", true);

  assert.deepEqual(
    project.agents.map((agent) => [agent.id, agent.isWritable === true]),
    [
      ["Build", true],
      ["BA", true],
    ],
  );

  const injected = buildInjectedConfigFromAgents(project.agents);
  assert.deepEqual(
    injected,
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
    cwd: projectPath,
    userDataPath,
  });

  let project: WorkspaceSnapshot;
  await addCustomAgent(orchestrator, "BA", "你是 BA。", "BA", true);
  project = await addCustomAgent(orchestrator, "QA", "你是 QA。", "BA", true);

  assert.deepEqual(
    project.agents.map((agent) => [agent.id, agent.isWritable]),
    [
      ["BA", true],
      ["QA", true],
    ],
  );
});

test("saveTopology 会保留同一 source target 下不同 trigger 的多条边", async () => {
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath: createTempDir(),
  });

  let project: WorkspaceSnapshot;
  await addCustomAgent(orchestrator, "漏洞论证", "你负责漏洞论证。", "漏洞论证", false);
  project = await addCustomAgent(orchestrator, "误报论证", "你负责误报论证。", "漏洞论证", false);

  await orchestrator.saveTopology({
      ...project.topology,
      nodes: ["漏洞论证", "误报论证"],
      edges: [
        {
          source: "漏洞论证",
          target: "误报论证",
          trigger: "<first>",
          messageMode: "last",
          maxTriggerRounds: 2,
        },
        {
          source: "漏洞论证",
          target: "误报论证",
          trigger: "<second>",
          messageMode: "last",
          maxTriggerRounds: 5,
        },
      ],
    },
  );

  const snapshot = await orchestrator.getWorkspaceSnapshot();
  assert.deepEqual(snapshot.topology.edges, [
    {
      source: "漏洞论证",
      target: "误报论证",
      trigger: "<first>",
      messageMode: "last",
      maxTriggerRounds: 2,
    },
    {
      source: "漏洞论证",
      target: "误报论证",
      trigger: "<second>",
      messageMode: "last",
      maxTriggerRounds: 5,
    },
  ]);
});

test("saveTopology 允许同一 source 把同一个自定义 trigger 路由到多个下游", async () => {
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath: createTempDir(),
  });

  let project: WorkspaceSnapshot;
  await addCustomAgent(orchestrator, "漏洞论证", "你负责漏洞论证。", "漏洞论证", false);
  await addCustomAgent(orchestrator, "误报论证", "你负责误报论证。", "漏洞论证", false);
  project = await addCustomAgent(orchestrator, "讨论总结", "你负责讨论总结。", "漏洞论证", false);

  await orchestrator.saveTopology({
      ...project.topology,
      nodes: ["漏洞论证", "误报论证", "讨论总结"],
      edges: [
        {
          source: "漏洞论证",
          target: "误报论证",
          trigger: "<dup>",
          messageMode: "last", maxTriggerRounds: 4,
        },
        {
          source: "漏洞论证",
          target: "讨论总结",
          trigger: "<dup>",
          messageMode: "last", maxTriggerRounds: 4,
        },
      ],
    },
  );

  const snapshot = await orchestrator.getWorkspaceSnapshot();
  assert.deepEqual(snapshot.topology.edges, [
    {
      source: "漏洞论证",
      target: "误报论证",
      trigger: "<dup>",
      messageMode: "last", maxTriggerRounds: 4,
    },
    {
      source: "漏洞论证",
      target: "讨论总结",
      trigger: "<dup>",
      messageMode: "last", maxTriggerRounds: 4,
    },
  ]);
});

test("saveTopology 会拒绝非尖括号 trigger", async () => {
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath: createTempDir(),
  });

  let project = await orchestrator.getWorkspaceSnapshot();
  project = await addCustomAgent(orchestrator, "线索发现", "你负责线索发现。", "线索发现", false);
  project = await addCustomAgent(orchestrator, "误报论证", "你负责误报论证。", "线索发现", false);

  await assert.rejects(
    () =>
      orchestrator.saveTopology({
          ...project.topology,
          nodes: ["线索发现", "误报论证"],
          edges: [
            {
              source: "线索发现",
              target: "误报论证",
              trigger: "bad",
              messageMode: "last", maxTriggerRounds: 4,
            },
          ],
        },
      ),
    /非法拓扑 trigger/u,
  );
});

test("Agent 间传递不再携带 [Initial Task]，只保留来源 Agent 段落", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
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
      timestamp: toUtcIsoTimestamp("2026-04-15T00:00:00.000Z"),
    });

  orchestrator.opencodeClient.createSession = async (_title: string) => `session:`;
  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent, content }) => {
    recordPrompt(agent, content);
    if (agent === "BA") {
      return completedResponse(agent, "需求已澄清，交给 Build 继续实现。");
    }
    if (agent === "Build") {
      return completedResponse(agent, "构建已完成，交给 QA 继续验证。");
    }
    return completedResponse(agent, "验证已完成。");
  };

  let project: WorkspaceSnapshot;
  await addBuiltinAgents(orchestrator, ["BA", "Build"], "BA", []);
  project = await addCustomAgent(orchestrator, "QA", "你是 QA。", "BA", false);
  await orchestrator.saveTopology({
      ...project.topology,
      nodes: ["BA", "Build", "QA"],
      edges: [
        {
          source: "BA",
          target: "Build",
          trigger: "<default>",
          messageMode: "last", maxTriggerRounds: 4,
        },
        {
          source: "Build",
          target: "QA",
          trigger: "<default>",
          messageMode: "last", maxTriggerRounds: 4,
        },
      ],
    },
  );

  await orchestrator.submitTask({ content: "@BA 请实现 add 方法，并补充验证说明。" });

  await waitForTaskSnapshot(
    orchestrator,
    (current) =>
      current.task.status === "finished"
      && current.agents.every((agent) => agent.runCount === 1),
  );

  const buildPrompts = promptByAgent.get("Build");
  const qaPrompts = promptByAgent.get("QA");
  if (buildPrompts === undefined || qaPrompts === undefined) {
    assert.fail("缺少 Build 或 QA 的转发记录");
  }
  assert.match(buildPrompts[0] ?? "", /\[From BA Agent\]/u);
  assert.doesNotMatch(buildPrompts[0] ?? "", /\[Project Git Diff Summary\]/u);
  assert.match(qaPrompts[0] ?? "", /\[From Build Agent\]/u);
  assert.doesNotMatch(buildPrompts[0] ?? "", /\[Initial Task\]/u);
  assert.doesNotMatch(qaPrompts[0] ?? "", /\[Initial Task\]/u);
  assert.doesNotMatch(qaPrompts[0] ?? "", /\[Project Git Diff Summary\]/u);
});

test("agent 声明 initialMessage 后，下游实际 prompt 会保留默认转发并额外注入来源段落", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
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
      timestamp: toUtcIsoTimestamp("2026-04-15T00:00:00.000Z"),
    });

  orchestrator.opencodeClient.createSession = async (_title: string) => `session:`;
  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent, content }) => {
    recordPrompt(agent, content);
    if (agent === "线索发现") {
      return completedResponse(agent, "<complete>\n线索发现确认了入口参数可控。");
    }
    if (agent === "漏洞讨论") {
      return completedResponse(agent, "<complete>\n漏洞讨论确认了利用链能够闭环。");
    }
    return completedResponse(agent, "线索完备性评估完成。");
  };

  await orchestrator.applyTeamDsl({ compiled: compileTeamDsl({
      entry: "线索发现",
      nodes: [
        {
          type: "agent",
          id: "线索发现",
          system_prompt: "你是线索发现。请在完成时返回 <complete>。",
          writable: false,
        },
        {
          type: "agent",
          id: "漏洞讨论",
          system_prompt: "你是漏洞讨论。请在完成时返回 <complete>。",
          writable: false,
        },
        {
          type: "agent",
          id: "线索完备性评估",
          system_prompt: "你是线索完备性评估。",
          writable: false,
          initialMessage: ["线索发现", "漏洞讨论"],
        },
      ],
      links: [
        {
          from: "线索发现",
          to: "漏洞讨论",
          trigger: "<complete>",
          message_type: "last",
          maxTriggerRounds: 4,
        },
        {
          from: "漏洞讨论",
          to: "线索完备性评估",
          trigger: "<complete>",
          message_type: "last",
          maxTriggerRounds: 4,
        },
      ],
    }),
  });

  await orchestrator.submitTask({ content: "@线索发现 请继续分析这个漏洞线索。" });

  await waitForTaskSnapshot(
    orchestrator,
    (current) =>
      current.task.status === "finished"
      && current.agents.every((agent) => agent.runCount === 1),
  );

  const prompts = promptByAgent.get("线索完备性评估");
  if (prompts === undefined) {
    assert.fail("缺少线索完备性评估的转发记录");
  }
  assert.match(prompts[0] ?? "", /\[From 漏洞讨论 Agent\]\n漏洞讨论确认了利用链能够闭环。/u);
  assert.match(prompts[0] ?? "", /\[From 线索发现 Agent\]\n线索发现确认了入口参数可控。/u);
  assert.equal(
    (prompts[0] ?? "").match(/\[From 漏洞讨论 Agent\]/gu)?.length ?? 0,
    1,
  );
});

test("initialMessage 已包含当前触发 agent 时，最终 prompt 不会重复注入同一个来源段落", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
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
      timestamp: toUtcIsoTimestamp("2026-04-15T00:00:00.000Z"),
    });

  orchestrator.opencodeClient.createSession = async (_title: string) => `session:`;
  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent, content }) => {
    recordPrompt(agent, content);
    if (agent === "A") {
      return completedResponse(agent, "<complete>\nA 的初始证据。");
    }
    if (agent === "B") {
      return completedResponse(agent, "<complete>\nB 的补充证据。");
    }
    return completedResponse(agent, "C 完成。");
  };

  await orchestrator.applyTeamDsl({ compiled: compileTeamDsl({
      entry: "A",
      nodes: [
        {
          type: "agent",
          id: "A",
          system_prompt: "你是 A。请在完成时返回 <complete>。",
          writable: false,
        },
        {
          type: "agent",
          id: "B",
          system_prompt: "你是 B。请在完成时返回 <complete>。",
          writable: false,
        },
        {
          type: "agent",
          id: "C",
          system_prompt: "你是 C。",
          writable: false,
          initialMessage: ["A", "B"],
        },
      ],
      links: [
        {
          from: "A",
          to: "B",
          trigger: "<complete>",
          message_type: "last",
          maxTriggerRounds: 4,
        },
        {
          from: "B",
          to: "C",
          trigger: "<complete>",
          message_type: "last",
          maxTriggerRounds: 4,
        },
      ],
    }),
  });

  await orchestrator.submitTask({ content: "@A 请继续推进。" });

  await waitForTaskSnapshot(
    orchestrator,
    (current) =>
      current.task.status === "finished"
      && current.agents.every((agent) => agent.runCount === 1),
  );

  const prompts = promptByAgent.get("C");
  if (prompts === undefined) {
    assert.fail("缺少 C 的转发记录");
  }
  const cPrompt = prompts[0] ?? "";
  assert.equal((cPrompt.match(/\[From A Agent\]/gu) ?? []).length, 1);
  assert.equal((cPrompt.match(/\[From B Agent\]/gu) ?? []).length, 1);
  assert.doesNotMatch(cPrompt, /\[From B Agent\][\s\S]*\[From B Agent\]/u);
});

test("同一个目标 Agent 只会在首次启动时注入 initialMessage，后续自动派发不应重复注入", async () => {
  const projectPath = createTempDir();
  const orchestrator = new BatchRunnerTestOrchestrator({
    cwd: projectPath,
    userDataPath: createTempDir(),
  });
  await orchestrator.applyTeamDsl({ compiled: compileTeamDsl({
      entry: "A",
      nodes: [
        {
          type: "agent",
          id: "A",
          system_prompt: "你是 A。",
          writable: false,
        },
        {
          type: "agent",
          id: "B",
          system_prompt: "你是 B。完成时返回 <complete>。",
          writable: false,
        },
        {
          type: "agent",
          id: "C",
          system_prompt: "你是 C。",
          writable: false,
          initialMessage: ["A"],
        },
      ],
      links: [
        {
          from: "B",
          to: "C",
          trigger: "<complete>",
          message_type: "last",
          maxTriggerRounds: 4,
        },
      ],
    }),
  });

  stubOpenCodeAttachBaseUrl(orchestrator);
  orchestrator.opencodeClient.createSession = async (_title: string) => `session:`;

  const promptByAgent = new Map<string, string[]>();
  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent, content }) => {
    const current = promptByAgent.get(agent) ?? [];
    current.push(content);
    promptByAgent.set(agent, current);
    return buildCompletedExecutionResult({
      agent,
      finalMessage: `${agent} 已收到上下文。`,
      messageId: `message:${agent}:${current.length}`,
      timestamp: toUtcIsoTimestamp("2026-05-08T00:00:00.000Z"),
    });
  };

  await orchestrator.initializeTask();

  await orchestrator.runStandaloneAgent({
    agentId: "A",
    prompt: {
      mode: "raw",
      from: "User",
      content: "请先给出首条背景事实。",
    },
  });

  await orchestrator.runStandaloneAgent({
    agentId: "C",
    prompt: {
      mode: "raw",
      from: "User",
      content: "这是手动执行，后续自动派发不应再注入 initialMessage。",
    },
  });

  const topology = orchestrator.store.getTopology();
  const state = createEmptyGraphTaskState({
    topology,
  });

  const firstBMessage: MessageRecord = {
    id: "message:B:1",
    sender: "B",
    senderDisplayName: "B",
    timestamp: toUtcIsoTimestamp("2026-05-08T00:00:01.000Z"),
    content: "B 的第 1 条结论。",
    kind: "agent-final",
    runCount: 1,
    status: "completed",
    routingKind: "triggered",
    trigger: "<complete>",
    rawResponse: "<complete>\nB 的第 1 条结论。",
  };
  orchestrator.store.insertMessage(firstBMessage);

  const firstRunners = await orchestrator.runBatchRunners(
    state,
    {
      routingKind: "triggered",
      trigger: "<complete>",
      source: { kind: "agent", agentId: "B" },
      sourceContent: firstBMessage.content,
      displayContent: firstBMessage.content,
      triggerTargets: ["C"],
      jobs: [
        {
          kind: "dispatch",
          agentId: "C",
          sourceAgentId: "B",
          sourceMessageId: firstBMessage.id,
          sourceContent: firstBMessage.content,
          displayContent: firstBMessage.content,
        },
      ],
    },
  );
  await Promise.all(firstRunners.map((runner) => runner.promise));

  const secondBMessage: MessageRecord = {
    id: "message:B:2",
    sender: "B",
    senderDisplayName: "B",
    timestamp: toUtcIsoTimestamp("2026-05-08T00:00:02.000Z"),
    content: "B 的第 2 条结论。",
    kind: "agent-final",
    runCount: 2,
    status: "completed",
    routingKind: "triggered",
    trigger: "<complete>",
    rawResponse: "<complete>\nB 的第 2 条结论。",
  };
  orchestrator.store.insertMessage(secondBMessage);

  const secondRunners = await orchestrator.runBatchRunners(
    state,
    {
      routingKind: "triggered",
      trigger: "<complete>",
      source: { kind: "agent", agentId: "B" },
      sourceContent: secondBMessage.content,
      displayContent: secondBMessage.content,
      triggerTargets: ["C"],
      jobs: [
        {
          kind: "dispatch",
          agentId: "C",
          sourceAgentId: "B",
          sourceMessageId: secondBMessage.id,
          sourceContent: secondBMessage.content,
          displayContent: secondBMessage.content,
        },
      ],
    },
  );
  await Promise.all(secondRunners.map((runner) => runner.promise));

  const prompts = promptByAgent.get("C");
  if (!prompts || prompts.length < 3) {
    assert.fail("缺少 C 的手动执行与两轮自动派发 prompt");
  }

  const firstAutomaticPrompt = prompts[1] ?? "";
  const secondAutomaticPrompt = prompts[2] ?? "";
  assert.match(firstAutomaticPrompt, /\[From B Agent\]\nB 的第 1 条结论。/u);
  assert.doesNotMatch(firstAutomaticPrompt, /\[From A Agent\]/u);
  assert.doesNotMatch(secondAutomaticPrompt, /\[From A Agent\]/u);
  assert.match(secondAutomaticPrompt, /\[From B Agent\]\nB 的第 2 条结论。/u);
});

test("多个 group 实例并存时，initialMessage 不会串组注入其他实例的来源消息", async () => {
  const projectPath = createTempDir();
  const orchestrator = new BatchRunnerTestOrchestrator({
    cwd: projectPath,
    userDataPath: createTempDir(),
  });
  const compiled = compileBuiltinTopology("vulnerability.yaml");
  stubOpenCodeAttachBaseUrl(orchestrator);
  orchestrator.opencodeClient.createSession = async (_title: string) => `session:`;
  await orchestrator.applyTeamDsl({
    compiled,
  });

  await orchestrator.initializeTask();

  const state = createEmptyGraphTaskState({
    topology: compiled.topology,
  });
  state.runtimeNodes = [
    {
      id: "误报论证-1",
      kind: "agent",
      templateName: "误报论证",
      displayName: "误报论证-1",
      sourceNodeId: "线索发现",
      groupId: "group-rule:疑点辩论:finding-001",
      role: "误报论证",
    },
    {
      id: "漏洞论证-1",
      kind: "agent",
      templateName: "漏洞论证",
      displayName: "漏洞论证-1",
      sourceNodeId: "线索发现",
      groupId: "group-rule:疑点辩论:finding-001",
      role: "漏洞论证",
    },
    {
      id: "讨论总结-1",
      kind: "agent",
      templateName: "讨论总结",
      displayName: "讨论总结-1",
      sourceNodeId: "线索发现",
      groupId: "group-rule:疑点辩论:finding-001",
      role: "讨论总结",
    },
    {
      id: "误报论证-2",
      kind: "agent",
      templateName: "误报论证",
      displayName: "误报论证-2",
      sourceNodeId: "线索发现",
      groupId: "group-rule:疑点辩论:finding-002",
      role: "误报论证",
    },
    {
      id: "漏洞论证-2",
      kind: "agent",
      templateName: "漏洞论证",
      displayName: "漏洞论证-2",
      sourceNodeId: "线索发现",
      groupId: "group-rule:疑点辩论:finding-002",
      role: "漏洞论证",
    },
    {
      id: "讨论总结-2",
      kind: "agent",
      templateName: "讨论总结",
      displayName: "讨论总结-2",
      sourceNodeId: "线索发现",
      groupId: "group-rule:疑点辩论:finding-002",
      role: "讨论总结",
    },
  ];
  state.runtimeEdges = [
    {
      source: "误报论证-1",
      target: "讨论总结-1",
      trigger: "<complete>",
      messageMode: "last", maxTriggerRounds: 4,
    },
    {
      source: "漏洞论证-1",
      target: "讨论总结-1",
      trigger: "<complete>",
      messageMode: "last", maxTriggerRounds: 4,
    },
    {
      source: "误报论证-2",
      target: "讨论总结-2",
      trigger: "<complete>",
      messageMode: "last", maxTriggerRounds: 4,
    },
    {
      source: "漏洞论证-2",
      target: "讨论总结-2",
      trigger: "<complete>",
      messageMode: "last", maxTriggerRounds: 4,
    },
  ];

  const insertedMessages: MessageRecord[] = [
    {
      id: "user:1",
      sender: "user",
      content: "@线索发现 请持续挖掘当前代码中的可疑漏洞点。",
      timestamp: toUtcIsoTimestamp("2026-04-30T00:00:00.000Z"),
      kind: "user",
      scope: "task",
      taskTitle: "demo",
      targetAgentIds: ["线索发现"],
      targetRunCounts: [1],
    },
    {
      id: "message:clue",
      sender: "线索发现",
      senderDisplayName: "线索发现",
      content: "1. 可疑点标题\nSMTP 数据行处理存在 safe5 相关的新可疑点。",
      timestamp: toUtcIsoTimestamp("2026-04-30T00:00:00.500Z"),
      kind: "agent-final",
      runCount: 1,
      status: "completed",
      routingKind: "default",
      rawResponse: "<continue>\n1. 可疑点标题\nSMTP 数据行处理存在 safe5 相关的新可疑点。",
    },
    {
      id: "message:误报论证-1",
      sender: "误报论证-1",
      senderDisplayName: "误报论证-1",
      content: "误报论证-1 认为 safe4 证据不足。",
      timestamp: toUtcIsoTimestamp("2026-04-30T00:00:01.000Z"),
      kind: "agent-final",
      runCount: 1,
      status: "completed",
      routingKind: "triggered",
      trigger: "<complete>",
      rawResponse: "<complete>误报论证-1 认为 safe4 证据不足。</complete>",
    },
    {
      id: "message:漏洞论证-1",
      sender: "漏洞论证-1",
      senderDisplayName: "漏洞论证-1",
      content: "漏洞论证-1 补充了 safe4 证据。",
      timestamp: toUtcIsoTimestamp("2026-04-30T00:00:02.000Z"),
      kind: "agent-final",
      runCount: 1,
      status: "completed",
      routingKind: "triggered",
      trigger: "<complete>",
      rawResponse: "<complete>漏洞论证-1 补充了 safe4 证据。</complete>",
    },
    {
      id: "message:误报论证-2",
      sender: "误报论证-2",
      senderDisplayName: "误报论证-2",
      content: "误报论证-2 认为 safe5 仍有争议。",
      timestamp: toUtcIsoTimestamp("2026-04-30T00:00:03.000Z"),
      kind: "agent-final",
      runCount: 1,
      status: "completed",
      routingKind: "triggered",
      trigger: "<complete>",
      rawResponse: "<complete>误报论证-2 认为 safe5 仍有争议。</complete>",
    },
    {
      id: "message:漏洞论证-2",
      sender: "漏洞论证-2",
      senderDisplayName: "漏洞论证-2",
      content: "漏洞论证-2 补充了 safe5 证据。",
      timestamp: toUtcIsoTimestamp("2026-04-30T00:00:04.000Z"),
      kind: "agent-final",
      runCount: 1,
      status: "completed",
      routingKind: "triggered",
      trigger: "<complete>",
      rawResponse: "<complete>漏洞论证-2 补充了 safe5 证据。</complete>",
    },
  ];
  for (const message of insertedMessages) {
    orchestrator.store.insertMessage(message);
  }

  const promptByAgent = new Map<string, string>();
  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent, content }) => {
    promptByAgent.set(agent, content);
    return buildCompletedExecutionResult({
      agent,
      finalMessage: `${agent} 已收到上下文。`,
      messageId: `message:${agent}:runner`,
      timestamp: toUtcIsoTimestamp("2026-04-30T00:00:05.000Z"),
    });
  };

  const runners = await orchestrator.runBatchRunners(
    state,
    {
      routingKind: "triggered",
      trigger: "<complete>",
      source: { kind: "agent", agentId: "漏洞论证-2" },
      sourceContent: "漏洞论证-2 补充了 safe5 证据。",
      displayContent: "漏洞论证-2 补充了 safe5 证据。",
      triggerTargets: ["讨论总结-2"],
      jobs: [
        {
          kind: "dispatch",
          agentId: "讨论总结-2",
          sourceAgentId: "漏洞论证-2",
          sourceMessageId: "message:漏洞论证-2",
          sourceContent: "漏洞论证-2 补充了 safe5 证据。",
          displayContent: "漏洞论证-2 补充了 safe5 证据。",
        },
      ],
    },
  );
  await Promise.all(runners.map((runner) => runner.promise));

  const prompt = promptByAgent.get("讨论总结");
  if (!prompt) {
    assert.fail("缺少讨论总结 prompt");
  }
  assert.match(prompt, /SMTP 数据行处理存在 safe5 相关的新可疑点/u);
  assert.match(prompt, /漏洞论证-2 补充了 safe5 证据/u);
  assert.match(prompt, /误报论证-2 认为 safe5 仍有争议/u);
  assert.doesNotMatch(prompt, /漏洞论证-1 补充了 safe4 证据/u);
  assert.doesNotMatch(prompt, /误报论证-1 认为 safe4 证据不足/u);
});

test("rfc-scanner 的 group 首轮派发到漏洞论证时，会额外注入来自线索发现的 initialMessage", async () => {
  const projectPath = createTempDir();
  const orchestrator = new BatchRunnerTestOrchestrator({
    cwd: projectPath,
    userDataPath: createTempDir(),
  });
  const compiled = compileBuiltinTopology("rfc-scanner.yaml");
  stubOpenCodeAttachBaseUrl(orchestrator);
  orchestrator.opencodeClient.createSession = async (_title: string) => `session:`;
  await orchestrator.applyTeamDsl({
    compiled,
  });

  const promptByAgent = new Map<string, string[]>();
  const recordPrompt = (agent: string, content: string) => {
    const current = promptByAgent.get(agent) ?? [];
    current.push(content);
    promptByAgent.set(agent, current);
  };
  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent, content }) => {
    recordPrompt(agent, content);
    return buildCompletedExecutionResult({
      agent,
      finalMessage: "<continue>\n我已收到线索发现与误报论证两侧材料。",
      messageId: `message:${agent}:${(promptByAgent.get(agent) ?? []).length}`,
      timestamp: toUtcIsoTimestamp("2026-05-07T02:00:00.000Z"),
    });
  };

  await orchestrator.initializeTask();

  const state = createEmptyGraphTaskState({
    topology: compiled.topology,
  });
  state.runtimeNodes = [
    {
      id: "误报论证-1",
      kind: "agent",
      templateName: "误报论证",
      displayName: "误报论证-1",
      sourceNodeId: "线索发现",
      groupId: "group-rule:疑点辩论:finding-001",
      role: "误报论证",
    },
    {
      id: "漏洞论证-1",
      kind: "agent",
      templateName: "漏洞论证",
      displayName: "漏洞论证-1",
      sourceNodeId: "线索发现",
      groupId: "group-rule:疑点辩论:finding-001",
      role: "漏洞论证",
    },
  ];
  state.runtimeEdges = [
    {
      source: "误报论证-1",
      target: "漏洞论证-1",
      trigger: "<continue>",
      messageMode: "last", maxTriggerRounds: 4,
    },
  ];

  const insertedMessages: MessageRecord[] = [
    {
      id: "user:1",
      sender: "user",
      content: "@线索发现 RFC 5321 第 2.3.8 节",
      timestamp: toUtcIsoTimestamp("2026-05-07T02:00:00.000Z"),
      kind: "user",
      scope: "task",
      taskTitle: "RFC 5321 第 2.3.8 节",
      targetAgentIds: ["线索发现"],
      targetRunCounts: [1],
    },
    {
      id: "message:clue",
      sender: "线索发现",
      senderDisplayName: "线索发现",
      content: "1. 可疑点标题\nSMTP 数据行处理存在一个新的可疑点。",
      timestamp: toUtcIsoTimestamp("2026-05-07T02:00:01.000Z"),
      kind: "agent-final",
      runCount: 1,
      status: "completed",
      routingKind: "default",
      rawResponse: "<continue>\n1. 可疑点标题\nSMTP 数据行处理存在一个新的可疑点。",
    },
    {
      id: "message:challenge",
      sender: "误报论证-1",
      senderDisplayName: "误报论证-1",
      content: "当前材料更像误报，请继续补充更直接的实现证据。",
      timestamp: toUtcIsoTimestamp("2026-05-07T02:00:02.000Z"),
      kind: "agent-final",
      runCount: 1,
      status: "completed",
      routingKind: "triggered",
      trigger: "<continue>",
      rawResponse: "<continue>\n当前材料更像误报，请继续补充更直接的实现证据。",
    },
  ];
  for (const message of insertedMessages) {
    orchestrator.store.insertMessage(message);
  }

  const runners = await orchestrator.runBatchRunners(
    state,
    {
      routingKind: "triggered",
      trigger: "<continue>",
      source: { kind: "agent", agentId: "误报论证-1" },
      sourceContent: "当前材料更像误报，请继续补充更直接的实现证据。",
      displayContent: "当前材料更像误报，请继续补充更直接的实现证据。",
      triggerTargets: ["漏洞论证-1"],
      jobs: [
        {
          kind: "dispatch",
          agentId: "漏洞论证-1",
          sourceAgentId: "误报论证-1",
          sourceMessageId: "message:challenge",
          sourceContent: "当前材料更像误报，请继续补充更直接的实现证据。",
          displayContent: "当前材料更像误报，请继续补充更直接的实现证据。",
        },
      ],
    },
  );
  await Promise.all(runners.map((runner) => runner.promise));

  const argumentPrompts = promptByAgent.get("漏洞论证");
  if (!argumentPrompts || argumentPrompts.length === 0) {
    assert.fail("缺少漏洞论证的首轮 prompt");
  }
  const firstPrompt = argumentPrompts[0] ?? "";
  const storedMessages = orchestrator.store
    .listMessages()
    .map((message) => ({
      sender: message.sender,
      kind: message.kind,
      content: message.content,
    }));
  assert.match(
    firstPrompt,
    /\[From 误报论证-1 Agent\]\n当前材料更像误报，请继续补充更直接的实现证据。/u,
  );
  assert.match(
    firstPrompt,
    /\[From 线索发现 Agent\]\n1\. 可疑点标题\nSMTP 数据行处理存在一个新的可疑点。/u,
    JSON.stringify({ firstPrompt, storedMessages }, null, 2),
  );
  assert.deepEqual(
    firstPrompt.match(/\[From [^\n]+ Agent\]/gu) ?? [],
    ["[From 线索发现 Agent]", "[From 误报论证-1 Agent]"],
    JSON.stringify({ firstPrompt, storedMessages }, null, 2),
  );
  await orchestrator.dispose(false);
  activeOrchestrators.delete(orchestrator);
});

test("讨论总结收到嵌套来源段落时，最终可见顺序按拓扑定义顺序输出", async () => {
  const projectPath = createTempDir();
  const orchestrator = new BatchRunnerTestOrchestrator({
    cwd: projectPath,
    userDataPath: createTempDir(),
  });
  const compiled = compileBuiltinTopology("vulnerability.yaml");
  await orchestrator.applyTeamDsl({
    compiled,
  });
  stubOpenCodeAttachBaseUrl(orchestrator);

  const promptByAgent = new Map<string, string>();
  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent, content }) => {
    promptByAgent.set(agent, content);
    return buildCompletedExecutionResult({
      agent,
      finalMessage: `${agent} 已收到上下文。`,
      messageId: `message:${agent}:runner`,
      timestamp: toUtcIsoTimestamp("2026-05-07T00:00:05.000Z"),
    });
  };
  orchestrator.opencodeClient.createSession = async (_title: string) => `session:`;

  await orchestrator.submitTask({ content: "@线索发现 请持续挖掘当前代码中的可疑漏洞点。" });

  const state = createEmptyGraphTaskState({
    topology: compiled.topology,
  });
  state.runtimeNodes = [
    {
      id: "误报论证-1",
      kind: "agent",
      templateName: "误报论证",
      displayName: "误报论证-1",
      sourceNodeId: "线索发现",
      groupId: "group-rule:疑点辩论:finding-001",
      role: "误报论证",
    },
    {
      id: "漏洞论证-1",
      kind: "agent",
      templateName: "漏洞论证",
      displayName: "漏洞论证-1",
      sourceNodeId: "线索发现",
      groupId: "group-rule:疑点辩论:finding-001",
      role: "漏洞论证",
    },
    {
      id: "讨论总结-1",
      kind: "agent",
      templateName: "讨论总结",
      displayName: "讨论总结-1",
      sourceNodeId: "线索发现",
      groupId: "group-rule:疑点辩论:finding-001",
      role: "讨论总结",
    },
  ];
  state.runtimeEdges = [
    {
      source: "误报论证-1",
      target: "讨论总结-1",
      trigger: "<complete>",
      messageMode: "last", maxTriggerRounds: 4,
    },
    {
      source: "漏洞论证-1",
      target: "讨论总结-1",
      trigger: "<complete>",
      messageMode: "last", maxTriggerRounds: 4,
    },
  ];
  state.forwardedAgentMessageByName["漏洞论证-1"] = [
    "[From 线索发现 Agent]",
    "1. 可疑点标题",
    "SMTP 数据行处理存在一个新的可疑点。",
  ].join("\n");
  const taskRecord = orchestrator.store.getTask();
  if (!taskRecord) {
    assert.fail("缺少测试任务");
  }

  orchestrator.store.insertMessage({
    id: "message:clue",
    sender: "线索发现",
    timestamp: toUtcIsoTimestamp("2026-05-07T00:00:01.000Z"),
    content: "1. 可疑点标题\nSMTP 数据行处理存在一个新的可疑点。",
    kind: "agent-final",
    runCount: 1,
    status: "completed",
    routingKind: "default",
    rawResponse: "<continue>\n1. 可疑点标题\nSMTP 数据行处理存在一个新的可疑点。",
    senderDisplayName: "线索发现",
  });
  orchestrator.store.insertMessage({
    id: "message:challenge",
    sender: "误报论证-1",
    timestamp: toUtcIsoTimestamp("2026-05-07T00:00:02.000Z"),
    content: "误报论证-1 给出反驳结论。",
    kind: "agent-final",
    runCount: 1,
    status: "completed",
    routingKind: "default",
    rawResponse: "<complete>\n误报论证-1 给出反驳结论。",
    senderDisplayName: "误报论证-1",
  });
  orchestrator.store.insertMessage({
    id: "message:argument",
    sender: "漏洞论证-1",
    timestamp: toUtcIsoTimestamp("2026-05-07T00:00:03.000Z"),
    content: "漏洞论证-1 给出正方结论。",
    kind: "agent-final",
    runCount: 1,
    status: "completed",
    routingKind: "triggered",
    trigger: "<complete>",
    rawResponse: "<complete>\n漏洞论证-1 给出正方结论。",
    senderDisplayName: "漏洞论证-1",
  });

  const runners = await orchestrator.runBatchRunners(
    state,
    {
      routingKind: "triggered",
      trigger: "<complete>",
      source: { kind: "agent", agentId: "漏洞论证-1" },
      sourceContent: "漏洞论证-1 给出正方结论。",
      displayContent: "漏洞论证-1 给出正方结论。",
      triggerTargets: ["讨论总结-1"],
      jobs: [
        {
          kind: "dispatch",
          agentId: "讨论总结-1",
          sourceAgentId: "漏洞论证-1",
          sourceMessageId: "message:argument",
          sourceContent: "漏洞论证-1 给出正方结论。",
          displayContent: "漏洞论证-1 给出正方结论。",
        },
      ],
    },
  );
  await Promise.all(runners.map((runner) => runner.promise));

  const prompt = promptByAgent.get("讨论总结");
  if (!prompt) {
    assert.fail("缺少讨论总结 prompt");
  }
  assert.match(
    prompt,
    /\[From 线索发现 Agent\]\n1\. 可疑点标题\nSMTP 数据行处理存在一个新的可疑点。\n\n\[From 误报论证-1 Agent\]\n误报论证-1 给出反驳结论。\n\n\[From 漏洞论证-1 Agent\]\n漏洞论证-1 给出正方结论。/u,
  );
  assert.deepEqual(
    prompt.match(/\[From [^\n]+ Agent\]/gu) ?? [],
    ["[From 线索发现 Agent]", "[From 误报论证-1 Agent]", "[From 漏洞论证-1 Agent]"],
  );

  await orchestrator.dispose(false);
  activeOrchestrators.delete(orchestrator);
});
test("当前 Project 缺少 Build Agent 时，默认会从 start node 开始，显式 @Build 仍会被拒绝", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeSessions(orchestrator);
  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent }) =>
    buildCompletedExecutionResult({
      agent,
      finalMessage: `${agent} 已收到任务`,
      messageId: `message:${agent}`,
      timestamp: toUtcIsoTimestamp("2026-04-15T00:00:00.000Z"),
    });

  await orchestrator.getWorkspaceSnapshot();
  await addCustomAgent(orchestrator, "BA", "你是 BA。", "BA", false);

  const submittedTask = await orchestrator.submitTask({ content: "@BA 请先整理需求。" });

  const firstUserMessage = submittedTask.messages.find((message) => message.sender === "user");
  assert.deepEqual(
    firstUserMessage && isUserMessageRecord(firstUserMessage)
      ? getMessageTargetAgentIds(firstUserMessage)
      : [],
    ["BA"],
  );

  const defaultSubmittedTask = await orchestrator.submitTask({ content: "请先整理需求。" });

  const defaultUserMessage = defaultSubmittedTask.messages.findLast((message) => message.sender === "user");
  assert.deepEqual(
    defaultUserMessage && isUserMessageRecord(defaultUserMessage)
      ? getMessageTargetAgentIds(defaultUserMessage)
      : [],
    ["BA"],
  );

  await assert.rejects(async () => orchestrator.submitTask({ content: "@Build 请先实现需求。",
  }), /@Build 不可用/u);
});

test("单 decisionAgent 返回 <continue> 后会按 trigger 回流给 Build", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
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
      timestamp: toUtcIsoTimestamp(`2026-04-15T00:00:0${count}.000Z`),
    });

  orchestrator.opencodeClient.createSession = async (_title: string) => `session:`;
  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent, content }) => {
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

  let project = await orchestrator.getWorkspaceSnapshot();
  project = await addBuiltinAgents(orchestrator, ["BA", "Build", "CodeReview"], "BA", []);
  await orchestrator.saveTopology({
      ...project.topology,
      nodes: ["BA", "Build", "CodeReview"],
      edges: [
        {
          source: "BA",
          target: "Build",
          trigger: "<default>",
          messageMode: "last", maxTriggerRounds: 4,
        },
        {
          source: "Build",
          target: "CodeReview",
          trigger: "<default>",
          messageMode: "last", maxTriggerRounds: 4,
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
          messageMode: "last", maxTriggerRounds: 4,
        },
      ],
    },
  );

  await orchestrator.submitTask({ content: "@BA 请实现 add 方法，并准备判定修复。" });

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
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
  assert.match(buildPromptHistory[0] ?? "", /\[From BA Agent\]/u);
  assert.doesNotMatch(buildPromptHistory[0] ?? "", /\[Initial Task\]/u);
  assert.match(buildPromptHistory[1] ?? "", /\[From CodeReview Agent\]/u);
  assert.match(buildPromptHistory[1] ?? "", /请修复构建结果/u);
  assert.doesNotMatch(codeReviewPromptHistory[0] ?? "", /\[Initial Task\]/u);
  assert.match(codeReviewPromptHistory[0] ?? "", /\[From Build Agent\]/u);
  assert.equal(buildPromptHistory.length, 2);
  assert.equal(codeReviewPromptHistory.length, 2);
});

test("首个 <continue> 触发上游重派发后，会按上游默认边重新派发全部下游 decisionAgent", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });

  stubOpenCodeAttachBaseUrl(orchestrator);

  const completedResponse = (agent: string, count: number, content: string) =>
    buildCompletedExecutionResult({
      agent,
      finalMessage: content,
      messageId: `message:${agent}:${count}`,
      timestamp: toUtcIsoTimestamp(`2026-04-16T00:01:${String(count).padStart(2, "0")}.000Z`),
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

  orchestrator.opencodeClient.createSession = async (_title: string) => `session:`;
  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent }) => {
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
        return completedResponse(agent, taskDecisionRunCount, "TaskReview: ok\n\n<complete>同意当前结果。</complete>");
      }
      await taskDecisionSecondRunGate;
      return completedResponse(agent, taskDecisionRunCount, "TaskReview 第 2 轮复检通过。\n\n<complete>同意当前结果。</complete>");
    }
    codeDecisionRunCount += 1;
    if (codeDecisionRunCount === 1) {
      return completedResponse(agent, codeDecisionRunCount, "CodeReview: ok\n\n<complete>同意当前结果。</complete>");
    }
    await codeDecisionSecondRunGate;
    return completedResponse(agent, codeDecisionRunCount, "CodeReview 第 2 轮复检通过。\n\n<complete>同意当前结果。</complete>");
  };

  let project = await orchestrator.getWorkspaceSnapshot();
  project = await addBuiltinAgents(
    orchestrator, ["Build", "UnitTest", "TaskReview", "CodeReview"],
    "Build",
    [],
  );
  await orchestrator.saveTopology({
      ...project.topology,
      nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
      edges: [
        { source: "Build", target: "UnitTest", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "Build", target: "TaskReview", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "Build", target: "CodeReview", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "UnitTest", target: "Build", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "TaskReview", target: "Build", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "CodeReview", target: "Build", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "UnitTest", target: "__end__", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "TaskReview", target: "__end__", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "CodeReview", target: "__end__", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
      ],
    },
  );

  await orchestrator.submitTask({ content: "@Build 请完成这个需求。" });

  try {
    await waitForValue(
      () => ({
        buildRunCount,
        unitTestRunCount,
        taskDecisionRunCount,
        codeDecisionRunCount,
      }),
      (counts) =>
        counts.buildRunCount === 2
        && counts.unitTestRunCount === 2
        && counts.taskDecisionRunCount === 2
        && counts.codeDecisionRunCount === 2,
      5000,
    );

    assert.equal(buildRunCount, 2);
    assert.equal(unitTestRunCount, 2);
    assert.equal(taskDecisionRunCount, 2);
    assert.equal(codeDecisionRunCount, 2);
  } finally {
    releaseUnitTestSecondRun();
    releaseTaskReviewSecondRun();
    releaseCodeReviewSecondRun();
    await waitForTaskSnapshot(
    orchestrator,
    (snapshot) => isTerminalTaskStatus(snapshot.task.status),
      5000,
    ).catch(() => undefined);
  }
});

test("命中的 <continue> 会立即触发重派发，但同轮未结束执行存在时任务保持 running", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });

  stubOpenCodeAttachBaseUrl(orchestrator);

  const completedResponse = (agent: string, count: number, content: string) =>
    buildCompletedExecutionResult({
      agent,
      finalMessage: content,
      messageId: `message:${agent}:${count}`,
      timestamp: toUtcIsoTimestamp(`2026-04-16T00:00:${String(count).padStart(2, "0")}.000Z`),
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

  orchestrator.opencodeClient.createSession = async (_title: string) => `session:`;
  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent, content }) => {
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
      return completedResponse(
        agent,
        taskDecisionRunCount,
        taskDecisionRunCount === 1
          ? "TaskReview 第 1 轮通过。\n\n<complete>同意当前结果。</complete>"
          : "TaskReview 第 2 轮通过。\n\n<complete>同意当前结果。</complete>",
      );
    }
    codeDecisionRunCount += 1;
    if (codeDecisionRunCount === 1) {
      codeDecisionStarted = true;
      await codeDecisionGate;
    }
    return completedResponse(
      agent,
      codeDecisionRunCount,
      codeDecisionRunCount === 1
        ? "CodeReview 第 1 轮通过。\n\n<complete>同意当前结果。</complete>"
        : "CodeReview 第 2 轮通过。\n\n<complete>同意当前结果。</complete>",
    );
  };

  let project = await orchestrator.getWorkspaceSnapshot();
  project = await addBuiltinAgents(
    orchestrator, ["Build", "UnitTest", "TaskReview", "CodeReview"],
    "Build",
    [],
  );
  await orchestrator.saveTopology({
      ...project.topology,
      nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
      edges: [
        { source: "Build", target: "UnitTest", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "Build", target: "TaskReview", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "Build", target: "CodeReview", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "UnitTest", target: "Build", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "TaskReview", target: "Build", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "CodeReview", target: "Build", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "UnitTest", target: "__end__", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "TaskReview", target: "__end__", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "CodeReview", target: "__end__", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
      ],
    },
  );

  await orchestrator.submitTask({ content: "@Build 请完成这个需求。" });

  await waitForTaskSnapshot(
    orchestrator,
    () => unitTestStarted && taskDecisionStarted && codeDecisionStarted,
  );

  assert.equal(buildRunCount, 1);
  assert.equal(unitTestStarted, true);
  assert.equal(taskDecisionStarted, true);
  assert.equal(codeDecisionStarted, true);

  releaseUnitTest();
  const runningSnapshot = await waitForTaskSnapshot(
    orchestrator,
    (snapshot) =>
      snapshot.task.status === "running"
      && buildRunCount === 2
      && unitTestRunCount === 2
      && taskDecisionRunCount === 2
      && codeDecisionRunCount === 2,
    8000,
  );
  assert.equal(runningSnapshot.task.status, "running");
  assert.equal(buildRunCount, 2);
  assert.equal(
    runningSnapshot.agents.some((agent) => agent.id === "Build" && agent.status === "completed"),
    true,
  );
  assert.equal(
    runningSnapshot.messages.some((message) =>
      message.sender === "system"
      && message.kind === "task-round-finished"
    ),
    false,
  );

  releaseTaskReview();
  releaseCodeReview();
  const finishedSnapshot = await waitForTaskSnapshot(
    orchestrator,
    (snapshot) => snapshot.task.status === "finished",
    8000,
  );
  assert.equal(finishedSnapshot.task.status, "finished");
  assert.equal(buildRunCount, 2);
  assert.equal(unitTestRunCount, 2);
  assert.equal(taskDecisionRunCount, 2);
  assert.equal(codeDecisionRunCount, 2);
  assert.equal(buildPrompts.length, 2);
});

test("Task 启动后仍允许重新 applyTeamDsl，让 task headless/task ui 的 --file 继续以 .yaml 为准", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeSessions(orchestrator);

  await orchestrator.getWorkspaceSnapshot();
  await addCustomAgent(orchestrator, "BA", "你是 BA。", "BA", false);
  await orchestrator.initializeTask();
  const reapplied = await replaceWorkspaceAgents(orchestrator, "BA", [
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
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeSessions(orchestrator);

  await orchestrator.getWorkspaceSnapshot();
  await addCustomAgent(orchestrator, "BA", "你是 BA。", "BA", false);
  await orchestrator.saveTopology(withAgentNodeRecords({
      nodes: ["BA"],
      edges: [],
    }),
  );
  await orchestrator.initializeTask();

  orchestrator.opencodeClient.createSession = async (_title: string) => `session:`;
  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent }) =>
    buildCompletedExecutionResult({
      agent,
      finalMessage: "",
      messageId: "msg-empty",
      timestamp: toUtcIsoTimestamp("2026-04-25T00:00:00.000Z"),
    });

  await orchestrator.runStandaloneAgent({
    agentId: "BA",
    prompt: {
      mode: "raw",
      from: "User",
      content: "请输出结果",
    },
  });

  const snapshot = await orchestrator.getTaskSnapshot();
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
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeSessions(orchestrator);

  await orchestrator.getWorkspaceSnapshot();
  await addCustomAgent(orchestrator, "BA", "你是 BA。", "BA", false);
  await orchestrator.saveTopology(withAgentNodeRecords({
      nodes: ["BA"],
      edges: [],
    }),
  );

  orchestrator.opencodeClient.submitMessage = async () =>
    buildCompletedExecutionResult({
      agent: "BA",
      finalMessage: "验证成功。",
      messageId: "msg-single-agent-final",
      timestamp: toUtcIsoTimestamp("2026-04-21T13:10:00.000Z"),
    });

  await orchestrator.submitTask({ content: "@BA 请输出一句验证成功。" });

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
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

test("agent-final 入库前会保留完整正文和尾部分隔线", async () => {
  const userDataPath = createTempDir();
  initAppFileLogger(userDataPath);
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeSessions(orchestrator);

  await orchestrator.getWorkspaceSnapshot();
  await addCustomAgent(orchestrator, "BA", "你是 BA。", "BA", false);
  await orchestrator.saveTopology(withAgentNodeRecords({
      nodes: ["BA"],
      edges: [],
    }),
  );

  const finalMessage = `前置分析

## 结论
这里是最终判断，并附加额外说明用于验证日志截断是否生效。
---`;
  orchestrator.opencodeClient.submitMessage = async () =>
    buildCompletedExecutionResult({
      agent: "BA",
      finalMessage,
      messageId: "msg-full-final",
      timestamp: toUtcIsoTimestamp("2026-04-21T13:20:00.000Z"),
    });

  const submittedTask = await orchestrator.submitTask({ content: "@BA 请输出完整结果。" });

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
    (current) => current.task.status === "finished",
    8000,
  );

  const baFinalMessage = requireSingleMessage(
    snapshot.messages.filter(
      (message) => message.sender === "BA" && message.kind === "agent-final",
    ),
    "缺少 BA 最终消息",
  );
  assert.equal(baFinalMessage.content, finalMessage);
  const taskLogPath = buildTaskLogFilePath(userDataPath, submittedTask.task.id);
  const finalMessageLog = fs.readFileSync(taskLogPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((record) => record.event === "agent.final_message");
  assert.equal(finalMessageLog.agentId, "BA");
  assert.equal(finalMessageLog.messageId, "msg-full-final");
  assert.equal(finalMessageLog.content, "前置分析 ## 结论 这里是最终判断，并附加额外说明用于验证日志截断是否生效。 ---");
});

test("agent-final 入库前会移除协议 trigger 并保留正文细节", async () => {
  const userDataPath = createTempDir();
  initAppFileLogger(userDataPath);
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeSessions(orchestrator);

  await orchestrator.getWorkspaceSnapshot();
  await addCustomAgent(orchestrator, "漏洞论证", "你负责漏洞论证。", "漏洞论证", false);
  await orchestrator.saveTopology(withAgentNodeRecords({
      nodes: ["漏洞论证"],
      edges: [],
      flow: {
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
    }),
  );

  const expectedContent = `正文

继续处理。

如果你愿意，我可以继续补测试。
---`;
  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent }) =>
    buildCompletedExecutionResult({
      agent,
      finalMessage: `<done>${expectedContent}</done>`,
      messageId: "msg-trigger-clean-final",
      timestamp: toUtcIsoTimestamp("2026-04-21T13:30:00.000Z"),
    });

  await orchestrator.submitTask({ content: "@漏洞论证 请输出完整结果。" });

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
    (current) => current.task.status === "finished",
    8000,
  );

  const finalMessage = requireSingleTriggeredAgentFinalMessage(
    snapshot.messages.filter((message) => message.sender === "漏洞论证"),
    "缺少漏洞论证最终消息",
  );
  assert.equal(finalMessage.trigger, "<done>");
  assert.equal(finalMessage.content, expectedContent);
});

test("agent 运行中不会把 OpenCode runtime 过程消息持久化到 task messages", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const pendingRun = {
    ready: false,
    resolve: (_result: OpenCodeExecutionResult): void => {
      throw new Error("测试中的 agent 运行 promise 没有进入等待状态");
    },
  };

  const orchestrator = new StandaloneRunTestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeSessions(orchestrator);

  await orchestrator.getWorkspaceSnapshot();
  await addCustomAgent(orchestrator, "BA", "你是 BA。", "BA", false);
  await orchestrator.saveTopology(withAgentNodeRecords({
      nodes: ["BA"],
      edges: [],
    }),
  );
  await orchestrator.initializeTask();

  orchestrator.opencodeClient.submitMessage = async () =>
    new Promise<OpenCodeExecutionResult>((resolve) => {
      pendingRun.ready = true;
      pendingRun.resolve = resolve;
    });

  const runPromise = orchestrator.runStandaloneAgent({
    agentId: "BA",
    prompt: {
      mode: "raw",
      from: "User",
      content: "请先读取文件再回答",
    },
  });

  await waitForValue(
    () => pendingRun.ready,
    (ready) => ready,
    1000,
  );
  const runningSnapshot = await orchestrator.getTaskSnapshot();
  assert.equal(runningSnapshot.task.status, "running");
  assert.equal(
    runningSnapshot.messages.some((message) => message.kind === "agent-progress"),
    false,
  );

  pendingRun.resolve(
    buildCompletedExecutionResult({
      agent: "BA",
      finalMessage: "已完成读取。",
      messageId: "msg-runtime-final",
      timestamp: toUtcIsoTimestamp("2026-04-30T12:00:02.000Z"),
    }),
  );
  await runPromise;
});

test("判定 Agent 未返回合法标签时必须判为 invalid", () => {
  const parsedDecision = parseDecision(
    "这是普通判定正文，标签写错了。\n\n<chalenge>请继续补充实现依据。</chalenge>",
    ["<continue>"],
  );

  assert.deepEqual(parsedDecision, {
    kind: "invalid",
    validationError: "回复必须有且仅有 <continue> 之一",
  });
});

test("自定义 trigger 会按精确标签触发约定下游", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeSessions(orchestrator);

  let project = await orchestrator.getWorkspaceSnapshot();
  project = await addCustomAgent(orchestrator, "漏洞论证", "你负责漏洞论证。", "漏洞论证", false);
  project = await addCustomAgent(orchestrator, "误报论证", "你负责误报论证。", "漏洞论证", false);
  await orchestrator.saveTopology({
      ...project.topology,
      nodes: ["漏洞论证", "误报论证"],
      edges: [
        {
          source: "漏洞论证",
          target: "误报论证",
          trigger: "<abcd>",
          messageMode: "last", maxTriggerRounds: 4,
        },
      ],
    },
  );

  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent }) => {
    if (agent === "漏洞论证") {
      return buildCompletedExecutionResult({
        agent,
        finalMessage: "当前需要挑战方继续回应。\n\n<abcd>请误报论证继续回应。</abcd>",
        messageId: "message:漏洞论证:1",
        timestamp: toUtcIsoTimestamp("2026-04-27T10:00:00.000Z"),
      });
    }
    return buildCompletedExecutionResult({
      agent,
      finalMessage: "我已收到这条自定义触发。",
      messageId: "message:误报论证:1",
      timestamp: toUtcIsoTimestamp("2026-04-27T10:00:01.000Z"),
    });
  };

  await orchestrator.submitTask({ content: "@漏洞论证 请继续当前争议点的论证。" });

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
    (current) =>
      current.messages.some((message) => message.sender === "误报论证" && message.kind === "agent-final"),
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
        message.sender === "误报论证"
        && message.kind === "agent-final"
        && message.content === "我已收到这条自定义触发。",
    ),
    true,
  );
});

test("custom-only trigger 返回未声明的示例 label 时会直接失败，不会误派发下游", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeSessions(orchestrator);

  let project = await orchestrator.getWorkspaceSnapshot();
  project = await addCustomAgent(orchestrator, "漏洞论证", "你负责漏洞论证。", "漏洞论证", false);
  project = await addCustomAgent(orchestrator, "误报论证", "你负责误报论证。", "漏洞论证", false);
  await orchestrator.saveTopology({
      ...project.topology,
      nodes: ["漏洞论证", "误报论证"],
      edges: [
        {
          source: "漏洞论证",
          target: "误报论证",
          trigger: "<abcd>",
          messageMode: "last", maxTriggerRounds: 4,
        },
      ],
    },
  );

  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent }) =>
    buildCompletedExecutionResult({
      agent,
      finalMessage: "<continue>请误报论证继续回应。</continue>",
      messageId: `message:${agent}:1`,
      timestamp: toUtcIsoTimestamp("2026-04-27T10:10:00.000Z"),
    });

  await orchestrator.submitTask({ content: "@漏洞论证 请继续当前争议点的论证。" });

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
    (current) => current.task.status === "failed",
    8000,
  );

  const argumentMessage = snapshot.messages.findLast(
    (message) => message.sender === "漏洞论证" && message.kind === "agent-final",
  );
  if (!argumentMessage || argumentMessage.kind !== "agent-final" || argumentMessage.routingKind !== "invalid") {
    assert.fail("缺少漏洞论证的最终消息");
  }
  assert.equal(argumentMessage.routingKind, "invalid");
  assert.match(argumentMessage.content, /回复必须有且仅有 <abcd> 之一/u);
  assert.equal(snapshot.messages.some((message) => message.sender === "误报论证"), false);

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
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeSessions(orchestrator);

  await orchestrator.getWorkspaceSnapshot();
  await addCustomAgent(orchestrator, "漏洞论证", "你负责漏洞论证。", "漏洞论证", false);
  await orchestrator.saveTopology(withAgentNodeRecords({
      nodes: ["漏洞论证"],
      edges: [],
      flow: {
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
    }),
  );

  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent }) =>
    buildCompletedExecutionResult({
      agent,
      finalMessage: "<done>\n当前争议点已经论证完毕。\n</done>",
      messageId: `message:${agent}:done`,
      timestamp: toUtcIsoTimestamp("2026-04-27T10:20:00.000Z"),
    });

  await orchestrator.submitTask({ content: "@漏洞论证 请完成本轮论证。" });

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
    (current) => current.task.status === "finished",
    8000,
  );

  const argumentMessage = snapshot.messages.findLast(
    (message) => message.sender === "漏洞论证" && message.kind === "agent-final",
  );
  if (!argumentMessage || argumentMessage.kind !== "agent-final" || argumentMessage.routingKind !== "triggered") {
    assert.fail("缺少漏洞论证的最终消息");
  }
  assert.equal(argumentMessage.trigger, "<done>");
  assert.equal(argumentMessage.content, "当前争议点已经论证完毕。");
});

test("判定 Agent 未返回合法标签时必须直接判 invalid 并终止任务", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeSessions(orchestrator);

  let project = await orchestrator.getWorkspaceSnapshot();
  project = await addBuiltinAgents(orchestrator, ["Build", "TaskReview"], "Build", []);
  await orchestrator.saveTopology({
      ...project.topology,
      nodes: ["Build", "TaskReview"],
      edges: [
        { source: "Build", target: "TaskReview", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "TaskReview", target: "Build", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
      ],
    },
  );

  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent }) => {
    if (agent === "Build") {
      return buildCompletedExecutionResult({
        agent,
        finalMessage: "Build 首轮实现完成。",
        messageId: "message:Build:1",
        timestamp: toUtcIsoTimestamp("2026-04-25T10:00:00.000Z"),
      });
    }

    return buildCompletedExecutionResult({
      agent,
      finalMessage: "当前证据链还不完整，请继续补充实现依据。\n\n<chalenge>请继续补充实现依据。</chalenge>",
      messageId: "message:TaskReview:1",
      timestamp: toUtcIsoTimestamp("2026-04-25T10:00:01.000Z"),
    });
  };

  await orchestrator.submitTask({ content: "@Build 请完成这个需求。" });

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
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
  assert.match(taskDecisionFinal.content, /回复必须有且仅有 <continue> 之一/u);
  assert.equal(
    snapshot.messages.some(
      (message) => message.sender === "TaskReview" && message.kind === "agent-dispatch",
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
  const orchestrator = new StandaloneRunTestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeSessions(orchestrator);

  let project = await orchestrator.getWorkspaceSnapshot();
  project = await addBuiltinAgents(orchestrator, ["Build", "CodeReview"], "Build", []);
  const topology = {
    ...project.topology,
    edges: [
      ...project.topology.edges.filter((edge) => edge.source !== "CodeReview"),
      {
        source: "Build",
        target: "CodeReview",
        trigger: "<default>" as const,
        messageMode: "last" as const,
        maxTriggerRounds: 4,
      },
      {
        source: "CodeReview",
        target: "Build",
        trigger: "<continue>" as const,
        messageMode: "last" as const,
        maxTriggerRounds: 4,
      },
    ],
  };
  await orchestrator.saveTopology(topology);
  await orchestrator.initializeTask();
  orchestrator.opencodeClient.submitMessage = async () => {
    throw new Error("Aborted");
  };

  await orchestrator.runStandaloneAgent({
    agentId: "CodeReview",
    prompt: {
      mode: "structured",
      from: "Build",
      agentMessage: "请判定本轮改动",
      omitSourceAgentSectionLabel: false,
    },
  });

  const snapshot = await orchestrator.getTaskSnapshot();
  assert.equal(snapshot.task.status, "failed");
  assert.equal(
    snapshot.messages.some(
      (message) =>
        message.sender === "CodeReview" &&
        message.kind === "agent-dispatch",
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
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeSessions(orchestrator);

  orchestrator.opencodeClient.createSession = async (_title: string) => `session:`;
  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent }) =>
    buildCompletedExecutionResult({
      agent,
      finalMessage: `${agent} 已完成`,
      messageId: `message:${agent}`,
      timestamp: toUtcIsoTimestamp("2026-04-15T00:00:00.000Z"),
    });

  let project = await orchestrator.getWorkspaceSnapshot();
  project = await addBuiltinAgents(orchestrator, ["Build"], "Build", []);
  project = await addCustomAgent(orchestrator, "QA", "你是 QA。", "Build", false);
  await orchestrator.saveTopology({
      ...project.topology,
      nodes: ["Build", "QA"],
      edges: [
        {
          source: "Build",
          target: "QA",
          trigger: "<default>",
          messageMode: "last", maxTriggerRounds: 4,
        },
      ],
    },
  );
  await orchestrator.initializeTask();

  await orchestrator.runStandaloneAgent({
    agentId: "Build",
    prompt: {
      mode: "raw",
      from: "User",
      content: "先执行 Build",
    },
  });

  let snapshot = await orchestrator.getTaskSnapshot();
  assert.equal(snapshot.task.status, "finished");

  await orchestrator.runStandaloneAgent({
    agentId: "QA",
    prompt: {
      mode: "raw",
      from: "User",
      content: "再执行 QA",
    },
  });

  snapshot = await orchestrator.getTaskSnapshot();
  assert.equal(snapshot.task.status, "finished");
  assert.notEqual(snapshot.task.completedAt, "");
  assert.equal(Number.isFinite(Date.parse(snapshot.task.completedAt)), true);
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
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeSessions(orchestrator);

  await orchestrator.getWorkspaceSnapshot();
  await addBuiltinAgents(orchestrator, ["Build", "UnitTest"], "Build", ["Build"]);
  await orchestrator.saveTopology(withAgentNodeRecords({
      nodes: ["Build", "UnitTest"],
      edges: [
        { source: "Build", target: "UnitTest", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "UnitTest", target: "Build", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
      ],
    }),
  );

  await orchestrator.submitTask({ content: "@Build 请完成需求并通过 UnitTest" });
  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent }) => {
    if (agent === "Build") {
      buildRunCount += 1;
      return buildCompletedExecutionResult({
        agent,
        finalMessage: `Build 第 ${buildRunCount} 轮修复完成`,
        messageId: `msg-build-${buildRunCount}`,
        timestamp: toUtcIsoTimestamp("2026-04-19T00:00:00.000Z"),
      });
    }

    unitTestRunCount += 1;
    if (unitTestRunCount <= 5) {
      return {
        ...buildCompletedExecutionResult({
          agent,
          finalMessage: `UnitTest 第 ${unitTestRunCount} 轮未通过。\n\n<continue>请修复第 ${unitTestRunCount} 轮问题。</continue>`,
          messageId: `msg-unit-${unitTestRunCount}`,
          timestamp: toUtcIsoTimestamp("2026-04-19T00:00:00.000Z"),
        }),
        rawMessage: {
          id: `msg-unit-${unitTestRunCount}`,
          content: `UnitTest 第 ${unitTestRunCount} 轮未通过`,
          sender: agent,
          timestamp: toUtcIsoTimestamp("2026-04-19T00:00:00.000Z"),
          error: "",
          raw: {},
        },
      };
    }

    return {
      ...buildCompletedExecutionResult({
        agent,
        finalMessage: "UnitTest 通过。\n\n<complete>同意当前结果。</complete>",
        messageId: `msg-unit-${unitTestRunCount}`,
        timestamp: toUtcIsoTimestamp("2026-04-19T00:00:00.000Z"),
      }),
      rawMessage: {
        id: `msg-unit-${unitTestRunCount}`,
        content: "UnitTest 通过",
        sender: agent,
        timestamp: toUtcIsoTimestamp("2026-04-19T00:00:00.000Z"),
        error: "",
        raw: {},
      },
    };
  };

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
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

test("聊天页面会按每条 trigger 边的单独上限展示失败原因", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();

  let buildRunCount = 0;
  let unitTestRunCount = 0;

  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeSessions(orchestrator);

  await orchestrator.getWorkspaceSnapshot();
  await addBuiltinAgents(orchestrator, ["Build", "UnitTest"], "Build", ["Build"]);
  await orchestrator.saveTopology(withAgentNodeRecords({
      nodes: ["Build", "UnitTest"],
      edges: [
        { source: "Build", target: "UnitTest", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "UnitTest", target: "Build", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
      ],
    }),
  );

  await orchestrator.submitTask({ content: "@Build 请完成需求并通过 UnitTest" });
  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent }) => {
    if (agent === "Build") {
      buildRunCount += 1;
      return buildCompletedExecutionResult({
        agent,
        finalMessage: `Build 第 ${buildRunCount} 轮修复完成`,
        messageId: `msg-build-limit-${buildRunCount}`,
        timestamp: toUtcIsoTimestamp("2026-04-19T00:00:00.000Z"),
      });
    }

    unitTestRunCount += 1;
    return {
      ...buildCompletedExecutionResult({
        agent,
        finalMessage: `UnitTest 第 ${unitTestRunCount} 轮未通过。\n\n<continue>请修复第 ${unitTestRunCount} 轮问题。</continue>`,
        messageId: `msg-unit-limit-${unitTestRunCount}`,
        timestamp: toUtcIsoTimestamp("2026-04-19T00:00:00.000Z"),
      }),
      rawMessage: {
        id: `msg-unit-limit-${unitTestRunCount}`,
        content: `UnitTest 第 ${unitTestRunCount} 轮未通过`,
        sender: agent,
        timestamp: toUtcIsoTimestamp("2026-04-19T00:00:00.000Z"),
        error: "",
        raw: {},
      },
    };
  };

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
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
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeAttachBaseUrl(orchestrator);

  orchestrator.opencodeClient.createSession = async (_title: string) => `session:`;
  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent }) => {
    if (agent === "Build") {
      buildRunCount += 1;
      return buildCompletedExecutionResult({
        agent,
        finalMessage: buildRunCount === 1 ? "Build 已完成" : "Build 已修复 decisionAgent 意见。",
        messageId: `message:Build:${buildRunCount}`,
        timestamp: toUtcIsoTimestamp(`2026-04-17T00:00:0${buildRunCount - 1}.000Z`),
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
        timestamp: toUtcIsoTimestamp(`2026-04-17T00:00:1${unitTestRunCount - 1}.000Z`),
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
      timestamp: toUtcIsoTimestamp(`2026-04-17T00:00:2${taskDecisionRunCount - 1}.000Z`),
    });
  };

  let project = await orchestrator.getWorkspaceSnapshot();
  project = await addBuiltinAgents(orchestrator, ["Build", "UnitTest", "TaskReview"], "Build", []);
  await orchestrator.saveTopology({
      ...project.topology,
      nodes: ["Build", "UnitTest", "TaskReview"],
      edges: [
        { source: "Build", target: "UnitTest", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "Build", target: "TaskReview", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "UnitTest", target: "Build", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "TaskReview", target: "Build", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "UnitTest", target: "__end__", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "TaskReview", target: "__end__", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
      ],
    },
  );

  await orchestrator.submitTask({ content: "@Build 请完成这个需求。" });

  await waitForTaskSnapshot(
    orchestrator,
    () => unitTestStarted && taskDecisionStarted,
  );

  releaseUnitTest();
  await waitForTaskSnapshot(
    orchestrator,
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

  let releaseRedispatchExecution: () => void = () => undefined;
  const redispatchExecutionGate = new Promise<void>((resolve) => {
    releaseRedispatchExecution = resolve;
  });
  let buildRunCount = 0;
  let unitTestRunCount = 0;
  let taskDecisionRunCount = 0;

  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeAttachBaseUrl(orchestrator);
  orchestrator.opencodeClient.createSession = async (_title: string) => `session:`;
  orchestrator.opencodeClient.submitMessage = async (_sessionId, { agent }) => {
    if (agent === "Build") {
      buildRunCount += 1;
      return buildCompletedExecutionResult({
        agent,
        finalMessage: buildRunCount === 1 ? "Build 首轮实现完成。" : "Build 已根据 UnitTest 意见修复完成。",
        messageId: `message:Build:${buildRunCount}`,
        timestamp: toUtcIsoTimestamp(`2026-04-24T15:37:1${buildRunCount}.000Z`),
      });
    }

    if (agent === "UnitTest") {
      if (buildRunCount >= 2 && unitTestRunCount === 1) {
        await redispatchExecutionGate;
      }
      unitTestRunCount += 1;
      return buildCompletedExecutionResult({
        agent,
        finalMessage:
          unitTestRunCount === 1
            ? "UnitTest 未通过。\n\n<continue>请修复 UnitTest。</continue>"
            : "UnitTest 通过。\n\n<complete>同意当前结果。</complete>",
          messageId: `message:UnitTest:${unitTestRunCount}`,
          timestamp: toUtcIsoTimestamp(`2026-04-24T15:37:2${unitTestRunCount}.000Z`),
        });
    }

    if (buildRunCount >= 2 && unitTestRunCount === 1) {
      await redispatchExecutionGate;
    }

    taskDecisionRunCount += 1;
    return buildCompletedExecutionResult({
      agent,
      finalMessage: "TaskReview 通过。\n\n<complete>同意当前结果。</complete>",
      messageId: `message:TaskReview:${taskDecisionRunCount}`,
      timestamp: toUtcIsoTimestamp(`2026-04-24T15:37:3${taskDecisionRunCount}.000Z`),
    });
  };

  let project = await orchestrator.getWorkspaceSnapshot();
  project = await addBuiltinAgents(orchestrator, ["Build", "UnitTest", "TaskReview"], "Build", []);
  await orchestrator.saveTopology({
      ...project.topology,
      nodes: ["Build", "UnitTest", "TaskReview"],
      edges: [
        { source: "Build", target: "UnitTest", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "Build", target: "TaskReview", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "UnitTest", target: "Build", trigger: "<continue>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "TaskReview", target: "__end__", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
        { source: "UnitTest", target: "__end__", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
      ],
    },
  );

  await orchestrator.submitTask({ content: "@Build 请完成这个需求。" });

  const snapshotDuringRedispatchWindow = await waitForTaskSnapshot(
    orchestrator,
    (snapshot) =>
      buildRunCount === 2
      && unitTestRunCount === 1
      && taskDecisionRunCount === 1
      && snapshot.messages.some(
        (message) =>
          message.sender === "Build"
          && message.kind === "agent-final"
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

  releaseRedispatchExecution();

  const settledSnapshot = await waitForTaskSnapshot(
    orchestrator,
    (snapshot) =>
      snapshot.task.status === "finished"
      && unitTestRunCount === 2
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
  assert.equal(taskDecisionRunCount, 2);
});

test("getWorkspaceSnapshot 不会再跨进程回放当前工作区任务", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeSessions(orchestrator);
  await orchestrator.getWorkspaceSnapshot();
  await addBuiltinAgents(orchestrator, ["Build"], "Build", []);
  await orchestrator.initializeTask();

  const reloaded = new TestOrchestrator({
    cwd: projectPath,
    userDataPath,
  });
  stubOpenCodeSessions(reloaded);
  const snapshot = await reloaded.getWorkspaceSnapshot();

  assert.equal(snapshot.cwd, projectPath);
});
