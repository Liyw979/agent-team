import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { withOptionalString, withOptionalValue } from "@shared/object-utils";
import { resolveTaskSubmissionTarget } from "@shared/task-submission";
import { buildCliOpencodeAttachCommand } from "@shared/terminal-commands";
import {
  type AgentTeamEvent,
  type AgentRuntimeSnapshot,
  type AgentRecord,
  BUILD_AGENT_ID,
  createDefaultTopology,
  DEFAULT_ACTION_REQUIRED_MAX_ROUNDS,
  normalizeActionRequiredMaxRounds,
  createTopologyLangGraphRecord,
  normalizeTopologyEdgeTrigger,
  type DeleteTaskPayload,
  type GetTaskRuntimePayload,
  type InitializeTaskPayload,
  getWorkspaceNameFromPath,
  type MessageRecord,
  type OpenAgentTerminalPayload,
  resolvePrimaryTopologyStartTarget,
  resolveTopologyAgentOrder,
  type SubmitTaskPayload,
  type TaskAgentRecord,
  type TaskRecord,
  type TaskSnapshot,
  type TopologyNodeRecord,
  type TopologyRecord,
  type UpdateTopologyPayload,
  type WorkspaceSnapshot,
} from "@shared/types";
import {
  formatAgentDispatchContent,
  formatActionRequiredRequestContent,
  parseTargetAgentIds,
} from "@shared/chat-message-format";
import { stripDecisionResponseMarkup } from "@shared/decision-response";
import { buildAgentSystemPrompt } from "./agent-system-prompt";
import {
  parseDecision as parseDecisionPure,
  stripStructuredSignals as stripStructuredSignalsPure,
  type ParsedDecision,
} from "./decision-parser";
import {
  OpenCodeClient,
  type OpenCodeRuntimeTarget,
  type OpenCodeShutdownReport,
} from "./opencode-client";
import { OpenCodeRunner } from "./opencode-runner";
import { StoreService } from "./store";
import {
  resolveAgentStatusFromDecision,
} from "./gating-rules";
import {
  buildDownstreamForwardedContextFromMessages,
  buildSourceAgentMessageSectionLabel,
  buildUserHistoryContent as buildUserHistoryContentPure,
  contentContainsNormalized as contentContainsNormalizedPure,
  getInitialUserMessageContent as getInitialUserMessageContentPure,
  stripTargetMention as stripTargetMentionPure,
} from "./message-forwarding";
import {
  reconcileTaskSnapshotFromMessages as reconcileTaskSnapshotFromMessagesPure,
  resolveStandaloneTaskStatusAfterAgentRun,
  shouldFinishTaskFromPersistedState as shouldFinishTaskFromPersistedStatePure,
} from "./task-lifecycle-rules";
import { LangGraphRuntime } from "./langgraph-runtime";
import type { LangGraphTaskLoopHost } from "./langgraph-host";
import type { GraphDispatchBatch, GraphAgentResult } from "./gating-router";
import type { GraphTaskState } from "./gating-state";
import {
  buildTaskCompletionMessageContent,
  buildTaskRoundFinishedMessageContent,
} from "./task-completion-message";
import { buildEffectiveTopology, getRuntimeTemplateName } from "./runtime-topology-graph";
import { resolveForwardingActiveAgentIdsFromState } from "./forwarding-active-agents";
import type { CompiledTeamDsl } from "./team-dsl";
import { shouldScheduleEventStreamReconnect } from "./event-stream-lifecycle";
import { resolveExecutionDecisionAgent } from "./decision-agent-context";
import { resolveTaskAgentIdsToPrewarm } from "./task-session-prewarm";
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
  id: string;
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
      mode: "control";
      content: string;
      allowDirectFallbackWhenNoBatch?: boolean;
    }
  | {
      mode: "structured";
      from: string;
      userMessage?: string;
      agentMessage?: string;
      omitSourceAgentSectionLabel?: boolean;
      gitDiffSummary?: string;
      allowDirectFallbackWhenNoBatch?: boolean;
    };

interface AgentRunBehaviorOptions {
  followTopology?: boolean;
  updateTaskStatusOnStart?: boolean;
  completeTaskOnFinish?: boolean;
}

export function isTerminalTaskStatus(status: TaskRecord["status"]) {
  return status === "finished" || status === "failed";
}

export class Orchestrator {
  readonly store: StoreService;
  readonly opencodeClient: OpenCodeClient;
  readonly opencodeRunner: OpenCodeRunner;
  private readonly events = new EventEmitter();
  private readonly langGraphRuntimes = new Map<string, LangGraphRuntime>();
  private readonly enableEventStream: boolean;
  private readonly taskRuntimeOverlays = new Map<string, TaskRuntimeOverlay>();
  private readonly connectedRuntimeTaskIds = new Set<string>();
  private readonly pendingRuntimeRefreshWorkspaces = new Map<string, ReturnType<typeof setTimeout>>();
  readonly pendingEventReconnects = new Map<string, ReturnType<typeof setTimeout>>();
  readonly pendingTaskRuns = new Set<Promise<void>>();
  private readonly knownWorkspaces = new Set<string>();
  private readonly runtimeRefreshDebounceMs: number;
  private readonly terminalLauncher: (input: { cwd: string; command: string }) => Promise<void>;
  private isDisposing = false;

  constructor(options: OrchestratorOptions) {
    this.store = new StoreService();
    this.opencodeClient = new OpenCodeClient();
    this.opencodeRunner = new OpenCodeRunner(this.opencodeClient);
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

  private ensureWorkspaceRecord(cwd: string): WorkspaceRecord {
    const normalizedCwd = path.resolve(cwd);
    this.knownWorkspaces.add(normalizedCwd);
    this.store.getTopology(normalizedCwd);
    return {
      cwd: normalizedCwd,
      id: getWorkspaceNameFromPath(normalizedCwd),
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

  async readAgent(cwd: string, agentId: string): Promise<AgentRecord> {
    const matched = this.listWorkspaceAgents(cwd).find((agent) => agent.id === agentId);
    if (!matched) {
      throw new Error(`Agent 配置不存在：${agentId}`);
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
        id: agent.id,
        prompt: agent.prompt,
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
    validateProjectAgents();
    this.syncTopology(normalizedCwd, agents);
    const topology = this.store.getTopology(normalizedCwd);
    const resolution = resolveTaskSubmissionTarget({
      content: payload.content,
      availableAgents: agents.map((agent) => agent.id),
      ...withOptionalString({}, "mentionAgentId", payload.mentionAgentId),
      ...withOptionalString({}, "defaultTargetAgentId", resolvePrimaryTopologyStartTarget(topology) ?? undefined),
    });
    if (!resolution.ok) {
      throw new Error(resolution.message);
    }
    const mentionAgentId = resolution.targetAgentId;

    if (payload.taskId) {
      return this.continueTask(normalizedCwd, payload.taskId, payload.content, mentionAgentId, agents);
    }

    const initialized = await this.createTask(normalizedCwd, agents, {
      taskId: payload.newTaskId ?? null,
      title: this.createTaskTitle(payload.content),
      source: "submit",
    });

    return this.continueTask(
      normalizedCwd,
      initialized.task.id,
      payload.content,
      mentionAgentId,
      agents,
    );
  }

  async initializeTask(payload: InitializeTaskPayload): Promise<TaskSnapshot> {
    const normalizedCwd = path.resolve(payload.cwd);
    const agents = this.listWorkspaceAgents(normalizedCwd);
    validateProjectAgents();
    this.syncTopology(normalizedCwd, agents);

    return this.createTask(normalizedCwd, agents, {
      taskId: payload.taskId ?? null,
      title: (payload.title ?? "").trim() || "未命名任务",
      source: "initialize",
    });
  }

  async openAgentTerminal(payload: OpenAgentTerminalPayload) {
    const normalizedCwd = path.resolve(payload.cwd);
    const task = this.store.getTask(normalizedCwd, payload.taskId);
    const snapshot = await this.ensureTaskInitialized(
      task,
      this.listWorkspaceAgents(normalizedCwd),
    );
    this.emit({
      type: "task-updated",
      cwd: normalizedCwd,
      payload: snapshot,
    });

    const taskAgent = snapshot.agents.find((item) => item.id === payload.agentId);
    if (!taskAgent) {
      throw new Error(`未找到 Agent ${payload.agentId} 对应的运行信息。`);
    }
    if (!taskAgent.opencodeSessionId) {
      throw new Error(`Agent ${payload.agentId} 当前还没有可 attach 的 OpenCode session。`);
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
          agentId: agent.id,
          sessionId: agent.opencodeSessionId,
          status: agent.status,
          runtimeStatus: agent.status,
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
      taskId?: string | null;
      title: string;
      source: "initialize" | "submit";
    },
  ): Promise<TaskSnapshot> {
    if (agents.length === 0) {
      throw new Error("当前工作区没有可用的 Agent");
    }

    const taskId = options.taskId?.trim() || randomUUID();
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
        taskId,
        id: agent.id,
        opencodeSessionId: null,
        opencodeAttachBaseUrl: null,
        status: "idle",
        runCount: 0,
      });
    }

    await this.ensureTaskInitialized(task, agents);

    const taskCreatedMessage: MessageRecord = {
      id: randomUUID(),
      taskId,
      content:
        options.source === "initialize"
          ? "Task 已初始化"
          : "Task 已创建并完成初始化",
      sender: "system",
      timestamp: new Date().toISOString(),
      kind: "task-created",
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
    mentionAgentId: string,
    agents: AgentRecord[],
  ): Promise<TaskSnapshot> {
    const normalizedCwd = path.resolve(cwd);
    const task = this.store.getTask(normalizedCwd, taskId);
    if (isTerminalTaskStatus(task.status)) {
      this.store.updateTaskStatus(normalizedCwd, task.id, "running", null);
    }

    this.syncTaskAgents(task, agents);
    const targetAgentRecord = this.findAgent(agents, mentionAgentId);

    if (!targetAgentRecord) {
      throw new Error(`未找到被 @ 的 Agent：${mentionAgentId}`);
    }

    await this.ensureTaskInitialized(task, agents);

    const message = this.createUserMessage(task.id, task.title, content, targetAgentRecord.id);
    this.store.insertMessage(normalizedCwd, message);
    this.emit({
      type: "message-created",
      cwd: normalizedCwd,
      payload: message,
    });

    const forwardedContent = stripTargetMentionPure(content, targetAgentRecord.id);
    const topology = this.store.getTopology(normalizedCwd);
    const runtime = this.getLangGraphRuntime(normalizedCwd);
    this.trackBackgroundTask(runtime.resumeTask({
      taskId: task.id,
      topology,
      event: {
        type: "user_message",
        targetAgentId: targetAgentRecord.id,
        content: forwardedContent,
      },
    }).then(() => undefined), {
      taskId: task.id,
      agentId: targetAgentRecord.id,
    });
    return this.hydrateTask(normalizedCwd, task.id);
  }

  protected trackBackgroundTask(
    promise: Promise<void>,
    context: {
      taskId: string;
      agentId: string;
    },
  ) {
    const tracked = promise
      .catch((error) => {
        console.error("[orchestrator] 后台发送任务失败", {
          taskId: context.taskId,
          agentId: context.agentId,
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
      kind: "user",
      scope: "task",
      taskTitle,
      targetAgentIds: [targetAgentId],
    };
  }

  private syncTaskAgents(task: TaskRecord, agents: AgentRecord[]) {
    const orderedAgents = this.orderAgents(task.cwd, agents);
    const existingByName = new Set(this.store.listTaskAgents(task.cwd, task.id).map((item) => item.id));
    for (const agent of orderedAgents) {
      if (existingByName.has(agent.id)) {
        continue;
      }
      this.store.insertTaskAgent(task.cwd, {
        taskId: task.id,
        id: agent.id,
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
    runtimeAgentId: string,
  ): void {
    const existing = this.store.listTaskAgents(task.cwd, task.id).find((item) => item.id === runtimeAgentId);
    if (existing) {
      return;
    }
    this.store.insertTaskAgent(task.cwd, {
      taskId: task.id,
      id: runtimeAgentId,
      opencodeSessionId: null,
      opencodeAttachBaseUrl: null,
      status: "idle",
      runCount: 0,
    });
    this.store.updateTaskAgentCount(task.cwd, task.id, this.store.listTaskAgents(task.cwd, task.id).length);
  }

  protected async runAgent(
    cwd: string,
    task: TaskRecord,
    agentId: string,
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
      agentId,
      agentId,
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

    if (latestTask.status === "continue") {
      return;
    }

    const nextTaskStatus = resolveStandaloneTaskStatusAfterAgentRun({
      latestAgentStatus: result.status === "failed" ? "failed" : result.agentStatus,
      agentStatuses: this.store.listTaskAgents(task.cwd, task.id),
    });

    if (nextTaskStatus === "finished") {
      await this.completeTask(task.cwd, task.id, "finished", "standalone_round_finished");
      return;
    }

    if (nextTaskStatus === "failed") {
      await this.completeTask(task.cwd, task.id, "failed");
      return;
    }

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
      if (!message) {
        continue;
      }
      const timestamp = Date.parse(message.timestamp);
      if (!Number.isFinite(timestamp)) {
        continue;
      }
      if (now - timestamp > 1500) {
        break;
      }
      if (message.sender === sourceAgentId && message.kind === "agent-final") {
        return false;
      }
      if (message.sender !== sourceAgentId || message.kind !== "agent-dispatch") {
        continue;
      }

      const historicalTargets = parseTargetAgentIds(message.targetAgentIds)
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
    targetAgentId: string,
  ): boolean {
    return targetAgentId !== BUILD_AGENT_ID && !resolveExecutionDecisionAgent({
      state: null,
      topology,
      runtimeAgentId: targetAgentId,
      executableAgentId: targetAgentId,
    });
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

    await this.completeTask(task.cwd, taskId, "finished", "persisted_round_finished");
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

  protected parseDecision(content: string, decisionAgent: boolean): ParsedDecision {
    return parseDecisionPure(content, decisionAgent);
  }

  private stripStructuredSignals(content: string): string {
    return stripStructuredSignalsPure(content);
  }

  protected async buildProjectGitDiffSummary(cwd: string): Promise<string> {
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

  protected buildAgentExecutionPrompt(prompt: AgentExecutionPrompt): string {
    if (prompt.mode === "raw") {
      const content = prompt.content.trim();
      const from = this.getAgentDisplayName(prompt.from?.trim() || "System");
      return `[${from}] ${content || "（无）"}`.trim();
    }

    if (prompt.mode === "control") {
      return prompt.content.trim() || "（无）";
    }

    const sections: string[] = [];
    if (prompt.userMessage?.trim()) {
      sections.push(`[Initial Task]\n${prompt.userMessage.trim()}`);
    }
    if (prompt.agentMessage?.trim()) {
      sections.push(
        prompt.omitSourceAgentSectionLabel
          ? prompt.agentMessage.trim()
          : `${buildSourceAgentMessageSectionLabel(prompt.from)}\n${prompt.agentMessage.trim()}`,
      );
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

  private resolveAgentContextContent(
    parsedDecision: ParsedDecision,
    rawFinalMessage: string,
  ): string {
    const candidates = [
      parsedDecision.cleanContent.trim(),
      parsedDecision.opinion.trim(),
      this.stripStructuredSignals(stripDecisionResponseMarkup(rawFinalMessage)).trim(),
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
    return trimmed
      .replace(/\n(?:---|\*\*\*)(?:\s*\n?)*$/u, "")
      .trim();
  }

  protected createDisplayContent(parsedDecision: ParsedDecision): string {
    const cleanContent = this.extractAgentDisplayContent(parsedDecision.cleanContent);
    if (cleanContent) {
      return cleanContent;
    }

    const opinion = parsedDecision.opinion.trim();
    if (opinion) {
      return opinion;
    }

    if (parsedDecision.decision === "continue") {
      return "（该 Agent 已给出需要响应的结论，但未返回可展示的结果正文。）";
    }
    return "";
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
      opencodeSessionId: overlay?.agentSessions.get(agent.id) ?? null,
      opencodeAttachBaseUrl: overlay?.attachBaseUrl ?? null,
    }));
  }

  protected async ensureAgentSession(
    task: TaskRecord,
    agent: TaskAgentRecord,
  ): Promise<string> {
    const overlay = this.ensureTaskRuntimeOverlay(task);
    const existingSessionId = overlay.agentSessions.get(agent.id) ?? null;
    if (existingSessionId) {
      return existingSessionId;
    }

    this.setInjectedConfigForTask(task);
    const sessionId = await this.opencodeClient.createSession(
      overlay.runtimeTarget,
      `${task.title}:${agent.id}`,
    );
    overlay.agentSessions.set(agent.id, sessionId);
    if (!overlay.attachBaseUrl) {
      overlay.attachBaseUrl = await this.opencodeClient.getAttachBaseUrl(overlay.runtimeTarget).catch(() => null);
    }
    return sessionId;
  }

  protected async ensureTaskPanels(task: TaskRecord) {
    await this.ensureTaskInitialized(task, this.listWorkspaceAgents(task.cwd));
  }

  private async ensureTaskAgentSessions(task: TaskRecord): Promise<Map<string, string>> {
    const topology = this.store.getTopology(task.cwd);
    const prewarmAgentIds = new Set(
      resolveTaskAgentIdsToPrewarm(topology, this.store.listTaskAgents(task.cwd, task.id)),
    );
    const sessions = await Promise.all(
      this.store.listTaskAgents(task.cwd, task.id)
        .filter((agent) => prewarmAgentIds.has(agent.id))
        .map(async (agent) => [
        agent.id,
        await this.ensureAgentSession(task, agent),
      ] as const),
    );
    return new Map(sessions);
  }

  private async ensureTaskInitialized(
    task: TaskRecord,
    agents: AgentRecord[],
  ): Promise<TaskSnapshot> {
    this.syncTaskAgents(task, agents);
    const currentTask = this.store.getTask(task.cwd, task.id);
    await this.ensureTaskAgentSessions(currentTask);
    await this.ensureTaskRuntimeEventStream(currentTask);

    const refreshedTask = this.store.getTask(task.cwd, task.id);
    if (!refreshedTask.initializedAt) {
      this.store.updateTaskInitialized(task.cwd, task.id, new Date().toISOString());
    }

    return this.hydrateTask(task.cwd, task.id);
  }

  private getOrderedAgentIds(
    cwd: string,
    agents: Array<Pick<AgentRecord, "id">>,
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
    const orderedNames = this.getOrderedAgentIds(cwd, agents, topologyOverride);
    const agentByName = new Map(agents.map((agent) => [agent.id, agent]));
    return orderedNames.map((name) => agentByName.get(name)).filter((agent): agent is AgentRecord => Boolean(agent));
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

  private findAgent(agents: AgentRecord[], id: string | undefined): AgentRecord | undefined {
    if (!id) {
      return undefined;
    }
    return agents.find((agent) => agent.id === id);
  }

  private resolveExecutableAgentId(
    cwd: string,
    state: GraphTaskState | null,
    runtimeAgentId: string,
  ): string {
    const workspaceAgents = this.listWorkspaceAgents(cwd);
    if (workspaceAgents.some((agent) => agent.id === runtimeAgentId)) {
      return runtimeAgentId;
    }

    const templateName = state ? getRuntimeTemplateName(state, runtimeAgentId) : null;
    if (templateName && workspaceAgents.some((agent) => agent.id === templateName)) {
      return templateName;
    }

    return runtimeAgentId;
  }

  private resolveMessageSenderDisplayName(
    state: GraphTaskState | null,
    runtimeAgentId: string,
  ): string {
    if (!state) {
      return runtimeAgentId;
    }
    return state.runtimeNodes.find((node) => node.id === runtimeAgentId)?.displayName ?? runtimeAgentId;
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
      name: workspace.id,
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
    const messages = this.store.listMessages(task.cwd, taskId);
    const reconciled = reconcileTaskSnapshotFromMessagesPure({
      task: this.store.getTask(task.cwd, taskId),
      agents: this.overlayTaskAgents(task, persistedAgents),
      messages,
    });
    return {
      task: reconciled.task,
      agents: reconciled.agents,
      messages,
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
    const validNames = new Set(agents.map((item) => item.id));
    const agentByName = new Map(agents.map((agent) => [agent.id, agent]));
    const rawNodeRecords: TopologyNodeRecord[] = topology.nodeRecords
      ? topology.nodeRecords
      : topology.nodes.map((name) => ({
          id: name,
          kind: "agent" as const,
          templateName: name,
        }));
    const spawnNodeIds = new Set(
      rawNodeRecords
        .filter((node) => node.kind === "spawn" && node.id)
        .map((node) => node.id),
    );
    const validTopologyNames = new Set([...validNames, ...spawnNodeIds]);
    const seenEdges = new Set<string>();
    const seenPairs = new Set<string>();
    const edges = topology.edges
      .map((edge) => {
        const triggerOn = normalizeTopologyEdgeTrigger(edge.triggerOn);
        return {
          ...edge,
          triggerOn,
        };
      })
      .filter((edge) => validTopologyNames.has(edge.source) && validTopologyNames.has(edge.target))
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
        messageMode: edge.messageMode,
        ...(edge.triggerOn === "continue"
          ? {
              maxContinueRounds:
                edge.maxContinueRounds === undefined
                  ? DEFAULT_ACTION_REQUIRED_MAX_ROUNDS
                  : normalizeActionRequiredMaxRounds(edge.maxContinueRounds),
            }
          : {}),
      }));
    const orderedAgentNodes = resolveTopologyAgentOrder(
      agents.map((agent) => ({ id: agent.id })),
      topology.nodes.filter((item) => validNames.has(item)),
    );
    const nodes = [
      ...orderedAgentNodes,
      ...topology.nodes.filter((item) => spawnNodeIds.has(item)),
    ].filter((value, index, list) => list.indexOf(value) === index);
    const nodeRecords = rawNodeRecords.filter(
      (node) =>
        node.id
        && node.templateName
        && (node.kind === "spawn" || validNames.has(node.templateName)),
    ).map((node) => {
      const prompt = node.kind === "agent"
        ? agentByName.get(node.templateName)?.prompt
        : (typeof node.prompt === "string" ? node.prompt : undefined);
      const writable = node.kind === "agent"
        ? agentByName.get(node.templateName)?.isWritable === true
        : node.writable === true;

      return {
        id: node.id,
        kind: node.kind,
        templateName: node.templateName,
        ...(node.spawnRuleId ? { spawnRuleId: node.spawnRuleId } : {}),
        ...(node.spawnEnabled === true ? { spawnEnabled: true } : {}),
        ...(typeof prompt === "string" ? { prompt } : {}),
        ...(writable ? { writable: true } : {}),
      };
    });
    const spawnRules = topology.spawnRules?.filter(
      (rule) => {
        const spawnNodeName = rule.spawnNodeName
          || rawNodeRecords.find((node) => node.spawnRuleId === rule.id)?.id
          || "";
        return (
          rule.id
          && rule.id
          && spawnNodeName
          && rule.entryRole
          && validTopologyNames.has(spawnNodeName)
          && (!rule.sourceTemplateName || validNames.has(rule.sourceTemplateName))
          && (!rule.reportToTemplateName || validNames.has(rule.reportToTemplateName))
          && rule.spawnedAgents.every((agent) => agent.role && validNames.has(agent.templateName))
        );
      },
    ).map((rule) => ({
      ...rule,
      spawnNodeName: rule.spawnNodeName
        || rawNodeRecords.find((node) => node.spawnRuleId === rule.id)?.id
        || rule.id,
      spawnedAgents: rule.spawnedAgents.map((agent) => ({ ...agent })),
      edges: rule.edges.map((edge) => ({ ...edge })),
    }));
    const endIncoming = topology.langgraph?.end?.incoming?.filter((edge) => validTopologyNames.has(edge.source))
      ?? topology.langgraph?.end?.sources
        .filter((source) => validTopologyNames.has(source))
        .map((source) => ({ source }));
    const langgraph = createTopologyLangGraphRecord({
      nodes,
      edges,
      startTargets: topology.langgraph?.start.targets ?? [resolvePrimaryTopologyStartTarget(topology)],
      ...(endIncoming ? { endIncoming } : {}),
    });

    return {
      nodes,
      edges,
      langgraph,
      ...(nodeRecords ? { nodeRecords } : {}),
      ...(spawnRules ? { spawnRules } : {}),
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
      completeTask: async ({ taskId, status, finishReason, failureReason }) =>
        this.completeTask(cwd, taskId, status, finishReason, failureReason),
    };
    runtime = new LangGraphRuntime({
      host,
    });
    this.langGraphRuntimes.set(cwd, runtime);
    return runtime;
  }

  private async deleteTaskGraphRuntime(task: Pick<TaskRecord, "id" | "cwd">) {
    await this.getLangGraphRuntime(task.cwd).deleteTask(task.id);
  }

  private consumeInitialTaskForwardingAllowanceFromGraphState(state: GraphTaskState): boolean {
    if (state.hasForwardedInitialTask) {
      return false;
    }
    state.hasForwardedInitialTask = true;
    return true;
  }

  private resolveForwardingActiveAgentIds(
    state: GraphTaskState,
    sourceAgentId: string,
    targetAgentId: string,
  ): string[] {
    return resolveForwardingActiveAgentIdsFromState(state, sourceAgentId, targetAgentId);
  }

  protected async createLangGraphBatchRunners(
    cwd: string,
    taskId: string,
    state: GraphTaskState,
    batch: GraphDispatchBatch,
  ) {
    const task = this.store.getTask(cwd, taskId);
    const topology = this.store.getTopology(cwd);
    const batchSize = batch.jobs.length;

    if (batch.jobs.every((job) => job.kind === "transfer" || job.kind === "complete")) {
      const sourceAgentId = batch.sourceAgentId ?? "System";
      if (!this.shouldSuppressDuplicateDispatchMessage(cwd, taskId, sourceAgentId, batch.triggerTargets)) {
        const triggerMessage: MessageRecord = {
          id: randomUUID(),
          taskId,
          sender: sourceAgentId,
          timestamp: new Date().toISOString(),
          content: this.buildDispatchMessageContent(
            batch.triggerTargets,
            batch.displayContent ?? batch.sourceContent ?? "",
          ),
          kind: "agent-dispatch",
          targetAgentIds: [...batch.triggerTargets],
          dispatchDisplayContent: batch.displayContent ?? "",
          senderDisplayName: this.resolveMessageSenderDisplayName(state, sourceAgentId),
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
    const taskMessages = this.store.listMessages(task.cwd, taskId);
    const initialUserContent = includeInitialTask
      ? getInitialUserMessageContentPure(taskMessages)
      : "";

    return batch.jobs.map((job, index) => {
      this.ensureRuntimeTaskAgent(task, job.agentId);
      const executableAgentId = this.resolveExecutableAgentId(cwd, state, job.agentId);
      const messageMode = batch.sourceAgentId
        ? this.getEdgeMessageMode(
          buildEffectiveTopology(state),
          batch.sourceAgentId,
          job.agentId,
          job.kind === "raw" ? "transfer" : job.kind,
        )
        : "last";
      const forwardedContext = batch.sourceAgentId
        ? buildDownstreamForwardedContextFromMessages(
          taskMessages,
          batch.sourceContent ?? "",
          {
            includeInitialTask,
            messageMode,
            activeAgentIds: this.resolveForwardingActiveAgentIds(state, batch.sourceAgentId, job.agentId),
          },
        )
        : null;
      let prompt: AgentExecutionPrompt;
      if (job.kind === "raw") {
        prompt = {
          mode: "raw",
          from: "User",
          content: batch.sourceContent ?? "",
          allowDirectFallbackWhenNoBatch:
            this.getOutgoingEdges(topology, job.agentId, "continue").length > 0,
        };
      } else if (job.kind === "continue_request") {
        if (!batch.sourceMessageId.trim()) {
          throw new Error(`${batch.sourceAgentId ?? "DecisionAgent"} 的 continue-request 缺少 followUpMessageId`);
        }
        const continueContent =
          batch.sourceContent?.trim()
          || "请直接回应当前内容，给出你的判断、补充、澄清、反驳或修改方案。";
        prompt = withOptionalString(withOptionalString({
          mode: "structured",
          from: batch.sourceAgentId ?? "DecisionAgent",
          agentMessage: continueContent,
          allowDirectFallbackWhenNoBatch: true,
        }, "userMessage",
          initialUserContent
          && !contentContainsNormalizedPure(continueContent, initialUserContent)
            ? initialUserContent
            : undefined,
        ), "gitDiffSummary", this.shouldAttachGitDiffSummary(topology, executableAgentId) ? gitDiffSummary : undefined);
        const remediationMessage: MessageRecord = {
          id: randomUUID(),
          taskId,
          sender: batch.sourceAgentId ?? "DecisionAgent",
          timestamp: new Date().toISOString(),
          content: formatActionRequiredRequestContent(
            continueContent,
            [job.agentId],
          ),
          kind: "continue-request",
          followUpMessageId: batch.sourceMessageId,
          targetAgentIds: [job.agentId],
          ...withOptionalString(
            {},
            "senderDisplayName",
            batch.sourceAgentId
              ? this.resolveMessageSenderDisplayName(state, batch.sourceAgentId)
              : "DecisionAgent",
          ),
        };
        this.store.insertMessage(cwd, remediationMessage);
        this.emit({
          type: "message-created",
          cwd,
          payload: remediationMessage,
        });
      } else if (messageMode === "none") {
        prompt = {
          mode: "control",
          content: forwardedContext?.agentMessage ?? "continue",
        };
      } else {
        prompt = withOptionalString(
          withOptionalString(
            withOptionalValue({
              mode: "structured",
              from: batch.sourceAgentId ?? "System",
            }, "omitSourceAgentSectionLabel", messageMode === "last-all" ? true : undefined),
            "userMessage",
            forwardedContext?.userMessage,
          ),
          "agentMessage",
          forwardedContext?.agentMessage,
        );
        prompt = withOptionalString(
          prompt,
          "gitDiffSummary",
          this.shouldAttachGitDiffSummary(topology, executableAgentId) ? gitDiffSummary : undefined,
        );
      }

      return {
        id: `${batch.sourceAgentId ?? "user"}:${job.agentId}:${index}:${Date.now()}`,
        agentId: job.agentId,
        promise: this.executeLangGraphAgentOnce(
          cwd,
          task,
          state,
          job.agentId,
          executableAgentId,
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
    runtimeAgentId: string,
    executableAgentId: string,
    prompt: AgentExecutionPrompt,
    concurrentBatchSize: number,
  ): Promise<GraphAgentResult> {
    this.setInjectedConfigForTask(task);
    this.store.updateTaskAgentRun(task.cwd, task.id, runtimeAgentId, "running");
    this.updateTaskStatusIfActive(task.cwd, task.id, "running", null);
    const currentAgent = this.store.listTaskAgents(task.cwd, task.id).find((item) => item.id === runtimeAgentId);
    if (!currentAgent) {
      return {
        agentId: runtimeAgentId,
        status: "failed",
        errorMessage: `Task ${task.id} 缺少 Agent ${runtimeAgentId}`,
      };
    }

    try {
      const currentTask = this.store.getTask(task.cwd, task.id);
      await this.ensureTaskPanels(currentTask);
      const agentSessionId = await this.ensureAgentSession(currentTask, currentAgent);
      const latestAgent = this.findAgent(this.listWorkspaceAgents(cwd), executableAgentId);
      if (!latestAgent) {
        throw new Error(`当前工作区缺少 Agent ${executableAgentId}`);
      }

      this.emit({
        type: "agent-status-changed",
        cwd,
        payload: {
          taskId: task.id,
          agentId: runtimeAgentId,
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
      const decisionAgent = resolveExecutionDecisionAgent({
        state,
        topology,
        runtimeAgentId,
        executableAgentId,
      });
      const response = await this.opencodeRunner.run({
        runtimeTarget: this.getTaskRuntimeTarget(currentTask),
        sessionId: agentSessionId,
        content: dispatchedContent,
        agent: executableAgentId,
        ...(decisionAgent ? { system: buildAgentSystemPrompt() } : {}),
      });

      if (response.status === "error") {
        throw new Error(
          response.rawMessage.error || response.finalMessage || `${runtimeAgentId} 返回错误状态`,
        );
      }
      const parsedDecision = this.parseDecision(response.finalMessage, decisionAgent);
      const agentStatus = resolveAgentStatusFromDecision({
        decision: parsedDecision.decision,
        decisionAgent,
      });
      const agentContextContent = this.resolveAgentContextContent(
        parsedDecision,
        response.finalMessage,
      );
      const displayContent = this.createDisplayContent(parsedDecision);
      if (!displayContent) {
        throw new Error(`${runtimeAgentId} 未返回可展示的结果正文`);
      }
      const taskMessage: MessageRecord = {
        id: response.messageId,
        taskId: task.id,
        content: displayContent,
        sender: runtimeAgentId,
        timestamp: response.timestamp,
        kind: "agent-final",
        status: "completed",
        decision: parsedDecision.decision,
        decisionNote: parsedDecision.opinion,
        rawResponse: response.finalMessage,
        senderDisplayName: this.resolveMessageSenderDisplayName(state, runtimeAgentId),
      };
      this.store.insertMessage(cwd, taskMessage);

      const actionRequiredTargets =
        parsedDecision.decision === "continue"
          ? this.getOutgoingEdges(topology, runtimeAgentId, "continue")
          : [];
      this.store.updateTaskAgentStatus(task.cwd, task.id, runtimeAgentId, agentStatus);
      if (parsedDecision.decision === "continue" && actionRequiredTargets.length > 0) {
        this.updateTaskStatusIfActive(
          task.cwd,
          task.id,
          concurrentBatchSize > 1 ? "running" : "continue",
          null,
        );
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
          agentId: runtimeAgentId,
          status: agentStatus,
          runCount:
            this.store.listTaskAgents(task.cwd, task.id).find((item) => item.id === runtimeAgentId)?.runCount ??
            currentAgent.runCount,
        },
      });
      this.emit({
        type: "task-updated",
        cwd,
        payload: this.hydrateTask(task.cwd, task.id),
      });

      const signal = this.parseSignal(response.finalMessage);
      if (parsedDecision.decision === "continue") {
        return {
          agentId: runtimeAgentId,
          messageId: taskMessage.id,
          status: "completed",
          decisionAgent: true,
          decision: "continue",
          agentStatus: "continue",
          agentContextContent,
          opinion: parsedDecision.opinion,
          allowDirectFallbackWhenNoBatch: prompt.allowDirectFallbackWhenNoBatch ?? false,
          signalDone: signal.done,
        };
      }
      return {
        agentId: runtimeAgentId,
        messageId: taskMessage.id,
        status: "completed",
        decisionAgent,
        decision: "complete",
        agentStatus: "completed",
        agentContextContent,
        opinion: parsedDecision.opinion,
        allowDirectFallbackWhenNoBatch: prompt.allowDirectFallbackWhenNoBatch ?? false,
        signalDone: signal.done,
      };
    } catch (error) {
      this.store.updateTaskAgentStatus(task.cwd, task.id, runtimeAgentId, "failed");
      const failedMessage: MessageRecord = {
        id: randomUUID(),
        taskId: task.id,
        content: `[${runtimeAgentId}] 执行失败：${error instanceof Error ? error.message : "未知错误"}`,
        sender: "system",
        timestamp: new Date().toISOString(),
        kind: "system-message",
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
          agentId: runtimeAgentId,
          status: "failed",
          runCount: this.store.listTaskAgents(task.cwd, task.id).find((item) => item.id === runtimeAgentId)?.runCount ?? 0,
        },
      });
      this.emit({
        type: "task-updated",
        cwd,
        payload: this.hydrateTask(task.cwd, task.id),
      });

      return {
        agentId: runtimeAgentId,
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async completeTask(
    cwd: string,
    taskId: string,
    status: Extract<TaskRecord["status"], "finished" | "failed">,
    finishReason?: string | null,
    failureReason?: string | null,
  ) {
    const currentTask = this.store.getTask(cwd, taskId);
    if (currentTask.status === status && currentTask.completedAt) {
      return;
    }

    const completedAt = status === "finished" || status === "failed" ? new Date().toISOString() : null;
    this.store.updateTaskStatus(cwd, taskId, status, completedAt);
    const snapshot = this.hydrateTask(cwd, taskId);
    const completionTimestamp = this.createTrailingMessageTimestamp(cwd, taskId);
    const completionMessage: MessageRecord =
      status === "finished"
        ? {
            id: randomUUID(),
            taskId,
            sender: "system",
            timestamp: completionTimestamp,
            content: buildTaskRoundFinishedMessageContent(),
            kind: "task-round-finished",
            finishReason: finishReason ?? "round_finished",
          }
        : {
            id: randomUUID(),
            taskId,
            sender: "system",
            timestamp: completionTimestamp,
            content: buildTaskCompletionMessageContent(withOptionalValue({
              status,
              taskTitle: snapshot.task.title,
            }, "failureReason", failureReason)),
            kind: "task-completed",
            status: "failed",
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

  private createTrailingMessageTimestamp(cwd: string, taskId: string): string {
    const latestTimestamp = this.store.listMessages(cwd, taskId).at(-1)?.timestamp ?? null;
    const nowMs = Date.now();
    const latestMs = latestTimestamp ? Date.parse(latestTimestamp) : Number.NaN;
    const nextMs = Number.isFinite(latestMs)
      ? Math.max(nowMs, latestMs + 1)
      : nowMs;
    return new Date(nextMs).toISOString();
  }

  private getOutgoingEdges(
    topology: TopologyRecord,
    sourceAgentId: string,
    triggerOn: "transfer" | "complete" | "continue",
  ) {
    return topology.edges.filter(
      (edge) => edge.source === sourceAgentId && edge.triggerOn === triggerOn,
    );
  }

  protected getEdgeMessageMode(
    topology: TopologyRecord,
    sourceAgentId: string,
    targetAgentId: string,
    triggerOn: "transfer" | "complete" | "continue_request",
  ) {
    const normalizedTriggerOn = triggerOn === "continue_request" ? "continue" : triggerOn;
    const edge = topology.edges.find(
      (item) =>
        item.source === sourceAgentId
        && item.target === targetAgentId
        && item.triggerOn === normalizedTriggerOn,
    );
    if (edge) {
      return edge.messageMode;
    }

    const targetNode = topology.nodeRecords?.find((node) => node.id === targetAgentId);
    if (targetNode) {
      const inheritedEdge = topology.edges.find(
        (item) =>
          item.source === sourceAgentId
          && item.target === targetNode.templateName
          && item.triggerOn === normalizedTriggerOn,
      );
      if (inheritedEdge) {
        return inheritedEdge.messageMode;
      }
    }

    throw new Error(
      `拓扑边不存在，无法解析 messageMode：${sourceAgentId} -> ${targetAgentId} (${normalizedTriggerOn})`,
    );
  }

  private getAgentDisplayName(id: string) {
    return id;
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
    const properties = this.asRecord(record["properties"]);
    const payload = this.asRecord(record["payload"]);
    const candidates = [
      record["sessionID"],
      record["sessionId"],
      properties["sessionID"],
      properties["sessionId"],
      payload["sessionID"],
      payload["sessionId"],
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }

    return null;
  }

  private scheduleRuntimeRefresh(cwd: string, taskId: string, sessionId: string | null) {
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
          taskId,
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
      this.scheduleRuntimeRefresh(overlay.cwd, overlay.taskId, this.extractSessionIdFromOpenCodeEvent(event));
    })
      .catch(() => undefined)
      .finally(() => {
        this.connectedRuntimeTaskIds.delete(task.id);
        this.scheduleEventStreamReconnect(task.id);
      });
  }
}
