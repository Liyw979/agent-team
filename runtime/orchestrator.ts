import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { resolveTaskSubmissionTarget } from "@shared/task-submission";
import { buildCliOpencodeAttachCommand } from "@shared/terminal-commands";
import {
  type AgentTeamEvent,
  type AgentRuntimeSnapshot,
  type AgentRecord,
  BUILD_AGENT_NAME,
  createDefaultTopology,
  normalizeNeedsRevisionMaxRounds,
  type DeleteTaskPayload,
  type GetTaskRuntimePayload,
  type InitializeTaskPayload,
  getWorkspaceNameFromPath,
  type MessageRecord,
  type OpenAgentTerminalPayload,
  resolveBuildAgentName,
  resolvePrimaryTopologyStartTarget,
  resolveTopologyAgentOrder,
  type SubmitTaskPayload,
  type TaskAgentRecord,
  type TaskRecord,
  type TaskSnapshot,
  type TopologyEdge,
  type TopologyRecord,
  type UpdateTopologyPayload,
  type WorkspaceSnapshot,
  isReviewAgentInTopology,
} from "@shared/types";
import {
  formatAgentDispatchContent,
  formatRevisionRequestContent,
} from "@shared/chat-message-format";
import {
  stripReviewResponseMarkup,
} from "@shared/review-response";
import { buildAgentSystemPrompt } from "./agent-system-prompt";
import {
  parseReview as parseReviewPure,
  stripStructuredSignals as stripStructuredSignalsPure,
  type ParsedReview,
} from "./review-parser";
import {
  OpenCodeClient,
  type OpenCodeRuntimeTarget,
  type OpenCodeShutdownReport,
} from "./opencode-client";
import { OpenCodeRunner } from "./opencode-runner";
import { StoreService } from "./store";
import {
  resolveAgentStatusFromReview,
} from "./gating-rules";
import {
  buildDownstreamForwardedContextFromMessages,
  buildUserHistoryContent as buildUserHistoryContentPure,
  contentContainsNormalized as contentContainsNormalizedPure,
  extractMention as extractMentionPure,
  getInitialUserMessageContent as getInitialUserMessageContentPure,
  stripTargetMention as stripTargetMentionPure,
} from "./message-forwarding";
import {
  resolveStandaloneTaskStatusAfterAgentRun,
  shouldFinishTaskFromPersistedState as shouldFinishTaskFromPersistedStatePure,
} from "./task-lifecycle-rules";
import { LangGraphRuntime } from "./langgraph-runtime";
import type { LangGraphTaskLoopHost } from "./langgraph-host";
import type { GraphDispatchBatch, GraphAgentResult } from "./gating-router";
import type { GraphTaskState } from "./gating-state";
import { buildTaskCompletionMessageContent } from "./task-completion-message";
import { getRuntimeNode, getRuntimeTemplateName } from "./runtime-topology-graph";
import type { CompiledTeamDsl } from "./team-dsl";
import { shouldScheduleEventStreamReconnect } from "./event-stream-lifecycle";
import {
  buildInjectedConfigFromAgents,
  extractDslAgentsFromTopology,
  resolveProjectAgents,
  validateProjectAgents,
} from "./project-agent-source";
import { launchTerminalCommand } from "./terminal-launcher";

const execFileAsync = promisify(execFile);

interface OrchestratorOptions {
  userDataPath: string;
  autoOpenTaskSession?: boolean;
  enableEventStream?: boolean;
  runtimeRefreshDebounceMs?: number;
  terminalLauncher?: (input: { cwd: string; command: string }) => Promise<void>;
}

interface DisposeOrchestratorOptions {
  awaitPendingTaskRuns?: boolean;
}

interface ParsedSignal {
  done: boolean;
}

interface GitSummaryCommandResult {
  stdout: string;
  unavailable: boolean;
}

interface WorkspaceRecord {
  cwd: string;
  name: string;
}

interface TaskRuntimeSeed {
  taskId: string;
  cwd: string;
  attachBaseUrl: string | null;
  agentSessions: Array<{
    agentName: string;
    sessionId: string;
  }>;
}

interface TaskRuntimeOverlay {
  taskId: string;
  cwd: string;
  runtimeTarget: OpenCodeRuntimeTarget;
  attachBaseUrl: string | null;
  agentSessions: Map<string, string>;
}

type AgentExecutionPrompt =
  | {
      mode: "raw";
      content: string;
      from?: string;
      allowDirectFallbackWhenNoBatch?: boolean;
    }
  | {
      mode: "structured";
      from: string;
      userMessage?: string;
      agentMessage?: string;
      gitDiffSummary?: string;
      allowDirectFallbackWhenNoBatch?: boolean;
    };

interface AgentRunBehaviorOptions {
  followTopology?: boolean;
  updateTaskStatusOnStart?: boolean;
  completeTaskOnFinish?: boolean;
}

function isTerminalTaskStatus(status: TaskRecord["status"]) {
  return status === "finished" || status === "failed";
}

export class Orchestrator {
  private readonly store: StoreService;
  private readonly opencodeClient: OpenCodeClient;
  private readonly opencodeRunner: OpenCodeRunner;
  private readonly events = new EventEmitter();
  private readonly langGraphRuntimes = new Map<string, LangGraphRuntime>();
  private readonly autoOpenTaskSession: boolean;
  private readonly enableEventStream: boolean;
  private readonly taskRuntimeOverlays = new Map<string, TaskRuntimeOverlay>();
  private readonly connectedRuntimeTaskIds = new Set<string>();
  private readonly pendingRuntimeRefreshWorkspaces = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingEventReconnects = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingTaskRuns = new Set<Promise<void>>();
  private readonly knownWorkspaces = new Set<string>();
  private readonly runtimeRefreshDebounceMs: number;
  private readonly terminalLauncher: (input: { cwd: string; command: string }) => Promise<void>;
  private isDisposing = false;

  constructor(options: OrchestratorOptions) {
    this.store = new StoreService(options.userDataPath);
    this.opencodeClient = new OpenCodeClient(options.userDataPath);
    this.opencodeRunner = new OpenCodeRunner(this.opencodeClient);
    this.autoOpenTaskSession = options.autoOpenTaskSession ?? false;
    this.enableEventStream = options.enableEventStream ?? true;
    this.runtimeRefreshDebounceMs = options.runtimeRefreshDebounceMs ?? 120;
    this.terminalLauncher = options.terminalLauncher ?? launchTerminalCommand;
  }

  async initialize() {
    const cwd = path.resolve(process.cwd());
    this.ensureWorkspaceRecord(cwd);
  }

  async dispose(options: DisposeOrchestratorOptions = {}): Promise<OpenCodeShutdownReport> {
    this.isDisposing = true;
    this.pendingRuntimeRefreshWorkspaces.forEach((timer) => clearTimeout(timer));
    this.pendingRuntimeRefreshWorkspaces.clear();
    this.pendingEventReconnects.forEach((timer) => clearTimeout(timer));
    this.pendingEventReconnects.clear();
    const awaitPendingTaskRuns = options.awaitPendingTaskRuns ?? true;
    if (awaitPendingTaskRuns && this.pendingTaskRuns.size > 0) {
      await Promise.allSettled([...this.pendingTaskRuns]);
    } else if (!awaitPendingTaskRuns) {
      this.pendingTaskRuns.clear();
    }
    this.langGraphRuntimes.clear();
    this.taskRuntimeOverlays.clear();
    this.connectedRuntimeTaskIds.clear();
    return this.opencodeClient.shutdown();
  }

  subscribe(listener: (event: AgentTeamEvent) => void): () => void {
    this.events.on("agent-team-event", listener);
    return () => {
      this.events.off("agent-team-event", listener);
    };
  }

  async getWorkspaceSnapshot(cwd: string): Promise<WorkspaceSnapshot> {
    const normalizedCwd = path.resolve(cwd);
    await this.reconcilePersistedWorkspaceTasks(normalizedCwd);
    return this.hydrateWorkspace(normalizedCwd);
  }

  async getTaskSnapshot(taskId: string, cwd = process.cwd()): Promise<TaskSnapshot> {
    const resolvedCwd = this.resolveTaskCwd(taskId, cwd);
    await this.reconcilePersistedTaskStatus(resolvedCwd, taskId);
    return this.hydrateTask(resolvedCwd, taskId);
  }

  exportTaskRuntime(taskId: string, cwd = process.cwd()): TaskRuntimeSeed | null {
    const resolvedCwd = this.resolveTaskCwd(taskId, cwd);
    const overlay = this.taskRuntimeOverlays.get(taskId);
    if (!overlay || overlay.cwd !== resolvedCwd) {
      return null;
    }

    return {
      taskId,
      cwd: overlay.cwd,
      attachBaseUrl: overlay.attachBaseUrl,
      agentSessions: [...overlay.agentSessions.entries()].map(([agentName, sessionId]) => ({
        agentName,
        sessionId,
      })),
    };
  }

  importTaskRuntime(seed: TaskRuntimeSeed) {
    const normalizedCwd = path.resolve(seed.cwd);
    const overlay = this.ensureTaskRuntimeOverlay({
      id: seed.taskId,
      cwd: normalizedCwd,
    });
    overlay.attachBaseUrl = seed.attachBaseUrl;
    overlay.agentSessions = new Map(
      seed.agentSessions.map((entry) => [entry.agentName, entry.sessionId]),
    );
    if (seed.attachBaseUrl) {
      this.opencodeClient.registerExternalServer(overlay.runtimeTarget, seed.attachBaseUrl);
    }
    this.setInjectedConfigForTask({
      id: seed.taskId,
      cwd: normalizedCwd,
    });
  }

  private ensureWorkspaceRecord(cwd: string): WorkspaceRecord {
    const normalizedCwd = path.resolve(cwd);
    this.knownWorkspaces.add(normalizedCwd);
    this.store.getTopology(normalizedCwd);
    return {
      cwd: normalizedCwd,
      name: getWorkspaceNameFromPath(normalizedCwd),
    };
  }

  private resolveTaskCwd(taskId: string, preferredCwd?: string): string {
    const indexedCwd = this.store.getTaskLocatorCwd(taskId);
    const candidates = [
      preferredCwd ? path.resolve(preferredCwd) : null,
      indexedCwd,
      ...this.knownWorkspaces,
    ].filter((value, index, list): value is string => Boolean(value) && list.indexOf(value) === index);

    for (const candidate of candidates) {
      const task = this.store.listTasks(candidate).find((item) => item.id === taskId);
      if (task) {
        return task.cwd;
      }
      if (candidate === indexedCwd) {
        this.store.removeTaskLocator(taskId);
      }
    }

    throw new Error(`Task ${taskId} not found`);
  }

  async readAgent(cwd: string, agentName: string): Promise<AgentRecord> {
    const matched = this.listWorkspaceAgents(cwd).find((agent) => agent.name === agentName);
    if (!matched) {
      throw new Error(`Agent 配置不存在：${agentName}`);
    }
    return matched;
  }

  private listWorkspaceAgents(cwd: string): AgentRecord[] {
    return resolveProjectAgents({
      dslAgents: extractDslAgentsFromTopology(this.store.getTopology(cwd)),
    });
  }

  async saveTopology(payload: UpdateTopologyPayload): Promise<WorkspaceSnapshot> {
    const normalizedCwd = path.resolve(payload.cwd);
    const agents = this.listWorkspaceAgents(normalizedCwd);
    const normalized = this.normalizeTopology(agents, payload.topology);
    this.store.upsertTopology(normalizedCwd, normalized);
    const updated = this.hydrateWorkspace(normalizedCwd);
    this.emit({
      type: "workspace-updated",
      cwd: normalizedCwd,
      payload: updated,
    });
    return updated;
  }

  async applyTeamDsl(payload: {
    cwd: string;
    compiled: CompiledTeamDsl;
  }): Promise<WorkspaceSnapshot> {
    const normalizedCwd = path.resolve(payload.cwd);
    const normalized = this.normalizeTopology(
      payload.compiled.agents.map((agent) => ({
        name: agent.name,
        prompt: agent.prompt ?? "",
        isWritable: agent.isWritable,
      })),
      payload.compiled.topology,
    );
    this.store.upsertTopology(normalizedCwd, normalized);
    for (const overlay of this.taskRuntimeOverlays.values()) {
      if (overlay.cwd === normalizedCwd) {
        this.setInjectedConfigForTask({
          id: overlay.taskId,
          cwd: overlay.cwd,
        });
      }
    }
    const updated = this.hydrateWorkspace(normalizedCwd);
    this.emit({
      type: "workspace-updated",
      cwd: normalizedCwd,
      payload: updated,
    });
    return updated;
  }

  async deleteTask(payload: DeleteTaskPayload): Promise<WorkspaceSnapshot> {
    const normalizedCwd = path.resolve(payload.cwd);
    const task = this.store.getTask(normalizedCwd, payload.taskId);
    await this.deleteTaskGraphRuntime(task);
    this.taskRuntimeOverlays.delete(task.id);
    this.connectedRuntimeTaskIds.delete(task.id);
    const reconnectTimer = this.pendingEventReconnects.get(task.id);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      this.pendingEventReconnects.delete(task.id);
    }
    this.store.deleteTask(normalizedCwd, task.id);
    const updated = this.hydrateWorkspace(normalizedCwd);
    this.emit({
      type: "workspace-updated",
      cwd: normalizedCwd,
      payload: updated,
    });
    return updated;
  }

  async submitTask(payload: SubmitTaskPayload): Promise<TaskSnapshot> {
    const normalizedCwd = path.resolve(payload.cwd ?? process.cwd());
    const agents = this.listWorkspaceAgents(normalizedCwd);
    validateProjectAgents(agents);
    this.syncTopology(normalizedCwd, agents);
    const topology = this.store.getTopology(normalizedCwd);
    const resolution = resolveTaskSubmissionTarget({
      content: payload.content,
      mentionAgent: payload.mentionAgent,
      availableAgents: agents.map((agent) => agent.name),
      defaultTargetAgent: resolvePrimaryTopologyStartTarget(topology) ?? undefined,
    });
    if (!resolution.ok) {
      throw new Error(resolution.message);
    }
    const mentionName = resolution.targetAgent;

    if (payload.taskId) {
      return this.continueTask(normalizedCwd, payload.taskId, payload.content, mentionName, agents);
    }

    const initialized = await this.createTask(normalizedCwd, agents, {
      title: this.createTaskTitle(payload.content),
      source: "submit",
    });

    return this.continueTask(
      normalizedCwd,
      initialized.task.id,
      payload.content,
      mentionName,
      agents,
    );
  }

  async initializeTask(payload: InitializeTaskPayload): Promise<TaskSnapshot> {
    const normalizedCwd = path.resolve(payload.cwd);
    const agents = this.listWorkspaceAgents(normalizedCwd);
    validateProjectAgents(agents);
    this.syncTopology(normalizedCwd, agents);

    return this.createTask(normalizedCwd, agents, {
      title: (payload.title ?? "").trim() || "未命名任务",
      source: "initialize",
    });
  }

  async openAgentTerminal(payload: OpenAgentTerminalPayload) {
    const normalizedCwd = path.resolve(payload.cwd);
    const task = this.store.getTask(normalizedCwd, payload.taskId);
    const snapshot = await this.ensureTaskInitialized(
      normalizedCwd,
      task,
      this.listWorkspaceAgents(normalizedCwd),
    );
    this.emit({
      type: "task-updated",
      cwd: normalizedCwd,
      payload: snapshot,
    });

    const taskAgent = snapshot.agents.find((item) => item.name === payload.agentName);
    if (!taskAgent) {
      throw new Error(`未找到 Agent ${payload.agentName} 对应的运行信息。`);
    }
    if (!taskAgent.opencodeSessionId) {
      throw new Error(`Agent ${payload.agentName} 当前还没有可 attach 的 OpenCode session。`);
    }
    await this.launchAgentTerminal(
      normalizedCwd,
      taskAgent.opencodeSessionId,
      taskAgent.opencodeAttachBaseUrl,
    );
  }

  async getTaskRuntime(payload: GetTaskRuntimePayload): Promise<AgentRuntimeSnapshot[]> {
    const normalizedCwd = path.resolve(payload.cwd);
    const task = this.store.getTask(normalizedCwd, payload.taskId);
    const overlayAgents = this.overlayTaskAgents(task, this.store.listTaskAgents(normalizedCwd, task.id));
    const runtimeTarget = this.getTaskRuntimeTarget(task);
    return Promise.all(
      overlayAgents.map(async (agent) => {
        const baseSnapshot: AgentRuntimeSnapshot = {
          taskId: task.id,
          agentId: agent.name,
          sessionId: agent.opencodeSessionId,
          status: agent.status,
          messageCount: 0,
          updatedAt: null,
          headline: null,
          activeToolNames: [],
          activities: [],
        };

        if (!agent.opencodeSessionId) {
          return baseSnapshot;
        }

        try {
          const runtime = await this.opencodeClient.getSessionRuntime(
            runtimeTarget,
            agent.opencodeSessionId,
          );
          return {
            ...baseSnapshot,
            messageCount: runtime.messageCount,
            updatedAt: runtime.updatedAt,
            headline: runtime.headline,
            activeToolNames: runtime.activeToolNames,
            activities: runtime.activities,
          };
        } catch {
          return {
            ...baseSnapshot,
            headline: agent.status === "running" ? "运行中，正在等待 OpenCode 返回实时消息" : null,
          };
        }
      }),
    );
  }

  private async createTask(
    cwd: string,
    agents: AgentRecord[],
    options: {
      title: string;
      source: "initialize" | "submit";
    },
  ): Promise<TaskSnapshot> {
    if (agents.length === 0) {
      throw new Error("当前工作区没有可用的 Agent");
    }

    const taskId = randomUUID();
    const normalizedCwd = path.resolve(cwd);

    const task: TaskRecord = {
      id: taskId,
      title: options.title,
      status: "pending",
      cwd: normalizedCwd,
      opencodeSessionId: null,
      agentCount: agents.length,
      createdAt: new Date().toISOString(),
      completedAt: null,
      initializedAt: null,
    };

    this.store.insertTask(task);
    for (const agent of agents) {
      this.store.insertTaskAgent(normalizedCwd, {
        id: randomUUID(),
        taskId,
        name: agent.name,
        opencodeSessionId: null,
        opencodeAttachBaseUrl: null,
        status: "idle",
        runCount: 0,
      });
    }

    await this.ensureTaskInitialized(normalizedCwd, task, agents);

    const taskCreatedMessage: MessageRecord = {
      id: randomUUID(),
      taskId,
      content:
        options.source === "initialize"
          ? "Task 已初始化"
          : "Task 已创建并完成初始化",
      sender: "system",
      timestamp: new Date().toISOString(),
      meta: {
        kind: "task-created",
      },
    };
    this.store.insertMessage(normalizedCwd, taskCreatedMessage);

    const snapshot = this.hydrateTask(normalizedCwd, taskId);
    this.emit({
      type: "task-created",
      cwd: normalizedCwd,
      payload: snapshot,
    });

    return snapshot;
  }

  private async continueTask(
    cwd: string,
    taskId: string,
    content: string,
    mentionAgent: string,
    agents: AgentRecord[],
  ): Promise<TaskSnapshot> {
    const normalizedCwd = path.resolve(cwd);
    const task = this.store.getTask(normalizedCwd, taskId);
    if (isTerminalTaskStatus(task.status)) {
      this.store.updateTaskStatus(normalizedCwd, task.id, "running", null);
    }

    this.syncTaskAgents(task, agents);
    const targetAgent = this.findAgent(agents, mentionAgent);

    if (!targetAgent) {
      throw new Error(`未找到被 @ 的 Agent：${mentionAgent}`);
    }

    await this.ensureTaskInitialized(normalizedCwd, task, agents);

    const message = this.createUserMessage(task.id, task.title, content, targetAgent.name);
    this.store.insertMessage(normalizedCwd, message);
    this.emit({
      type: "message-created",
      cwd: normalizedCwd,
      payload: message,
    });

    const forwardedContent = stripTargetMentionPure(content, targetAgent.name);
    const topology = this.store.getTopology(normalizedCwd);
    const runtime = this.getLangGraphRuntime(normalizedCwd);
    this.trackBackgroundTask(runtime.resumeTask({
      taskId: task.id,
      workspaceCwd: normalizedCwd,
      topology,
      event: {
        type: "user_message",
        targetAgentName: targetAgent.name,
        content: forwardedContent,
      },
    }), {
      taskId: task.id,
      agentName: targetAgent.name,
    });
    return this.hydrateTask(normalizedCwd, task.id);
  }

  private trackBackgroundTask(
    promise: Promise<unknown>,
    context: {
      taskId: string;
      agentName: string;
    },
  ) {
    const tracked = promise
      .catch((error) => {
        console.error("[orchestrator] 后台发送任务失败", {
          taskId: context.taskId,
          agentName: context.agentName,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.pendingTaskRuns.delete(tracked);
      });
    this.pendingTaskRuns.add(tracked);
  }

  private createUserMessage(
    taskId: string,
    taskTitle: string,
    content: string,
    targetAgentId: string,
  ): MessageRecord {
    const normalizedContent = buildUserHistoryContentPure(content, targetAgentId);
    return {
      id: randomUUID(),
      taskId,
      content: normalizedContent,
      sender: "user",
      timestamp: new Date().toISOString(),
      meta: {
        scope: "task",
        taskTitle,
        targetAgentId,
      },
    };
  }

  private syncTaskAgents(task: TaskRecord, agents: AgentRecord[]) {
    const orderedAgents = this.orderAgents(task.cwd, agents);
    const existingByName = new Set(this.store.listTaskAgents(task.cwd, task.id).map((item) => item.name));
    for (const agent of orderedAgents) {
      if (existingByName.has(agent.name)) {
        continue;
      }
      this.store.insertTaskAgent(task.cwd, {
        id: randomUUID(),
        taskId: task.id,
        name: agent.name,
        opencodeSessionId: null,
        opencodeAttachBaseUrl: null,
        status: "idle",
        runCount: 0,
      });
    }

    this.store.updateTaskAgentCount(task.cwd, task.id, agents.length);
  }

  private ensureRuntimeTaskAgent(
    task: TaskRecord,
    runtimeAgentName: string,
  ): void {
    const existing = this.store.listTaskAgents(task.cwd, task.id).find((item) => item.name === runtimeAgentName);
    if (existing) {
      return;
    }
    this.store.insertTaskAgent(task.cwd, {
      id: randomUUID(),
      taskId: task.id,
      name: runtimeAgentName,
      opencodeSessionId: null,
      opencodeAttachBaseUrl: null,
      status: "idle",
      runCount: 0,
    });
    this.store.updateTaskAgentCount(task.cwd, task.id, this.store.listTaskAgents(task.cwd, task.id).length);
  }

  private async runAgent(
    cwd: string,
    task: TaskRecord,
    agentName: string,
    prompt: AgentExecutionPrompt,
    behavior: AgentRunBehaviorOptions = {},
  ) {
    if (behavior.followTopology) {
      throw new Error("runAgent 已不再负责拓扑调度；请通过 submitTask/continueTask 走 LangGraph runtime。");
    }

    const result = await this.executeLangGraphAgentOnce(
      cwd,
      task,
      null,
      agentName,
      agentName,
      prompt,
      1,
    );
    if (!(behavior.completeTaskOnFinish ?? true)) {
      return;
    }

    const latestTask = this.store.getTask(task.cwd, task.id);
    if (isTerminalTaskStatus(latestTask.status)) {
      if (latestTask.status === "failed" && latestTask.completedAt === null) {
        await this.completeTask(task.cwd, task.id, "failed");
      }
      return;
    }

    if (latestTask.status === "needs_revision") {
      return;
    }

    const nextTaskStatus = resolveStandaloneTaskStatusAfterAgentRun({
      latestAgentStatus: result.agentStatus,
      agentStatuses: this.store.listTaskAgents(task.cwd, task.id),
    });

    if (nextTaskStatus === "finished") {
      await this.completeTask(task.cwd, task.id, "finished");
      return;
    }

    if (nextTaskStatus === "failed") {
      await this.completeTask(task.cwd, task.id, "failed");
      return;
    }

    this.moveTaskToWaiting(task.cwd, task.id, agentName);
  }

  private shouldSuppressDuplicateDispatchMessage(
    cwd: string,
    taskId: string,
    sourceAgentId: string,
    targetAgentIds: string[],
  ): boolean {
    const now = Date.now();
    const incomingTargets = [...targetAgentIds].sort().join(",");
    const messages = this.store.listMessages(cwd, taskId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const timestamp = Date.parse(message.timestamp);
      if (!Number.isFinite(timestamp)) {
        continue;
      }
      if (now - timestamp > 1500) {
        break;
      }
      if (message.sender === sourceAgentId && message.meta?.kind === "agent-final") {
        return false;
      }
      if (message.sender !== sourceAgentId || message.meta?.kind !== "agent-dispatch") {
        continue;
      }

      const historicalTargets = (message.meta.targetAgentIds ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .sort()
        .join(",");
      if (historicalTargets === incomingTargets) {
        return true;
      }
    }
    return false;
  }

  private shouldAttachGitDiffSummary(
    topology: TopologyRecord,
    targetAgentName: string,
  ): boolean {
    return targetAgentName !== BUILD_AGENT_NAME && !this.isReviewAgent({ name: targetAgentName }, topology);
  }

  private updateTaskStatusIfActive(
    cwd: string,
    taskId: string,
    status: TaskRecord["status"],
    completedAt: string | null = null,
  ): boolean {
    const task = this.store.getTask(cwd, taskId);
    if (isTerminalTaskStatus(task.status)) {
      return false;
    }
    this.store.updateTaskStatus(cwd, taskId, status, completedAt);
    return true;
  }

  private async reconcilePersistedTaskStatus(cwd: string, taskId: string) {
    const task = this.store.getTask(cwd, taskId);
    if (!shouldFinishTaskFromPersistedStatePure({
      taskStatus: task.status,
      topology: this.store.getTopology(task.cwd),
      agents: this.store.listTaskAgents(task.cwd, taskId),
      messages: this.store.listMessages(task.cwd, taskId),
    })) {
      return;
    }

    await this.completeTask(task.cwd, taskId, "finished");
  }

  private async reconcilePersistedWorkspaceTasks(cwd: string) {
    for (const task of this.store.listTasks(cwd)) {
      await this.reconcilePersistedTaskStatus(cwd, task.id);
    }
  }

  private parseSignal(content: string): ParsedSignal {
    return {
      done: /\bTASK_DONE\b/i.test(content),
    };
  }

  private parseReview(content: string, reviewAgent: boolean): ParsedReview {
    return parseReviewPure(content, reviewAgent);
  }

  private stripStructuredSignals(content: string): string {
    return stripStructuredSignalsPure(content);
  }

  private async buildProjectGitDiffSummary(cwd: string): Promise<string> {
    try {
      const [statusResult, stagedStatResult, unstagedStatResult] = await Promise.all([
        this.runGitSummaryCommand(cwd, ["status", "--short", "--untracked-files=all"]),
        this.runGitSummaryCommand(cwd, ["diff", "--cached", "--stat", "--compact-summary"]),
        this.runGitSummaryCommand(cwd, ["diff", "--stat", "--compact-summary"]),
      ]);

      if (statusResult.unavailable || stagedStatResult.unavailable || unstagedStatResult.unavailable) {
        return "";
      }

      const sections: string[] = [];
      const statusLines = this.limitGitSummaryLines(
        statusResult.stdout
          .split("\n")
          .map((line) => line.trimEnd())
          .filter(Boolean),
        10,
      );
      if (statusLines.length > 0) {
        sections.push(`工作区状态：\n${statusLines.join("\n")}`);
      }

      const stagedLines = this.limitGitSummaryLines(
        stagedStatResult.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        8,
      );
      if (stagedLines.length > 0) {
        sections.push(`已暂存变更统计：\n${stagedLines.join("\n")}`);
      }

      const unstagedLines = this.limitGitSummaryLines(
        unstagedStatResult.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        8,
      );
      if (unstagedLines.length > 0) {
        sections.push(`未暂存变更统计：\n${unstagedLines.join("\n")}`);
      }

      if (sections.length === 0) {
        return "当前项目 Git 工作区干净，没有未提交变更。";
      }

      return `当前项目 Git Diff 精简摘要：\n${sections.join("\n\n")}`.trim();
    } catch {
      return "";
    }
  }

  private async runGitSummaryCommand(cwd: string, args: string[]): Promise<GitSummaryCommandResult> {
    try {
      const result = await execFileAsync("git", ["-C", cwd, ...args], {
        timeout: 2500,
      });
      return {
        stdout: result.stdout,
        unavailable: false,
      };
    } catch (error) {
      if (this.isGitSummaryUnavailableError(error)) {
        return {
          stdout: "",
          unavailable: true,
        };
      }
      return {
        stdout: "",
        unavailable: false,
      };
    }
  }

  private isGitSummaryUnavailableError(error: unknown): boolean {
    const errnoError = error as NodeJS.ErrnoException | undefined;
    if (errnoError?.code === "ENOENT") {
      return true;
    }

    const stderr = typeof (error as { stderr?: unknown } | undefined)?.stderr === "string"
      ? (error as { stderr: string }).stderr
      : "";
    if (!stderr) {
      return false;
    }

    return [
      /not a git repository/i,
      /cannot change to ['"].*['"]/i,
      /不是 git 仓库/i,
      /无法切换到 ['"].*['"]/i,
      /不是一个 git 仓库/i,
    ].some((pattern) => pattern.test(stderr));
  }

  private limitGitSummaryLines(lines: string[], maxLines: number): string[] {
    if (lines.length <= maxLines) {
      return lines;
    }
    return [...lines.slice(0, maxLines), `... 共 ${lines.length} 行，仅展示前 ${maxLines} 行`];
  }

  private buildAgentExecutionPrompt(prompt: AgentExecutionPrompt): string {
    if (prompt.mode === "raw") {
      const content = prompt.content.trim();
      const from = this.getAgentDisplayName(prompt.from?.trim() || "System");
      return `[${from}] ${content || "（无）"}`.trim();
    }

    const sections: string[] = [];
    if (prompt.userMessage?.trim()) {
      sections.push(`[Initial Task]\n${prompt.userMessage.trim()}`);
    }
    if (prompt.agentMessage?.trim()) {
      sections.push(`${this.buildSourceAgentMessageSection(prompt.from)}\n${prompt.agentMessage.trim()}`);
    }
    if (sections.length === 0) {
      sections.push("[Initial Task]\n（无）");
    }
    if (prompt.gitDiffSummary?.trim()) {
      sections.push(`[Project Git Diff Summary]\n${prompt.gitDiffSummary.trim()}`);
    }
    return sections
      .join("\n\n")
      .trim();
  }

  private buildSourceAgentMessageSection(sourceAgentName: string): string {
    const displayName = this.getAgentDisplayName(sourceAgentName.trim() || "来源 Agent");
    return `[From ${displayName} Agent]`;
  }

  private resolveAgentContextContent(
    parsedReview: ParsedReview,
    rawFinalMessage: string,
    fallbackMessage?: string | null,
  ): string {
    const candidates = [
      parsedReview.cleanContent.trim(),
      this.stripStructuredSignals(rawFinalMessage).trim(),
      fallbackMessage?.trim() ?? "",
    ];

    return candidates.find((item) => item.length > 0) ?? "";
  }

  private buildDispatchMessageContent(targetAgentIds: string[], content: string): string {
    return formatAgentDispatchContent(content, targetAgentIds);
  }

  private extractAgentDisplayContent(content: string): string {
    const trimmed = content.trim();
    if (!trimmed) {
      return "";
    }

    const trailingSection = this.extractTrailingTopLevelSection(trimmed);
    return trailingSection
      .replace(/\n(?:---|\*\*\*)(?:\s*\n?)*$/u, "")
      .trim();
  }

  private extractTrailingTopLevelSection(content: string): string {
    const headingPattern = /(^|\n)(#{1,2}\s+[^\n]+)\n/g;
    let lastHeadingIndex = -1;
    let match: RegExpExecArray | null = headingPattern.exec(content);
    while (match) {
      lastHeadingIndex = match.index + match[1].length;
      match = headingPattern.exec(content);
    }

    if (lastHeadingIndex < 0) {
      return content;
    }

    const trailingSection = content.slice(lastHeadingIndex).trim();
    return trailingSection || content;
  }

  private createDisplayContent(parsedReview: ParsedReview, fallbackMessage?: string | null): string {
    const cleanContent = this.extractAgentDisplayContent(parsedReview.cleanContent);
    if (parsedReview.decision === "invalid" && parsedReview.validationError) {
      return [cleanContent, parsedReview.validationError].filter(Boolean).join("\n\n");
    }
    if (cleanContent) {
      return cleanContent;
    }

    const fallbackContent = this.extractAgentDisplayContent(fallbackMessage?.trim() ?? "");
    if (parsedReview.decision === "invalid" && parsedReview.validationError) {
      return [fallbackContent, parsedReview.validationError].filter(Boolean).join("\n\n");
    }
    if (fallbackContent) {
      return fallbackContent;
    }

    const opinion = parsedReview.opinion?.trim();
    if (opinion) {
      return opinion;
    }

    if (parsedReview.decision === "needs_revision") {
      return "（该 Agent 已给出需要响应的结论，但未返回可展示的结果正文。）";
    }
    if (parsedReview.decision === "invalid") {
      return parsedReview.validationError ?? "（该 Agent 返回了无效的审查结果。）";
    }
    if (parsedReview.decision === "approved") {
      return "通过";
    }
    return "（该 Agent 未返回可展示的结果正文。）";
  }

  private getTaskRuntimeTarget(task: Pick<TaskRecord, "id" | "cwd">): OpenCodeRuntimeTarget {
    return {
      runtimeKey: task.id,
      projectPath: task.cwd,
    };
  }

  private ensureTaskRuntimeOverlay(task: Pick<TaskRecord, "id" | "cwd">): TaskRuntimeOverlay {
    const existing = this.taskRuntimeOverlays.get(task.id);
    if (existing) {
      existing.cwd = task.cwd;
      return existing;
    }

    const created: TaskRuntimeOverlay = {
      taskId: task.id,
      cwd: task.cwd,
      runtimeTarget: this.getTaskRuntimeTarget(task),
      attachBaseUrl: null,
      agentSessions: new Map(),
    };
    this.taskRuntimeOverlays.set(task.id, created);
    return created;
  }

  private overlayTaskAgents(task: TaskRecord, agents: TaskAgentRecord[]): TaskAgentRecord[] {
    const overlay = this.taskRuntimeOverlays.get(task.id);
    return agents.map((agent) => ({
      ...agent,
      opencodeSessionId: overlay?.agentSessions.get(agent.name) ?? null,
      opencodeAttachBaseUrl: overlay?.attachBaseUrl ?? null,
    }));
  }

  private async ensureAgentSession(
    cwd: string,
    task: TaskRecord,
    agent: TaskAgentRecord,
  ): Promise<string> {
    const overlay = this.ensureTaskRuntimeOverlay(task);
    const existingSessionId = overlay.agentSessions.get(agent.name) ?? null;
    if (existingSessionId) {
      return existingSessionId;
    }

    this.setInjectedConfigForTask(task);
    const sessionId = await this.opencodeClient.createSession(
      overlay.runtimeTarget,
      `${task.title}:${agent.name}`,
    );
    overlay.agentSessions.set(agent.name, sessionId);
    if (!overlay.attachBaseUrl) {
      overlay.attachBaseUrl = await this.opencodeClient.getAttachBaseUrl(overlay.runtimeTarget).catch(() => null);
    }
    return sessionId;
  }

  private async ensureTaskPanels(task: TaskRecord) {
    await this.ensureTaskInitialized(task.cwd, task, this.listWorkspaceAgents(task.cwd));
  }

  private async ensureTaskAgentSessions(cwd: string, task: TaskRecord): Promise<Map<string, string>> {
    const sessions = await Promise.all(
      this.store.listTaskAgents(task.cwd, task.id).map(async (agent) => [
        agent.name,
        await this.ensureAgentSession(cwd, task, agent),
      ] as const),
    );
    return new Map(sessions);
  }

  private async ensureTaskInitialized(
    cwd: string,
    task: TaskRecord,
    agents: AgentRecord[],
  ): Promise<TaskSnapshot> {
    this.syncTaskAgents(task, agents);
    const currentTask = this.store.getTask(task.cwd, task.id);
    await this.ensureTaskAgentSessions(cwd, currentTask);
    await this.ensureTaskRuntimeEventStream(currentTask);

    const refreshedTask = this.store.getTask(task.cwd, task.id);
    if (!refreshedTask.initializedAt) {
      this.store.updateTaskInitialized(task.cwd, task.id, new Date().toISOString());
    }

    return this.hydrateTask(task.cwd, task.id);
  }

  private getOrderedAgentNames(
    cwd: string,
    agents: Array<Pick<AgentRecord, "name">>,
    topologyOverride?: TopologyRecord,
  ): string[] {
    const topology = topologyOverride ?? this.store.getTopology(cwd);
    return resolveTopologyAgentOrder(agents, topology.nodes);
  }

  private orderAgents(
    cwd: string,
    agents: AgentRecord[],
    topologyOverride?: TopologyRecord,
  ): AgentRecord[] {
    const orderedNames = this.getOrderedAgentNames(cwd, agents, topologyOverride);
    const agentByName = new Map(agents.map((agent) => [agent.name, agent]));
    return orderedNames.map((name) => agentByName.get(name)).filter((agent): agent is AgentRecord => Boolean(agent));
  }

  private orderTaskAgents(
    cwd: string,
    agents: TaskAgentRecord[],
    topologyOverride?: TopologyRecord,
  ): TaskAgentRecord[] {
    const orderedNames = this.getOrderedAgentNames(
      cwd,
      this.listWorkspaceAgents(cwd),
      topologyOverride,
    );
    const agentByName = new Map(agents.map((agent) => [agent.name, agent]));
    return orderedNames.map((name) => agentByName.get(name)).filter((agent): agent is TaskAgentRecord => Boolean(agent));
  }

  private async launchAgentTerminal(
    projectPath: string,
    opencodeSessionId: string,
    sessionAttachBaseUrl: string | null,
  ) {
    if (!sessionAttachBaseUrl) {
      throw new Error("当前 Agent 还没有可 attach 的 OpenCode 地址。");
    }
    const attachCommand = buildCliOpencodeAttachCommand(
      sessionAttachBaseUrl,
      opencodeSessionId,
    );
    await this.terminalLauncher({
      cwd: projectPath,
      command: attachCommand,
    });
  }

  private isReviewAgent(
    agent: Pick<AgentRecord, "name">,
    topology: Pick<TopologyRecord, "edges">,
  ): boolean {
    return isReviewAgentInTopology(topology, agent.name);
  }

  private createSystemPrompt(
    agent: AgentRecord,
    topology: Pick<TopologyRecord, "edges">,
    prompt: AgentExecutionPrompt,
  ): string {
    const reviewAgent = this.isReviewAgent(agent, topology);
    if (!reviewAgent) {
      return "";
    }

    const sourceSectionLabel = prompt.mode === "structured"
      ? this.buildSourceAgentMessageSection(prompt.from)
      : undefined;

    return buildAgentSystemPrompt(agent, reviewAgent, sourceSectionLabel);
  }

  private createTaskTitle(content: string): string {
    const firstLine = content
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find(Boolean);
    return (firstLine ?? "未命名任务").slice(0, 80);
  }

  private setInjectedConfigForTask(task: Pick<TaskRecord, "id" | "cwd">) {
    this.opencodeClient.setInjectedConfigContent(
      this.getTaskRuntimeTarget(task),
      buildInjectedConfigFromAgents(this.listWorkspaceAgents(task.cwd)),
    );
  }

  private findAgent(agents: AgentRecord[], name: string | undefined): AgentRecord | undefined {
    if (!name) {
      return undefined;
    }
    return agents.find((agent) => agent.name === name);
  }

  private resolveExecutableAgentName(
    cwd: string,
    state: GraphTaskState | null,
    runtimeAgentName: string,
  ): string {
    const workspaceAgents = this.listWorkspaceAgents(cwd);
    if (workspaceAgents.some((agent) => agent.name === runtimeAgentName)) {
      return runtimeAgentName;
    }

    const templateName = state ? getRuntimeTemplateName(state, runtimeAgentName) : null;
    if (templateName && workspaceAgents.some((agent) => agent.name === templateName)) {
      return templateName;
    }

    return runtimeAgentName;
  }

  private resolveMessageSenderDisplayName(
    state: GraphTaskState | null,
    runtimeAgentName: string,
  ): string {
    if (!state) {
      return runtimeAgentName;
    }
    return state.runtimeNodes.find((node) => node.id === runtimeAgentName)?.displayName ?? runtimeAgentName;
  }

  private hydrateWorkspace(cwd: string, forceSyncTopology = false): WorkspaceSnapshot {
    const normalizedCwd = path.resolve(cwd);
    const workspace = this.ensureWorkspaceRecord(normalizedCwd);
    const agents = this.listWorkspaceAgents(normalizedCwd);
    const topology = forceSyncTopology
      ? this.syncTopology(normalizedCwd, agents)
      : this.ensureTopologyExists(normalizedCwd, agents);
    const tasks = this.store.listTasks(normalizedCwd);
    for (const task of tasks) {
      this.syncTaskAgents(task, agents);
    }

    return {
      cwd: workspace.cwd,
      name: workspace.name,
      agents,
      topology,
      messages: this.store.listMessages(normalizedCwd),
      tasks: tasks.map((task) => this.hydrateTask(normalizedCwd, task.id)),
    };
  }

  private hydrateTask(cwd: string, taskId: string): TaskSnapshot {
    const task = this.store.getTask(cwd, taskId);
    const agents = this.listWorkspaceAgents(task.cwd);
    this.syncTaskAgents(task, agents);
    const persistedAgents = this.store.listTaskAgents(task.cwd, taskId);
    return {
      task: this.store.getTask(task.cwd, taskId),
      agents: this.overlayTaskAgents(task, persistedAgents),
      messages: this.store.listMessages(task.cwd, taskId),
      topology: this.store.getTopology(task.cwd),
    };
  }

  private ensureTopologyExists(cwd: string, agents: AgentRecord[]): TopologyRecord {
    const current = this.store.getTopology(cwd);
    if (current.nodes.length === 0 && current.edges.length === 0) {
      return createDefaultTopology(agents);
    }
    return this.normalizeTopology(agents, current);
  }

  private syncTopology(cwd: string, agents: AgentRecord[]): TopologyRecord {
    const current = this.store.getTopology(cwd);
    const next =
      current.nodes.length === 0 && current.edges.length === 0
        ? createDefaultTopology(agents)
        : this.normalizeTopology(agents, current);

    this.store.upsertTopology(cwd, next);
    return next;
  }

  private normalizeTopology(
    agents: AgentRecord[],
    topology: TopologyRecord,
  ): TopologyRecord {
    const validNames = new Set(agents.map((item) => item.name));
    const agentByName = new Map(agents.map((agent) => [agent.name, agent]));
    const seenEdges = new Set<string>();
    const seenPairs = new Set<string>();
    const edges = topology.edges
      .filter(
        (edge) =>
          edge.triggerOn === "association" ||
          edge.triggerOn === "approved" ||
          edge.triggerOn === "needs_revision",
      )
      .filter((edge) => validNames.has(edge.source) && validNames.has(edge.target))
      .filter((edge) => {
        const key = `${edge.source}__${edge.target}__${edge.triggerOn}`;
        if (seenEdges.has(key)) {
          return false;
        }
        seenEdges.add(key);
        return true;
      })
      .filter((edge) => {
        const pairKey = `${edge.source}__${edge.target}`;
        if (seenPairs.has(pairKey)) {
          return false;
        }
        seenPairs.add(pairKey);
        return true;
      })
      .map((edge) => ({
        source: edge.source,
        target: edge.target,
        triggerOn: edge.triggerOn,
        ...(edge.triggerOn === "needs_revision"
          ? {
              maxRevisionRounds: normalizeNeedsRevisionMaxRounds(edge.maxRevisionRounds),
            }
          : {}),
      }));
    const nodes = resolveTopologyAgentOrder(
      agents.map((agent) => ({ name: agent.name })),
      topology.nodes.filter((item) => validNames.has(item)),
    );
    const rawNodeRecords = topology.nodeRecords
      ? topology.nodeRecords
      : nodes.map((name) => ({
          id: name,
          kind: "agent" as const,
          templateName: name,
        }));
    const nodeRecords = rawNodeRecords.filter(
      (node) =>
        node.id
        && node.templateName
        && (node.kind === "spawn" || validNames.has(node.templateName)),
    ).map((node) => ({
      id: node.id,
      kind: node.kind,
      templateName: node.templateName,
      spawnRuleId: node.spawnRuleId,
      spawnEnabled: node.spawnEnabled === true,
      prompt: node.kind === "agent"
        ? (agentByName.get(node.templateName)?.prompt || undefined)
        : (typeof node.prompt === "string" ? node.prompt : undefined),
      writable: node.kind === "agent"
        ? agentByName.get(node.templateName)?.isWritable === true
        : node.writable === true,
    }));
    const spawnRules = topology.spawnRules?.filter(
      (rule) =>
        rule.id
        && rule.name
        && rule.sourceTemplateName
        && rule.itemKey
        && rule.entryRole
        && rule.reportToTemplateName
        && validNames.has(rule.sourceTemplateName)
        && validNames.has(rule.reportToTemplateName)
        && rule.spawnedAgents.every((agent) => agent.role && validNames.has(agent.templateName)),
    ).map((rule) => ({
      ...rule,
      spawnedAgents: rule.spawnedAgents.map((agent) => ({ ...agent })),
      edges: rule.edges.map((edge) => ({ ...edge })),
    }));

    return {
      nodes,
      edges,
      nodeRecords,
      spawnRules,
    };
  }

  private getLangGraphRuntime(cwd: string): LangGraphRuntime {
    let runtime = this.langGraphRuntimes.get(cwd);
    if (runtime) {
      return runtime;
    }

    const host: LangGraphTaskLoopHost = {
      createBatchRunners: async ({ taskId, state, batch }) =>
        this.createLangGraphBatchRunners(cwd, taskId, state, batch),
      moveTaskToWaiting: async ({ taskId, state }) =>
        this.moveTaskToWaiting(
          cwd,
          taskId,
          this.resolveWaitingSourceAgentId(taskId, state),
        ),
      completeTask: async ({ taskId, status, failureReason }) =>
        this.completeTask(cwd, taskId, status, failureReason),
    };
    runtime = new LangGraphRuntime({
      checkpointDir: path.join(cwd, ".agent-team", "langgraph"),
      host,
    });
    this.langGraphRuntimes.set(cwd, runtime);
    return runtime;
  }

  private async deleteTaskGraphRuntime(task: Pick<TaskRecord, "id" | "cwd">) {
    await this.getLangGraphRuntime(task.cwd).deleteTask(task.id);
  }

  private resolveWaitingSourceAgentId(taskId: string, state: GraphTaskState): string {
    const latestAgentMessage = [...this.store.listMessages(state.workspaceCwd, taskId)]
      .reverse()
      .find((message) => message.meta?.kind === "agent-final");
    return latestAgentMessage?.sender ?? state.topology.nodes[0] ?? "Orchestrator";
  }

  private consumeInitialTaskForwardingAllowanceFromGraphState(state: GraphTaskState): boolean {
    if (state.hasForwardedInitialTask) {
      return false;
    }
    state.hasForwardedInitialTask = true;
    return true;
  }

  private async createLangGraphBatchRunners(
    cwd: string,
    taskId: string,
    state: GraphTaskState,
    batch: GraphDispatchBatch,
  ) {
    const task = this.store.getTask(cwd, taskId);
    const topology = this.store.getTopology(cwd);
    const batchSize = batch.jobs.length;

    if (batch.jobs.every((job) => job.kind === "association" || job.kind === "approved")) {
      const sourceAgentId = batch.sourceAgentId ?? "System";
      if (!this.shouldSuppressDuplicateDispatchMessage(cwd, taskId, sourceAgentId, batch.triggerTargets)) {
        const triggerMessage: MessageRecord = {
          id: randomUUID(),
          taskId,
          sender: sourceAgentId,
          timestamp: new Date().toISOString(),
          content: this.buildDispatchMessageContent(
            batch.triggerTargets,
            batch.sourceContent ?? "",
          ),
          meta: {
            kind: "agent-dispatch",
            sourceAgentId,
            targetAgentIds: batch.triggerTargets.join(","),
            senderDisplayName: this.resolveMessageSenderDisplayName(state, sourceAgentId),
          },
        };
        this.store.insertMessage(cwd, triggerMessage);
        this.emit({
          type: "message-created",
          cwd,
          payload: triggerMessage,
        });
      }
    }

    const gitDiffSummary = await this.buildProjectGitDiffSummary(task.cwd);
    const shouldForwardInitialTask = batch.jobs.some((job) => job.kind !== "raw");
    const includeInitialTask = shouldForwardInitialTask
      ? this.consumeInitialTaskForwardingAllowanceFromGraphState(state)
      : false;
    const forwardedContext = batch.sourceAgentId
      ? buildDownstreamForwardedContextFromMessages(
        this.store.listMessages(task.cwd, taskId),
        batch.sourceContent ?? "",
        includeInitialTask,
      )
      : null;
    const initialUserContent = includeInitialTask
      ? getInitialUserMessageContentPure(this.store.listMessages(task.cwd, taskId))
      : "";

    return batch.jobs.map((job, index) => {
      this.ensureRuntimeTaskAgent(task, job.agentName);
      const executableAgentName = this.resolveExecutableAgentName(cwd, state, job.agentName);
      let prompt: AgentExecutionPrompt;
      if (job.kind === "raw") {
        prompt = {
          mode: "raw",
          from: "User",
          content: batch.sourceContent ?? "",
          allowDirectFallbackWhenNoBatch:
            this.getOutgoingEdges(topology, job.agentName, "needs_revision").length > 0,
        };
      } else if (job.kind === "revision_request") {
        const revisionContent =
          batch.sourceContent?.trim()
          || "请直接回应当前内容，给出你的判断、补充、澄清、反驳或修改方案。";
        prompt = {
          mode: "structured",
          from: batch.sourceAgentId ?? "Reviewer",
          userMessage:
            initialUserContent
            && !contentContainsNormalizedPure(revisionContent, initialUserContent)
              ? initialUserContent
              : undefined,
          agentMessage: revisionContent,
          gitDiffSummary: this.shouldAttachGitDiffSummary(topology, executableAgentName) ? gitDiffSummary : undefined,
          allowDirectFallbackWhenNoBatch: true,
        };
        const remediationMessage: MessageRecord = {
          id: randomUUID(),
          taskId,
          sender: batch.sourceAgentId ?? "Reviewer",
          timestamp: new Date().toISOString(),
          content: formatRevisionRequestContent(
            revisionContent,
            job.agentName,
          ),
          meta: {
            kind: "revision-request",
            sourceAgentId: batch.sourceAgentId ?? "Reviewer",
            targetAgentId: job.agentName,
            senderDisplayName:
            batch.sourceAgentId
                ? this.resolveMessageSenderDisplayName(state, batch.sourceAgentId)
                : "Reviewer",
          },
        };
        this.store.insertMessage(cwd, remediationMessage);
        this.emit({
          type: "message-created",
          cwd,
          payload: remediationMessage,
        });
      } else {
        prompt = {
          mode: "structured",
          from: batch.sourceAgentId ?? "System",
          userMessage: forwardedContext?.userMessage,
          agentMessage: forwardedContext?.agentMessage,
          gitDiffSummary: this.shouldAttachGitDiffSummary(topology, executableAgentName) ? gitDiffSummary : undefined,
        };
      }

      return {
        id: `${batch.sourceAgentId ?? "user"}:${job.agentName}:${index}:${Date.now()}`,
        agentName: job.agentName,
        promise: this.executeLangGraphAgentOnce(
          cwd,
          task,
          state,
          job.agentName,
          executableAgentName,
          prompt,
          batchSize,
        ),
      };
    });
  }

  private async executeLangGraphAgentOnce(
    cwd: string,
    task: TaskRecord,
    state: GraphTaskState | null,
    runtimeAgentName: string,
    executableAgentName: string,
    prompt: AgentExecutionPrompt,
    concurrentBatchSize: number,
  ): Promise<GraphAgentResult> {
    this.setInjectedConfigForTask(task);
    this.store.updateTaskAgentRun(task.cwd, task.id, runtimeAgentName, "running");
    this.updateTaskStatusIfActive(task.cwd, task.id, "running", null);
    const currentAgent = this.store.listTaskAgents(task.cwd, task.id).find((item) => item.name === runtimeAgentName);
    if (!currentAgent) {
      return {
        agentName: runtimeAgentName,
        status: "failed",
        reviewAgent: false,
        reviewDecision: "invalid",
        agentStatus: "failed",
        agentContextContent: "",
        opinion: null,
        allowDirectFallbackWhenNoBatch: false,
        signalDone: false,
        errorMessage: `Task ${task.id} 缺少 Agent ${runtimeAgentName}`,
      };
    }

    try {
      const currentTask = this.store.getTask(task.cwd, task.id);
      await this.ensureTaskPanels(currentTask);
      const agentSessionId = await this.ensureAgentSession(cwd, currentTask, currentAgent);
      const latestAgent = this.findAgent(this.listWorkspaceAgents(cwd), executableAgentName);
      if (!latestAgent) {
        throw new Error(`当前工作区缺少 Agent ${executableAgentName}`);
      }

      this.emit({
        type: "agent-status-changed",
        cwd,
        payload: {
          taskId: task.id,
          agentId: runtimeAgentName,
          status: "running",
          runCount: currentAgent.runCount,
        },
      });
      this.emit({
        type: "task-updated",
        cwd,
        payload: this.hydrateTask(task.cwd, task.id),
      });

      const topology = this.store.getTopology(cwd);
      const dispatchedContent = this.buildAgentExecutionPrompt(prompt);
      const response = await this.opencodeRunner.run({
        runtimeTarget: this.getTaskRuntimeTarget(currentTask),
        sessionId: agentSessionId,
        content: dispatchedContent,
        agent: executableAgentName,
        system: this.createSystemPrompt(latestAgent, topology, prompt),
      });

      if (response.status === "error") {
        throw new Error(
          response.rawMessage.error || response.finalMessage || `${runtimeAgentName} 返回错误状态`,
        );
      }

      const reviewAgent = this.isReviewAgent(latestAgent, topology);
      const parsedReview = this.parseReview(response.finalMessage, reviewAgent);
      const agentContextContent = this.resolveAgentContextContent(
        parsedReview,
        response.finalMessage,
        response.fallbackMessage,
      );
      const taskMessage: MessageRecord = {
        id: response.messageId,
        taskId: task.id,
        content: this.createDisplayContent(parsedReview, response.fallbackMessage),
        sender: runtimeAgentName,
        timestamp: response.timestamp,
        meta: {
          kind: "agent-final",
          status: response.status,
          finalMessage: agentContextContent,
          reviewDecision: parsedReview.decision,
          reviewOpinion: parsedReview.opinion ?? "",
          rawResponse: response.finalMessage,
          sessionId: agentSessionId,
          senderDisplayName: this.resolveMessageSenderDisplayName(state, runtimeAgentName),
        },
      };
      this.store.insertMessage(cwd, taskMessage);

      const reviewFailureTargets =
        parsedReview.decision === "needs_revision"
          ? this.getOutgoingEdges(topology, runtimeAgentName, "review_fail")
          : [];
      const agentStatus = resolveAgentStatusFromReview({
        reviewDecision: parsedReview.decision,
        reviewAgent,
      });
      this.store.updateTaskAgentStatus(task.cwd, task.id, runtimeAgentName, agentStatus);
      if (parsedReview.decision === "needs_revision" && reviewFailureTargets.length > 0) {
        this.updateTaskStatusIfActive(
          task.cwd,
          task.id,
          concurrentBatchSize > 1 ? "running" : "needs_revision",
          null,
        );
      } else if (agentStatus === "failed") {
        this.updateTaskStatusIfActive(task.cwd, task.id, "failed", null);
      } else {
        this.updateTaskStatusIfActive(task.cwd, task.id, "running", null);
      }

      this.emit({
        type: "message-created",
        cwd,
        payload: taskMessage,
      });
      this.emit({
        type: "agent-status-changed",
        cwd,
        payload: {
          taskId: task.id,
          agentId: runtimeAgentName,
          status: agentStatus,
          runCount:
            this.store.listTaskAgents(task.cwd, task.id).find((item) => item.name === runtimeAgentName)?.runCount ??
            currentAgent.runCount,
        },
      });
      this.emit({
        type: "task-updated",
        cwd,
        payload: this.hydrateTask(task.cwd, task.id),
      });

      const signal = this.parseSignal(response.finalMessage);
      return {
        agentName: runtimeAgentName,
        status: "completed",
        reviewAgent,
        reviewDecision: parsedReview.decision,
        agentStatus,
        agentContextContent,
        opinion: parsedReview.opinion,
        allowDirectFallbackWhenNoBatch: prompt.allowDirectFallbackWhenNoBatch ?? false,
        signalDone: signal.done,
      };
    } catch (error) {
      const topology = this.store.getTopology(cwd);
      const reviewAgent = this.isReviewAgent({ name: runtimeAgentName }, topology);
      this.store.updateTaskAgentStatus(task.cwd, task.id, runtimeAgentName, "failed");
      const failedMessage: MessageRecord = {
        id: randomUUID(),
        taskId: task.id,
        content: `[${runtimeAgentName}] 执行失败：${error instanceof Error ? error.message : "未知错误"}`,
        sender: "system",
        timestamp: new Date().toISOString(),
      };
      this.store.insertMessage(cwd, failedMessage);
      this.updateTaskStatusIfActive(task.cwd, task.id, "failed", null);
      this.emit({
        type: "message-created",
        cwd,
        payload: failedMessage,
      });
      this.emit({
        type: "agent-status-changed",
        cwd,
        payload: {
          taskId: task.id,
          agentId: runtimeAgentName,
          status: "failed",
          runCount: this.store.listTaskAgents(task.cwd, task.id).find((item) => item.name === runtimeAgentName)?.runCount ?? 0,
        },
      });
      this.emit({
        type: "task-updated",
        cwd,
        payload: this.hydrateTask(task.cwd, task.id),
      });

      return {
        agentName: runtimeAgentName,
        status: "failed",
        reviewAgent,
        reviewDecision: "invalid",
        agentStatus: "failed",
        agentContextContent: "",
        opinion: null,
        allowDirectFallbackWhenNoBatch: false,
        signalDone: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async completeTask(
    cwd: string,
    taskId: string,
    status: TaskRecord["status"],
    failureReason?: string | null,
  ) {
    const currentTask = this.store.getTask(cwd, taskId);
    if (currentTask.status === status && currentTask.completedAt) {
      return;
    }

    const completedAt = status === "finished" || status === "failed" ? new Date().toISOString() : null;
    if (status === "finished") {
      for (const agent of this.store.listTaskAgents(cwd, taskId)) {
        if (agent.status === "completed") {
          continue;
        }
        this.store.updateTaskAgentStatus(cwd, taskId, agent.name, "completed");
        this.emit({
          type: "agent-status-changed",
          cwd,
          payload: {
            taskId,
            agentId: agent.name,
            status: "completed",
            runCount: agent.runCount,
          },
        });
      }
    }
    this.store.updateTaskStatus(cwd, taskId, status, completedAt);
    const snapshot = this.hydrateTask(cwd, taskId);
    const completionMessage: MessageRecord = {
      id: randomUUID(),
      taskId,
      sender: "system",
      timestamp: new Date().toISOString(),
      content: buildTaskCompletionMessageContent({
        status,
        taskTitle: snapshot.task.title,
        failureReason,
      }),
      meta: {
        kind: "task-completed",
        status,
      },
    };
    this.store.insertMessage(cwd, completionMessage);
    this.emit({
      type: "message-created",
      cwd,
      payload: completionMessage,
    });
    this.emit({
      type: "task-updated",
      cwd,
      payload: snapshot,
    });
  }

  private getOutgoingEdges(
    topology: TopologyRecord,
    sourceAgentId: string,
    triggerOn: "association" | "approved" | "needs_revision",
  ) {
    return topology.edges.filter(
      (edge) => edge.source === sourceAgentId && edge.triggerOn === triggerOn,
    );
  }

  private moveTaskToWaiting(cwd: string, taskId: string, sourceAgentId: string) {
    const currentTask = this.store.getTask(cwd, taskId);
    if (currentTask.status === "waiting") {
      return;
    }

    if (!this.updateTaskStatusIfActive(cwd, taskId, "waiting", null)) {
      return;
    }
    const waitingMessage = {
      id: randomUUID(),
      taskId,
      content: `Orchestrator 已收到 ${sourceAgentId} 的结果，但当前拓扑下没有可自动继续推进的下游节点，Task 保持等待状态。`,
      sender: "system",
      timestamp: new Date().toISOString(),
      meta: {
        kind: "orchestrator-waiting",
        sourceAgentId,
      },
    } satisfies MessageRecord;
    this.store.insertMessage(cwd, waitingMessage);
    this.emit({
      type: "message-created",
      cwd,
      payload: waitingMessage,
    });
    this.emit({
      type: "task-updated",
      cwd,
      payload: this.hydrateTask(cwd, taskId),
    });
  }

  private getAgentDisplayName(name: string) {
    return name;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  }

  private hasWorkspaceRecord(cwd: string): boolean {
    const normalizedCwd = path.resolve(cwd);
    return this.knownWorkspaces.has(normalizedCwd) || this.store.hasWorkspaceState(normalizedCwd);
  }

  private extractSessionIdFromOpenCodeEvent(event: unknown): string | null {
    const record = this.asRecord(event);
    const properties = this.asRecord(record.properties);
    const payload = this.asRecord(record.payload);
    const candidates = [
      record.sessionID,
      record.sessionId,
      properties.sessionID,
      properties.sessionId,
      payload.sessionID,
      payload.sessionId,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }

    return null;
  }

  private scheduleRuntimeRefresh(cwd: string, sessionId: string | null) {
    const normalizedCwd = path.resolve(cwd);
    if (!this.hasWorkspaceRecord(normalizedCwd)) {
      return;
    }

    const existing = this.pendingRuntimeRefreshWorkspaces.get(normalizedCwd);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.pendingRuntimeRefreshWorkspaces.delete(normalizedCwd);
      this.emit({
        type: "runtime-updated",
        cwd: normalizedCwd,
        payload: {
          sessionId,
          timestamp: new Date().toISOString(),
        },
      });
    }, this.runtimeRefreshDebounceMs);
    this.pendingRuntimeRefreshWorkspaces.set(normalizedCwd, timer);
  }

  private scheduleEventStreamReconnect(taskId: string) {
    const overlay = this.taskRuntimeOverlays.get(taskId);
    if (!overlay) {
      return;
    }

    if (!shouldScheduleEventStreamReconnect({
      hasProjectRecord: this.hasWorkspaceRecord(overlay.cwd),
      isDisposing: this.isDisposing,
    })) {
      return;
    }
    if (this.pendingEventReconnects.has(overlay.taskId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.pendingEventReconnects.delete(overlay.taskId);
      if (!shouldScheduleEventStreamReconnect({
        hasProjectRecord: this.hasWorkspaceRecord(overlay.cwd),
        isDisposing: this.isDisposing,
      })) {
        return;
      }
      void this.ensureTaskRuntimeEventStream({
        id: overlay.taskId,
        cwd: overlay.cwd,
      });
    }, 1000);
    this.pendingEventReconnects.set(overlay.taskId, timer);
  }

  private emit(event: AgentTeamEvent) {
    this.events.emit("agent-team-event", event);
  }

  private async ensureTaskRuntimeEventStream(task: Pick<TaskRecord, "id" | "cwd">) {
    if (!this.enableEventStream) {
      return;
    }

    const overlay = this.taskRuntimeOverlays.get(task.id);
    if (!overlay) {
      return;
    }
    if (this.connectedRuntimeTaskIds.has(task.id)) {
      return;
    }

    this.connectedRuntimeTaskIds.add(task.id);
    void this.opencodeClient.connectEvents(overlay.runtimeTarget, (event) => {
      this.scheduleRuntimeRefresh(overlay.cwd, this.extractSessionIdFromOpenCodeEvent(event));
    })
      .catch(() => undefined)
      .finally(() => {
        this.connectedRuntimeTaskIds.delete(task.id);
        this.scheduleEventStreamReconnect(task.id);
      });
  }
}
