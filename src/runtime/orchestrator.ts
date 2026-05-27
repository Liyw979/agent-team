// 历史要求：执行期决策 Agent 判断直接使用共享拓扑能力，不保留薄包装方法，不引入多个拓扑兼容设想。
// 历史要求：orchestrator 内直接调用已有共享能力，不保留无业务语义的透传包装方法。
import { randomUUID } from "node:crypto";
import path from "node:path";
import { withOptionalString } from "@shared/object-utils";
import { resolveTaskSubmissionTarget } from "@shared/task-submission";
import { buildCliOpencodeAttachCommand } from "@shared/terminal-commands";
import {
  type AgentFinalMessageRecord,
  type AgentRoutingKind,
  type AgentRecord,
  buildTopologyNodeRecords,
  collectTopologyTriggerShapes,
  createDefaultTopology,
  DEFAULT_TOPOLOGY_TRIGGER,
  type InitialMessageRouting,
  FLOW_END_NODE_ID,
  normalizeMaxTriggerRounds,
  createTopologyFlowRecord,
  getTopologyEdgeId,
  getTopologyNodeRecords,
  normalizeGroupRule,
  normalizeTopologyEdgeTrigger,
  resolveTriggerRoutingKindForSource,
  getWorkspaceNameFromPath,
  isDecisionAgentInTopology,
  type MessageRecord,
  resolvePrimaryTopologyStartTarget,
  resolveTopologyAgentOrder,
  type GroupRule,
  type SubmitTaskPayload,
  type TaskAgentRecord,
  type TaskRecord,
  type TaskSnapshot,
  type TopologyFlowEndIncoming,
  type TopologyNodeRecord,
  type TopologyRecord,
  type WorkspaceSnapshot, toUtcIsoTimestamp,
} from "@shared/types";
import {
  formatAgentDispatchContent,
  parseTargetAgentIds,
} from "@shared/chat-message-format";
import { stripDecisionResponseMarkup } from "@shared/decision-response";
import {
  parseDecision,
  parseDefaultAgentResult,
  type ParsedDecision,
} from "./decision-parser";
import { OpenCodeClient } from "./opencode-client";
import { StoreService } from "./store";
import { resolveAgentStatusFromRouting } from "./gating-rules";
import {
  buildDownstreamForwardedContextFromMessages,
  NONE_MODE_PLACEHOLDER_MESSAGE,
  buildSourceAgentMessageSectionLabel,
  buildUserHistoryContent,
  stripTargetMention,
} from "./message-forwarding";
import {
  reconcileTaskSnapshotFromMessages,
  resolveStandaloneTaskStatusAfterAgentRun,
  shouldFinishTaskFromPersistedState,
} from "./task-lifecycle-rules";
import { TaskRuntime } from "./task-runtime";
import type { GraphDispatchBatch, GraphAgentResult } from "./gating-router";
import type { GraphTaskState } from "./gating-state";
import {
  buildTaskCompletionMessageContent,
  buildTaskRoundFinishedMessageContent,
} from "./task-completion-message";
import {
  buildEffectiveTopology,
  getRuntimeTemplateName,
} from "./runtime-topology-graph";
import type { CompiledTeamDsl } from "./team-dsl";
import { resolveTaskAgentIdsToPrewarm } from "./task-session-prewarm";
import { appendAppLog, bindCurrentTaskLog } from "./app-log";
import {
  extractDslAgentsFromTopology,
  resolveProjectAgents,
} from "./project-agent-source";

type GroupRuleInputBase = Omit<GroupRule, "report">;

type GroupRuleInput =
  | (GroupRuleInputBase & {
      report: GroupRule["report"];
    })
  | (GroupRuleInputBase & {
      reportToTemplateName: string;
    })
  | (GroupRuleInputBase & {
      reportToTemplateName: string;
      reportToTrigger: string;
      reportToMessageMode: "none" | "last";
      reportToMaxTriggerRounds: number;
    })
  | GroupRuleInputBase;

type TopologyInputRecord = Omit<TopologyRecord, "groupRules"> & {
  groupRules?: GroupRuleInput[];
};

function coerceGroupRuleInput(
  rule: GroupRuleInput,
): GroupRule {
  if ("report" in rule) {
    return rule;
  }
  if (!("reportToTemplateName" in rule)) {
    return {
      ...rule,
      report: false,
    };
  }
  if (!("reportToTrigger" in rule)) {
    throw new Error(
      `group rule ${rule.id} 存在 report target 时，必须显式声明 reportToTrigger。`,
    );
  }
  return {
    ...rule,
    report: {
      templateName: rule.reportToTemplateName,
      sourceRole: rule.members.at(-1)?.role ?? rule.entryRole,
      trigger: rule.reportToTrigger,
      messageMode: rule.reportToMessageMode,
      maxTriggerRounds: rule.reportToMaxTriggerRounds,
    },
  };
}

function getTopologyEndIncoming(
  topology: Pick<TopologyRecord, "flow">,
): TopologyFlowEndIncoming[] {
  return topology.flow.end.incoming;
}

interface OrchestratorOptions {
  cwd: string;
  userDataPath: string;
  opencodeClient: OpenCodeClient;
  terminalLauncher: (command: string) => Promise<void>;
}

interface EdgeForwardingConfig {
  messageMode: "none" | "last";
  initialMessageRouting: InitialMessageRouting;
}

type InitialMessageAliasScope =
  | {
      kind: "group";
      groupId: string;
    }
  | {
      kind: "static-only";
    };

interface WorkspaceRecord {
  cwd: string;
  id: string;
}

interface TaskRuntimeOverlay {
  taskId: string;
  attachBaseUrl: string;
  agentSessions: Map<string, string>;
}

type AgentExecutionPrompt =
  | {
      mode: "raw";
      content: string;
      from: string;
    }
  | {
      mode: "control";
      content: string;
    }
  | {
      mode: "structured";
      from: string;
      agentMessage: string;
      omitSourceAgentSectionLabel: boolean;
    };

interface AgentRunBehaviorOptions {
  followTopology?: boolean;
  updateTaskStatusOnStart?: boolean;
  completeTaskOnFinish?: boolean;
}

const idleProcessWorkspace = { cwd: "", refCount: 0 };
let activeProcessWorkspace = idleProcessWorkspace;

function acquireProcessWorkspaceCwd(cwd: string) {
  if (activeProcessWorkspace.refCount === 0) {
    activeProcessWorkspace = {
      cwd,
      refCount: 1,
    };
    return;
  }
  if (activeProcessWorkspace.cwd !== cwd) {
    throw new Error(`当前进程只允许一个 cwd。已有 cwd: ${activeProcessWorkspace.cwd}，拒绝访问: ${cwd}`);
  }
  activeProcessWorkspace = {
    cwd,
    refCount: activeProcessWorkspace.refCount + 1,
  };
}

function releaseProcessWorkspaceCwd(cwd: string) {
  if (activeProcessWorkspace.refCount === 0 || activeProcessWorkspace.cwd !== cwd) {
    return;
  }
  if (activeProcessWorkspace.refCount <= 1) {
    activeProcessWorkspace = idleProcessWorkspace;
    return;
  }
  activeProcessWorkspace = {
    cwd,
    refCount: activeProcessWorkspace.refCount - 1,
  };
}

export function isTerminalTaskStatus(status: TaskRecord["status"]) {
  return status === "finished" || status === "failed";
}

export class Orchestrator {
  readonly store: StoreService;
  readonly opencodeClient: OpenCodeClient;
  readonly cwd: string;
  private readonly runtime = new TaskRuntime({
    host: {
      createBatchRunners: async ({ taskId, state, batch }) =>
        this.createRuntimeBatchRunners(taskId, state, batch),
      completeTask: async (input) => this.completeTask(input),
    },
  });
  private readonly taskRuntimeOverlays = new Map<string, TaskRuntimeOverlay>();
  readonly pendingTaskRuns = new Set<Promise<void>>();
  private readonly terminalLauncher: (command: string) => Promise<void>;
  private isDisposing = false;

  constructor(options: OrchestratorOptions) {
    this.cwd = path.resolve(options.cwd);
    // A single orchestrator process is bound to one workspace root for its whole lifetime.
    acquireProcessWorkspaceCwd(this.cwd);
    this.store = new StoreService();
    this.opencodeClient = options.opencodeClient;
    this.terminalLauncher = options.terminalLauncher;
  }

  async initialize() {
    this.ensureWorkspaceRecord();
  }

  async dispose(
    awaitPendingTaskRuns = true,
  ): Promise<number[]> {
    if (this.isDisposing) {
      return [];
    }
    this.isDisposing = true;
    if (awaitPendingTaskRuns && this.pendingTaskRuns.size > 0) {
      await Promise.allSettled([...this.pendingTaskRuns]);
    } else if (!awaitPendingTaskRuns) {
      this.pendingTaskRuns.clear();
    }
    this.taskRuntimeOverlays.clear();
    try {
      return await this.opencodeClient.shutdown();
    } finally {
      releaseProcessWorkspaceCwd(this.cwd);
    }
  }

  async getWorkspaceSnapshot(): Promise<WorkspaceSnapshot> {
    await this.reconcilePersistedWorkspaceTasks();
    return this.hydrateWorkspace();
  }

  async getTaskSnapshot(): Promise<TaskSnapshot> {
    const task = this.requireCurrentTask();
    const taskId = task.id;
    await this.reconcilePersistedTaskStatus(taskId);
    return this.hydrateTask(taskId);
  }

  private ensureWorkspaceRecord(): WorkspaceRecord {
    this.store.getTopology();
    return {
      cwd: this.cwd,
      id: getWorkspaceNameFromPath(this.cwd),
    };
  }

  async readAgent(agentId: string): Promise<AgentRecord> {
    const matched = this.listWorkspaceAgents().find(
      (agent) => agent.id === agentId,
    );
    if (!matched) {
      throw new Error(`Agent 配置不存在：${agentId}`);
    }
    return matched;
  }

  private listWorkspaceAgents(): AgentRecord[] {
    return resolveProjectAgents({
      dslAgents: extractDslAgentsFromTopology(this.store.getTopology()),
    });
  }

  async saveTopology(
    topology: TopologyInputRecord,
  ): Promise<WorkspaceSnapshot> {
    const agents = this.listWorkspaceAgents();
    const normalized = this.normalizeTopology(agents, topology);
    this.store.upsertTopology(normalized);
    return this.hydrateWorkspace();
  }

  async applyTeamDsl(payload: { compiled: CompiledTeamDsl }): Promise<WorkspaceSnapshot> {
    const normalized = this.normalizeTopology(
      payload.compiled.agents.map((agent) => ({
        id: agent.id,
        prompt: agent.prompt,
        isWritable: agent.isWritable,
      })),
      payload.compiled.topology,
    );
    this.store.upsertTopology(normalized);
    return this.hydrateWorkspace();
  }

  async deleteTask(): Promise<WorkspaceSnapshot> {
    const task = this.requireCurrentTask();
    await this.runtime.deleteTask(task.id);
    this.taskRuntimeOverlays.delete(task.id);
    this.store.deleteTask(task.id);
    return this.hydrateWorkspace();
  }

  async submitTask(payload: SubmitTaskPayload): Promise<TaskSnapshot> {
    const agents = this.listWorkspaceAgents();
    this.syncTopology(agents);
    const topology = this.store.getTopology();
    const defaultTarget = resolvePrimaryTopologyStartTarget(topology);
    const defaultTargetPayload = defaultTarget.kind === "found"
      ? { defaultTargetAgentId: defaultTarget.agentId }
      : {};
    const resolution = resolveTaskSubmissionTarget({
      content: payload.content,
      availableAgents: agents.map((agent) => agent.id),
      ...withOptionalString({}, "mentionAgentId", payload.mentionAgentId),
      ...defaultTargetPayload,
    });
    if (!resolution.ok) {
      throw new Error(resolution.message);
    }
    const mentionAgentId = resolution.targetAgentId;

    if (this.listCurrentTasks().length !== 0) {
      const currentTask = this.requireCurrentTask();
      return this.continueTask(
        currentTask.id,
        payload.content,
        mentionAgentId,
        agents,
      );
    }

    const initialized = await this.createTask(agents, {
      title: this.createTaskTitle(payload.content),
      source: "submit",
    });

    return this.continueTask(
      initialized.task.id,
      payload.content,
      mentionAgentId,
      agents,
    );
  }

  async initializeTask(): Promise<TaskSnapshot> {
    const agents = this.listWorkspaceAgents();
    this.syncTopology(agents);

    return this.createTask(agents, {
      title: "未命名任务",
      source: "initialize",
    });
  }

  async openAgentTerminal(agentId: string) {
    const task = this.requireCurrentTask();
    const snapshot = await this.ensureTaskInitialized(
      task,
      this.listWorkspaceAgents(),
    );
    const taskAgent = snapshot.agents.find(
      (item) => item.id === agentId,
    );
    if (!taskAgent) {
      throw new Error(`未找到 Agent ${agentId} 对应的运行信息。`);
    }
    if (!taskAgent.opencodeSessionId) {
      throw new Error(
        `Agent ${agentId} 当前还没有可 attach 的 OpenCode session。`,
      );
    }
    await this.launchAgentTerminal(
      taskAgent.opencodeSessionId,
      taskAgent.opencodeAttachBaseUrl,
    );
  }

  private async createTask(
    agents: AgentRecord[],
    options: {
      title: string;
      source: "initialize" | "submit";
    },
  ): Promise<TaskSnapshot> {
    this.assertTaskCreationAllowed();
    if (agents.length === 0) {
      throw new Error("当前工作区没有可用的 Agent");
    }

    const taskId = randomUUID();
    const createdAt = new Date().toISOString();

    const task: TaskRecord = {
      id: taskId,
      title: options.title,
      status: "pending",
      cwd: this.cwd,
      agentCount: agents.length,
      createdAt,
      completedAt: "",
      initializedAt: "",
    };

    bindCurrentTaskLog(taskId);
    this.store.insertTask(task);
    for (const agent of agents) {
      this.store.insertTaskAgent({
        taskId,
        id: agent.id,
        opencodeSessionId: "",
        opencodeAttachBaseUrl: "",
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
      timestamp: toUtcIsoTimestamp(new Date().toISOString()),
      kind: "task-created",
    };
    this.store.insertMessage(taskCreatedMessage);

    const snapshot = this.hydrateTask(taskId);
    return snapshot;
  }

  private async continueTask(
    taskId: string,
    content: string,
    mentionAgentId: string,
    agents: AgentRecord[],
  ): Promise<TaskSnapshot> {
    const task = this.store.getTask(taskId);
    if (isTerminalTaskStatus(task.status)) {
      this.store.updateTaskStatus(task.id, "running");
    }

    this.syncTaskAgents(task, agents);
    const targetAgentRecord = agents.find((agent) => agent.id === mentionAgentId);

    if (!targetAgentRecord) {
      throw new Error(`未找到被 @ 的 Agent：${mentionAgentId}`);
    }

    await this.ensureTaskInitialized(task, agents);

    const targetRunCount =
      (this.store
        .listTaskAgents(task.id)
        .find((item) => item.id === targetAgentRecord.id)?.runCount ?? 0) + 1;
    const message = this.createUserMessage(
      task.id,
      task.title,
      content,
      targetAgentRecord.id,
      targetRunCount,
    );
    this.store.insertMessage(message);

    const forwardedContent = stripTargetMention(
      content,
      targetAgentRecord.id,
    );
    const topology = this.store.getTopology();
    this.trackBackgroundTask(
      this.runtime
        .resumeTask({
          taskId: task.id,
          topology,
          event: {
            type: "user_message",
            targetAgentId: targetAgentRecord.id,
            content: forwardedContent,
          },
        })
        .then(() => undefined),
      {
        taskId: task.id,
        agentId: targetAgentRecord.id,
      },
    );
    return this.hydrateTask(task.id);
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

  private requireCurrentTask(): TaskRecord {
    const tasks = this.listCurrentTasks();
    const task = tasks[0];
    if (!task) {
      throw new Error("当前进程没有可用的 Task");
    }
    return task;
  }

  private assertTaskCreationAllowed() {
    if (this.listCurrentTasks().length !== 0) {
      throw new Error("当前进程只允许一个 Task");
    }
  }

  private listCurrentTasks(): TaskRecord[] {
    const tasks = this.store.listTasks();
    if (tasks.length > 1) {
      throw new Error(`当前进程只允许一个 Task，实际存在 ${tasks.length} 个`);
    }
    return tasks;
  }

  private createUserMessage(
    taskId: string,
    taskTitle: string,
    content: string,
    targetAgentId: string,
    targetRunCount: number,
  ): MessageRecord {
    const normalizedContent = buildUserHistoryContent(
      content,
      targetAgentId,
    );
    return {
      id: randomUUID(),
      taskId,
      content: normalizedContent,
      sender: "user",
      timestamp: toUtcIsoTimestamp(this.createTrailingMessageTimestamp(taskId)),
      kind: "user",
      scope: "task",
      taskTitle,
      targetAgentIds: [targetAgentId],
      targetRunCounts: [targetRunCount],
    };
  }

  private syncTaskAgents(task: TaskRecord, agents: AgentRecord[]) {
    const orderedAgents = this.orderAgents(agents);
    const existingByName = new Set(
      this.store.listTaskAgents(task.id).map((item) => item.id),
    );
    for (const agent of orderedAgents) {
      if (existingByName.has(agent.id)) {
        continue;
      }
      this.store.insertTaskAgent({
        taskId: task.id,
        id: agent.id,
        opencodeSessionId: "",
        opencodeAttachBaseUrl: "",
        status: "idle",
        runCount: 0,
      });
    }

    this.store.updateTaskAgentCount(task.id, agents.length);
  }

  private ensureRuntimeTaskAgent(
    task: TaskRecord,
    runtimeAgentId: string,
  ): void {
    const existing = this.store
      .listTaskAgents(task.id)
      .find((item) => item.id === runtimeAgentId);
    if (existing) {
      return;
    }
    this.store.insertTaskAgent({
      taskId: task.id,
      id: runtimeAgentId,
      opencodeSessionId: "",
      opencodeAttachBaseUrl: "",
      status: "idle",
      runCount: 0,
    });
    this.store.updateTaskAgentCount(
      task.id,
      this.store.listTaskAgents(task.id).length,
    );
  }

  protected async runAgent(
    task: TaskRecord,
    agentId: string,
    prompt: AgentExecutionPrompt,
    behavior: AgentRunBehaviorOptions = {},
  ) {
    if (behavior.followTopology) {
      throw new Error(
        "runAgent 已不再负责拓扑调度；请通过 submitTask/continueTask 走 task runtime。",
      );
    }

    const topology = this.store.getTopology();
    const result = await this.executeRuntimeAgentOnce(
      task,
      agentId,
      agentId,
      prompt,
      "",
      topology,
      isDecisionAgentInTopology(topology, agentId),
      [],
      agentId,
    );
    if (!(behavior.completeTaskOnFinish ?? true)) {
      return;
    }

    const latestTask = this.store.getTask(task.id);
    if (isTerminalTaskStatus(latestTask.status)) {
      if (latestTask.status === "failed" && latestTask.completedAt.length === 0) {
        await this.completeTask({
          taskId: task.id,
          status: "failed",
          failureReason: "standalone_agent_failed",
        });
      }
      return;
    }

    const nextTaskStatus = resolveStandaloneTaskStatusAfterAgentRun({
      latestAgentStatus: result.agentStatus,
      agentStatuses: this.store.listTaskAgents(task.id),
    });

    if (nextTaskStatus === "finished") {
      await this.completeTask({
        taskId: task.id,
        status: "finished",
        finishReason: "standalone_round_finished",
      });
      return;
    }

    if (nextTaskStatus === "failed") {
      await this.completeTask({
        taskId: task.id,
        status: "failed",
        failureReason: "standalone_agent_failed",
      });
      return;
    }
  }

  private shouldSuppressDuplicateDispatchMessage(
    taskId: string,
    sourceAgentId: string,
    targetAgentIds: string[],
  ): boolean {
    const now = Date.now();
    const incomingTargets = [...targetAgentIds].sort().join(",");
    const messages = this.store.listMessages(taskId);
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
      if (
        message.sender !== sourceAgentId ||
        message.kind !== "agent-dispatch"
      ) {
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

  private updateTaskStatusIfActive(
    taskId: string,
    status: TaskRecord["status"],
    completedAt = "",
  ): boolean {
    const task = this.store.getTask(taskId);
    if (isTerminalTaskStatus(task.status)) {
      return false;
    }
    this.store.updateTaskStatus(taskId, status, completedAt);
    return true;
  }

  private async reconcilePersistedTaskStatus(taskId: string) {
    const task = this.store.getTask(taskId);
    if (
      !shouldFinishTaskFromPersistedState({
        taskStatus: task.status,
        topology: this.store.getTopology(),
        agents: this.store.listTaskAgents(taskId),
        messages: this.store.listMessages(taskId),
      })
    ) {
      return;
    }

    await this.completeTask({
      taskId,
      status: "finished",
      finishReason: "persisted_round_finished",
    });
  }

  private async reconcilePersistedWorkspaceTasks() {
    for (const task of this.store.listTasks()) {
      await this.reconcilePersistedTaskStatus(task.id);
    }
  }

  private parseSignal(content: string): boolean {
    return /\bTASK_DONE\b/i.test(content);
  }

  protected buildAgentExecutionPrompt(prompt: AgentExecutionPrompt): string {
    // 历史要求：raw prompt 的来源必须由构造入口显式传入，渲染阶段不得用默认值掩盖缺失来源。
    if (prompt.mode === "raw") {
      const content = prompt.content.trim();
      const from = prompt.from.trim();
      return `[${from}] ${content || "（无）"}`.trim();
    }

    if (prompt.mode === "control") {
      return prompt.content.trim() || "（无）";
    }

    const content = prompt.agentMessage.trim();
    if (!content) {
      throw new Error(`${prompt.from} 的 structured prompt 缺少正文`);
    }
    return prompt.omitSourceAgentSectionLabel
      ? content
      : `${buildSourceAgentMessageSectionLabel(prompt.from)}\n${content}`;
  }

  // 用户要求：allowedTriggers 必须显式传入 resolveAgentContextContent，避免上下文缺失被空集合掩盖。
  private resolveAgentContextContent(
    parsedDecision: ParsedDecision,
    rawFinalMessage: string,
    allowedTriggers: readonly string[],
  ): string {
    const candidates = [
      parsedDecision.kind === "valid" ? parsedDecision.contentWithoutTrigger.trim() : "",
      stripDecisionResponseMarkup(rawFinalMessage, allowedTriggers).trim(),
    ];

    return candidates.find((item) => item.length > 0) ?? "";
  }

  private resolveAllowedDecisionTriggers(input: {
    topology: Pick<TopologyRecord, "edges" | "flow">;
    runtimeAgentId: string;
    executableAgentId: string;
  }): string[] {
    const sourceAgentIds = [
      ...new Set([input.runtimeAgentId, input.executableAgentId]),
    ];
    const allowed: string[] = [];
    const push = (trigger: string) => {
      if (allowed.includes(trigger)) {
        return;
      }
      allowed.push(trigger);
    };

    for (const trigger of collectTopologyTriggerShapes({
      edges: input.topology.edges,
      endIncoming: input.topology.flow.end.incoming,
    })) {
      if (!sourceAgentIds.includes(trigger.source)) {
        continue;
      }
      push(trigger.trigger);
    }

    return allowed;
  }

  protected createDisplayContent(parsedDecision: ParsedDecision): string {
    if (parsedDecision.kind === "invalid") {
      return parsedDecision.validationError;
    }
    const contentWithoutTrigger = parsedDecision.contentWithoutTrigger.trim();
    if (contentWithoutTrigger) {
      return contentWithoutTrigger;
    }

    return "";
  }

  private resolveParsedDecisionValue(input: {
    parsedDecision: ParsedDecision;
    decisionAgent: boolean;
    topology: Pick<TopologyRecord, "edges" | "flow">;
    sourceAgentIds: string[];
  }): AgentRoutingKind {
    if (input.parsedDecision.kind === "invalid") {
      return "invalid";
    }
    if (!input.decisionAgent) {
      return "default";
    }

    for (const sourceAgentId of input.sourceAgentIds) {
      const resolved = resolveTriggerRoutingKindForSource(
        input.topology,
        sourceAgentId,
        input.parsedDecision.trigger,
      );
      if (resolved.kind === "triggered") {
        return "triggered";
      }
    }

    return "invalid";
  }

  private ensureTaskRuntimeOverlay(taskId: string): TaskRuntimeOverlay {
    const existing = this.taskRuntimeOverlays.get(taskId);
    if (existing) {
      return existing;
    }

    const created: TaskRuntimeOverlay = {
      taskId,
      attachBaseUrl: "",
      agentSessions: new Map(),
    };
    this.taskRuntimeOverlays.set(taskId, created);
    return created;
  }

  private setTaskAttachBaseUrl(
    taskId: string,
    attachBaseUrl: string,
  ) {
    const overlay = this.ensureTaskRuntimeOverlay(taskId);
    this.taskRuntimeOverlays.set(taskId, {
      ...overlay,
      attachBaseUrl,
    });
  }

  private overlayTaskAgents(
    task: TaskRecord,
    agents: TaskAgentRecord[],
  ): TaskAgentRecord[] {
    const overlay = this.taskRuntimeOverlays.get(task.id);
    return agents.map((agent) => ({
      ...agent,
      opencodeSessionId: overlay?.agentSessions.get(agent.id) ?? "",
      opencodeAttachBaseUrl: overlay ? overlay.attachBaseUrl : "",
    }));
  }

  protected async ensureAgentSession(
    task: TaskRecord,
    agent: TaskAgentRecord,
  ): Promise<string> {
    const overlay = this.ensureTaskRuntimeOverlay(task.id);
    const existingSessionId = overlay.agentSessions.get(agent.id) ?? "";
    if (existingSessionId) {
      return existingSessionId;
    }
    await this.ensureTaskServer(task.id);
    const sessionId = await this.opencodeClient.createSession(
      agent.id,
    );
    overlay.agentSessions.set(agent.id, sessionId);
    return sessionId;
  }

  protected async ensureTaskPanels(task: TaskRecord) {
    await this.ensureTaskInitialized(task, this.listWorkspaceAgents());
  }

  private async ensureTaskServer(
    taskId: string,
  ): Promise<void> {
    const overlay = this.ensureTaskRuntimeOverlay(taskId);
    if (overlay.attachBaseUrl) {
      return;
    }
    const existingAttachBaseUrl = [...this.taskRuntimeOverlays.values()]
      .find((currentOverlay) => currentOverlay.attachBaseUrl)?.attachBaseUrl ?? "";
    if (existingAttachBaseUrl) {
      this.setTaskAttachBaseUrl(taskId, existingAttachBaseUrl);
      return;
    }
    this.setTaskAttachBaseUrl(taskId, await this.opencodeClient.getAttachBaseUrl());
  }

  private async ensureTaskAgentSessions(
    task: TaskRecord,
  ): Promise<void> {
    const topology = this.store.getTopology();
    const prewarmAgentIds = new Set(
      resolveTaskAgentIdsToPrewarm(
        topology,
        this.store.listTaskAgents(task.id),
      ),
    );
    await Promise.all(
      this.store
        .listTaskAgents(task.id)
        .filter((agent) => prewarmAgentIds.has(agent.id))
        .map(
          async (agent) => this.ensureAgentSession(task, agent),
        ),
    );
  }

  private async ensureTaskInitialized(
    task: TaskRecord,
    agents: AgentRecord[],
  ): Promise<TaskSnapshot> {
    this.syncTaskAgents(task, agents);
    const currentTask = this.store.getTask(task.id);
    await this.ensureTaskServer(currentTask.id);
    await this.ensureTaskAgentSessions(currentTask);

    const refreshedTask = this.store.getTask(task.id);
    if (!refreshedTask.initializedAt) {
      this.store.updateTaskInitialized(
        task.id,
        new Date().toISOString(),
      );
    }

    return this.hydrateTask(task.id);
  }

  private orderAgents(
    agents: AgentRecord[],
    topologyOverride?: TopologyRecord,
  ): AgentRecord[] {
    const topology = topologyOverride ?? this.store.getTopology();
    const orderedNames = resolveTopologyAgentOrder(
      agents.map((agent) => agent.id),
      topology.nodes,
    );
    const agentByName = new Map(agents.map((agent) => [agent.id, agent]));
    return orderedNames
      .map((name) => agentByName.get(name))
      .filter((agent): agent is AgentRecord => Boolean(agent));
  }

  private async launchAgentTerminal(
    opencodeSessionId: string,
    sessionAttachBaseUrl: string,
  ) {
    if (!sessionAttachBaseUrl) {
      throw new Error("当前 Agent 还没有可 attach 的 OpenCode 地址。");
    }
    const attachCommand = buildCliOpencodeAttachCommand(
      sessionAttachBaseUrl,
      opencodeSessionId,
    );
    await this.terminalLauncher(attachCommand);
  }

  private createTaskTitle(content: string): string {
    const firstLine = content
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find(Boolean);
    return (firstLine ?? "未命名任务").slice(0, 80);
  }

  private resolveExecutableAgentId(
    state: GraphTaskState,
    runtimeAgentId: string,
  ): string {
    const availableAgents = this.listWorkspaceAgents();
    if (availableAgents.some((agent) => agent.id === runtimeAgentId)) {
      return runtimeAgentId;
    }

    const templateName = getRuntimeTemplateName(state, runtimeAgentId);
    if (
      templateName &&
      availableAgents.some((agent) => agent.id === templateName)
    ) {
      return templateName;
    }

    return runtimeAgentId;
  }

  private resolveMessageSenderDisplayName(
    state: GraphTaskState,
    runtimeAgentId: string,
  ): string {
    return (
      state.runtimeNodes.find((node) => node.id === runtimeAgentId)
        ?.displayName ?? runtimeAgentId
    );
  }

  private hydrateWorkspace(forceSyncTopology = false): WorkspaceSnapshot {
    const workspace = this.ensureWorkspaceRecord();
    const agents = this.listWorkspaceAgents();
    const topology = forceSyncTopology
      ? this.syncTopology(agents)
      : this.ensureTopologyExists(agents);
    const tasks = this.store.listTasks();
    for (const task of tasks) {
      this.syncTaskAgents(task, agents);
    }

    return {
      cwd: workspace.cwd,
      name: workspace.id,
      agents,
      topology,
      messages: this.store.listMessages(),
      tasks: tasks.map((task) => this.hydrateTask(task.id)),
    };
  }

  private hydrateTask(taskId: string): TaskSnapshot {
    const task = this.store.getTask(taskId);
    const agents = this.listWorkspaceAgents();
    this.syncTaskAgents(task, agents);
    const persistedAgents = this.store.listTaskAgents(taskId);
    const messages = this.store.listMessages(taskId);
    const reconciled = reconcileTaskSnapshotFromMessages({
      task: this.store.getTask(taskId),
      agents: this.overlayTaskAgents(task, persistedAgents),
      messages,
    });
    return {
      task: reconciled.task,
      agents: reconciled.agents,
      messages,
      topology: this.store.getTopology(),
    };
  }

  private ensureTopologyExists(
    agents: AgentRecord[],
  ): TopologyRecord {
    const current = this.store.getTopology();
    if (current.nodes.length === 0 && current.edges.length === 0) {
      return createDefaultTopology(agents.map((agent) => agent.id));
    }
    return this.normalizeTopology(agents, current);
  }

  private syncTopology(agents: AgentRecord[]): TopologyRecord {
    const current = this.store.getTopology();
    const next =
      current.nodes.length === 0 && current.edges.length === 0
        ? createDefaultTopology(agents.map((agent) => agent.id))
        : this.normalizeTopology(agents, current);

    this.store.upsertTopology(next);
    return next;
  }

  private normalizeTopology(
    agents: AgentRecord[],
    topology: TopologyInputRecord,
  ): TopologyRecord {
    const validNames = new Set(agents.map((item) => item.id));
    const agentByName = new Map(agents.map((agent) => [agent.id, agent]));
    if (!topology.nodeRecords || topology.nodeRecords.length === 0) {
      throw new Error("拓扑缺少 nodeRecords，无法继续运行。");
    }
    const rawNodeRecords: TopologyNodeRecord[] = topology.nodeRecords;
    const groupNodeIds = new Set(
      rawNodeRecords
        .filter((node) => node.kind === "group" && node.id)
        .map((node) => node.id),
    );
    const validTopologyNames = new Set([...validNames, ...groupNodeIds]);
    const seenEdges = new Set<string>();
    const normalizedEdges = topology.edges
      .map((edge) => {
        const trigger = normalizeTopologyEdgeTrigger(edge.trigger);
        return {
          ...edge,
          trigger,
        };
      })
      .filter(
        (edge) =>
          validTopologyNames.has(edge.source) &&
          (validTopologyNames.has(edge.target) ||
            edge.target === FLOW_END_NODE_ID),
      )
      .filter((edge) => {
        const key = getTopologyEdgeId(edge);
        if (seenEdges.has(key)) {
          return false;
        }
        seenEdges.add(key);
        return true;
      });
    const endIncomingFromEdges = normalizedEdges
      .filter((edge) => edge.target === FLOW_END_NODE_ID)
      .map((edge) => ({
        source: edge.source,
        trigger: edge.trigger,
      }));
    const edges = normalizedEdges
      .filter((edge) => edge.target !== FLOW_END_NODE_ID)
      .map((edge) => ({
        source: edge.source,
        target: edge.target,
        trigger: edge.trigger,
        messageMode: edge.messageMode,
        maxTriggerRounds: normalizeMaxTriggerRounds(edge.maxTriggerRounds),
      }));
    const orderedAgentNodes = resolveTopologyAgentOrder(
      agents.map((agent) => agent.id),
      topology.nodes.filter((item) => validNames.has(item)),
    );
    const nodes = [
      ...orderedAgentNodes,
      ...topology.nodes.filter((item) => groupNodeIds.has(item)),
      ...groupNodeIds,
    ].filter((value, index, list) => list.indexOf(value) === index);
    const normalizedNodeRecords = rawNodeRecords
      .filter(
        (node) =>
          node.id &&
          node.templateName &&
          (node.kind === "group" || validNames.has(node.templateName)),
      )
      .map((node) => {
        const prompt =
          node.kind === "agent"
            ? agentByName.get(node.templateName)?.prompt
            : typeof node.prompt === "string"
              ? node.prompt
              : undefined;
        const writable =
          node.kind === "agent"
            ? agentByName.get(node.templateName)?.isWritable === true
            : node.writable === true;

        return {
          id: node.id,
          kind: node.kind,
          templateName: node.templateName,
          initialMessageRouting: node.initialMessageRouting,
          ...(node.groupRuleId ? { groupRuleId: node.groupRuleId } : {}),
          ...(node.groupEnabled === true ? { groupEnabled: true } : {}),
          ...(typeof prompt === "string" ? { prompt } : {}),
          ...(writable ? { writable: true } : {}),
        };
      });
    const normalizedGroupRules = topology.groupRules?.map((rule) => {
      const groupNodeName =
        rule.groupNodeName ||
        normalizedNodeRecords.find((node) => node.groupRuleId === rule.id)?.id ||
        rule.id;
      return normalizeGroupRule(
        coerceGroupRuleInput(rule),
        groupNodeName,
      );
    });
    const groupRules: GroupRule[] | undefined = normalizedGroupRules?.filter((rule) =>
      rule.id
      && rule.groupNodeName
      && rule.entryRole
      && validTopologyNames.has(rule.groupNodeName)
      && (!rule.sourceTemplateName || validNames.has(rule.sourceTemplateName))
      && (rule.report === false || validNames.has(rule.report.templateName))
      && rule.members.every(
        (agent) => agent.role && validNames.has(agent.templateName),
      ),
    );
    const explicitEndIncoming = getTopologyEndIncoming(topology).filter(
      (edge) =>
        validTopologyNames.has(edge.source) && typeof edge.trigger === "string",
    );
    const explicitStartTarget = resolvePrimaryTopologyStartTarget(topology);
    const endIncoming = [...explicitEndIncoming, ...endIncomingFromEdges];
    const startTargets = topology.flow.start.targets.length > 0
      ? topology.flow.start.targets
      : explicitStartTarget.kind === "found"
        ? [explicitStartTarget.agentId]
        : [];
    const flow = createTopologyFlowRecord({
      nodes,
      edges,
      startTargets,
      endIncoming,
    });
    collectTopologyTriggerShapes({
      edges,
      endIncoming: flow.end.incoming,
    });
    const nodeRecords = buildTopologyNodeRecords({
      nodes,
      groupNodeIds: new Set(
        normalizedNodeRecords
          .filter((node) => node.kind === "group")
          .map((node) => node.id),
      ),
      templateNameByNodeId: new Map(
        normalizedNodeRecords.map((node) => [node.id, node.templateName]),
      ),
      initialMessageRoutingByNodeId: new Map(
        normalizedNodeRecords.map((node) => [node.id, node.initialMessageRouting]),
      ),
      groupRuleIdByNodeId: new Map(
        normalizedNodeRecords
          .filter((node) => typeof node.groupRuleId === "string")
          .map((node) => [node.id, node.groupRuleId as string]),
      ),
      groupEnabledNodeIds: new Set(
        normalizedNodeRecords
          .filter((node) => node.groupEnabled === true)
          .map((node) => node.id),
      ),
      promptByNodeId: new Map(
        normalizedNodeRecords
          .filter((node) => typeof node.prompt === "string")
          .map((node) => [node.id, node.prompt as string]),
      ),
      writableNodeIds: new Set(
        normalizedNodeRecords
          .filter((node) => node.writable === true)
          .map((node) => node.id),
      ),
    });

    return {
      nodes,
      edges,
      flow,
      nodeRecords,
      ...(groupRules ? { groupRules } : {}),
    } satisfies TopologyRecord;
  }

  private resolveDispatchInitialMessageRouting(
    targetAgentRunCount: number,
    routing: InitialMessageRouting,
  ): InitialMessageRouting {
    if (routing.mode !== "list") {
      return routing;
    }
    if (targetAgentRunCount > 0) {
      return { mode: "none" };
    }
    return routing;
  }

  private resolveInitialMessageSourceAliases(
    state: GraphTaskState,
    sourceAgentId: string,
    targetAgentId: string,
    routing: InitialMessageRouting,
  ): Record<string, string[]> {
    if (routing.mode !== "list") {
      return {};
    }
    const targetRuntimeNode = state.runtimeNodes.find((node) => node.id === targetAgentId);
    const sourceRuntimeNode = state.runtimeNodes.find((node) => node.id === sourceAgentId);
    const scope: InitialMessageAliasScope =
      targetRuntimeNode?.groupId
        ? { kind: "group", groupId: targetRuntimeNode.groupId }
        : sourceRuntimeNode?.groupId
          ? { kind: "group", groupId: sourceRuntimeNode.groupId }
          : { kind: "static-only" };
    return Object.fromEntries(
      routing.agentIds.map((agentId) => [
        agentId,
        this.resolveInitialMessageAliasesForAgent(
          state,
          scope,
          agentId,
        ),
      ]),
    );
  }

  private resolveInitialMessageAliasesForAgent(
    state: GraphTaskState,
    scope: InitialMessageAliasScope,
    agentId: string,
  ): string[] {
    const runtimeNodes = scope.kind === "group"
      ? state.runtimeNodes.filter((node) => node.groupId === scope.groupId)
      : [];
    const aliases = new Set<string>([agentId.trim()]);
    for (const node of runtimeNodes) {
      if (
        node.id !== agentId &&
        node.templateName !== agentId &&
        node.displayName !== agentId
      ) {
        continue;
      }
      aliases.add(node.id.trim());
      aliases.add(node.templateName.trim());
      aliases.add(node.displayName.trim());
    }
    return [...aliases].filter(Boolean);
  }

  protected async createRuntimeBatchRunners(
    taskId: string,
    state: GraphTaskState,
    batch: GraphDispatchBatch,
  ) {
    const task = this.store.getTask(taskId);
    const taskMessages = this.store.listMessages(taskId);

    if (
      batch.jobs.every(
        (job) => job.kind === "transfer" || job.kind === "dispatch",
      )
    ) {
      if (batch.source.kind !== "agent") {
        throw new Error("拓扑自动派发缺少来源 Agent，无法构造派发消息。");
      }
      const sourceAgentId = batch.source.agentId;
      if (
        !this.shouldSuppressDuplicateDispatchMessage(
          taskId,
          sourceAgentId,
          batch.triggerTargets,
        )
      ) {
        const targetRunCounts = batch.jobs.map(
          (job) =>
            (this.store
              .listTaskAgents(taskId)
              .find((item) => item.id === job.agentId)?.runCount ?? 0) + 1,
        );
        const triggerMessage: MessageRecord = {
          id: randomUUID(),
          taskId,
          sender: sourceAgentId,
          timestamp: toUtcIsoTimestamp(new Date().toISOString()),
          content: formatAgentDispatchContent(
            batch.displayContent,
            batch.triggerTargets,
          ),
          kind: "agent-dispatch",
          targetAgentIds: [...batch.triggerTargets],
          targetRunCounts,
          dispatchDisplayContent: batch.displayContent,
          senderDisplayName: this.resolveMessageSenderDisplayName(
            state,
            sourceAgentId,
          ),
        };
        this.store.insertMessage(triggerMessage);
      }
    }

    return batch.jobs.map((job) => {
      this.ensureRuntimeTaskAgent(task, job.agentId);
      const executableAgentId = this.resolveExecutableAgentId(
        state,
        job.agentId,
      );
      const topology = buildEffectiveTopology(state);
      const decisionAgent = isDecisionAgentInTopology(topology, job.agentId)
        || (
          job.agentId !== executableAgentId
          && isDecisionAgentInTopology(topology, executableAgentId)
        );
      let prompt: AgentExecutionPrompt;
      let forwardedAgentMessage = "";
      if (job.kind === "raw") {
        prompt = {
          mode: "raw",
          from: "User",
          content: batch.sourceContent,
        };
      } else {
        if (batch.source.kind !== "agent") {
          throw new Error("拓扑自动派发缺少来源 Agent，无法构造转发消息。");
        }
        const sourceAgentId = batch.source.agentId;
        const edgeForwardingConfig = this.getEdgeForwardingConfig(
          topology,
          sourceAgentId,
          job.agentId,
          batch.routingKind === "default"
            ? DEFAULT_TOPOLOGY_TRIGGER
            : batch.trigger,
        );
        // 历史要求：读取 Task Agent 运行次数前必须显式证明记录存在，不得用 0 兜底掩盖状态缺失。
        const taskAgent = this.store
          .listTaskAgents(taskId)
          .find((agent) => agent.id === job.agentId);
        if (!taskAgent) {
          throw new Error(
            `Task ${taskId} 缺少 Agent ${job.agentId}，无法解析初始消息路由。`,
          );
        }
        const dispatchInitialMessageRouting =
          this.resolveDispatchInitialMessageRouting(
            taskAgent.runCount,
            edgeForwardingConfig.initialMessageRouting,
          );
        const initialMessageSourceAliasesByAgentId =
          this.resolveInitialMessageSourceAliases(
            state,
            sourceAgentId,
            job.agentId,
            dispatchInitialMessageRouting,
          );
        const forwardedContext = buildDownstreamForwardedContextFromMessages(
          taskMessages,
          batch.sourceContent,
          {
            messageMode: edgeForwardingConfig.messageMode,
            initialMessageRouting: dispatchInitialMessageRouting,
            sourceAgentId,
            initialMessageSourceAliasesByAgentId,
            globalSourceOrder: buildEffectiveTopology(state).nodes,
          },
        );
        prompt =
          forwardedContext.kind === "empty"
            ? {
                mode: "control",
                content: NONE_MODE_PLACEHOLDER_MESSAGE,
              }
            : {
                mode: "structured",
                from: sourceAgentId,
                agentMessage: forwardedContext.agentMessage,
                omitSourceAgentSectionLabel: true,
              };
        forwardedAgentMessage =
          forwardedContext.kind === "empty" ? "" : forwardedContext.agentMessage;
      }
      return {
        agentId: job.agentId,
        promise: this.executeRuntimeAgentOnce(
          task,
          job.agentId,
          executableAgentId,
          prompt,
          forwardedAgentMessage,
          topology,
          decisionAgent,
          decisionAgent
            ? this.resolveAllowedDecisionTriggers({
                topology,
                runtimeAgentId: job.agentId,
                executableAgentId,
              })
            : [],
          this.resolveMessageSenderDisplayName(
            state,
            job.agentId,
          ),
        ),
      };
    });
  }

  private async executeRuntimeAgentOnce(
    task: TaskRecord,
    runtimeAgentId: string,
    executableAgentId: string,
    prompt: AgentExecutionPrompt,
    forwardedAgentMessage: string,
    topology: TopologyRecord,
    decisionAgent: boolean,
    allowedDecisionTriggers: string[],
    senderDisplayName: string,
  ): Promise<GraphAgentResult> {
    this.store.updateTaskAgentRun(task.id, runtimeAgentId, "running");
    this.updateTaskStatusIfActive(task.id, "running");
    const currentAgent = this.store
      .listTaskAgents(task.id)
      .find((item) => item.id === runtimeAgentId);
    if (!currentAgent) {
      const missingAgentMessage: MessageRecord = {
        id: randomUUID(),
        taskId: task.id,
        content: `[${runtimeAgentId}] 执行失败：Task ${task.id} 缺少 Agent ${runtimeAgentId}`,
        sender: "system",
        timestamp: toUtcIsoTimestamp(new Date().toISOString()),
        kind: "system-message",
      };
      this.store.insertMessage(missingAgentMessage);
      this.updateTaskStatusIfActive(task.id, "failed");
      return {
        agentId: runtimeAgentId,
        messageId: missingAgentMessage.id,
        status: "failed",
        decisionAgent: false,
        routingKind: "invalid",
        agentStatus: "failed",
        agentContextContent: "",
        forwardedAgentMessage: "",
        signalDone: false,
        errorMessage: `Task ${task.id} 缺少 Agent ${runtimeAgentId}`,
      };
    }

    try {
      const currentTask = this.store.getTask(task.id);
      await this.ensureTaskPanels(currentTask);
      const agentSessionId = await this.ensureAgentSession(
        currentTask,
        currentAgent,
      );
      const latestAgent = this.listWorkspaceAgents().find(
        (agent) => agent.id === executableAgentId,
      );
      if (!latestAgent) {
        throw new Error(`当前工作区缺少 Agent ${executableAgentId}`);
      }

      const dispatchedContent = this.buildAgentExecutionPrompt(prompt);
      const response = await this.opencodeClient.submitMessage(agentSessionId, {
        agent: executableAgentId,
        runtimeAgent: runtimeAgentId,
        content: dispatchedContent,
        allowedDecisionTriggers,
      });

      const parsedDecision = decisionAgent
        ? parseDecision(response.finalMessage, allowedDecisionTriggers)
        : parseDefaultAgentResult(response.finalMessage);
      const resolvedDecision = this.resolveParsedDecisionValue({
        parsedDecision,
        decisionAgent,
        topology,
        sourceAgentIds: [runtimeAgentId, executableAgentId],
      });
      const agentContextContent = this.resolveAgentContextContent(
        parsedDecision,
        response.finalMessage,
        allowedDecisionTriggers,
      );
      const displayContent = this.createDisplayContent(parsedDecision);
      if (!displayContent && !(decisionAgent && parsedDecision.kind === "valid")) {
        throw new Error(`${runtimeAgentId} 未返回可展示的结果正文`);
      }
      const baseTaskMessage: Omit<AgentFinalMessageRecord, "routingKind" | "trigger"> = {
        id: response.messageId,
        taskId: task.id,
        content: displayContent,
        sender: runtimeAgentId,
        timestamp: toUtcIsoTimestamp(response.timestamp),
        kind: "agent-final",
        runCount: currentAgent.runCount,
        status: "completed",
        responseNote: displayContent,
        rawResponse: response.finalMessage,
        senderDisplayName,
      };
      let taskMessage: MessageRecord;
      if (resolvedDecision === "triggered" && parsedDecision.kind === "valid") {
        taskMessage = {
          ...baseTaskMessage,
          routingKind: "triggered",
          trigger: parsedDecision.trigger,
        } satisfies MessageRecord;
      } else if (resolvedDecision === "default") {
        taskMessage = {
          ...baseTaskMessage,
          routingKind: "default",
        } satisfies MessageRecord;
      } else {
        taskMessage = {
          ...baseTaskMessage,
          routingKind: "invalid",
        } satisfies MessageRecord;
      }
      this.store.insertMessage(taskMessage);
      // 历史要求：拓扑里渲染的 agent final message 必须同步写入任务日志，每条消息只占一行。
      appendAppLog("info", "agent.final_message", {
        agentId: runtimeAgentId,
        messageId: taskMessage.id,
        runCount: currentAgent.runCount,
        routingKind: taskMessage.routingKind,
        content: taskMessage.content.replace(/\s+/gu, " ").trim(),
      }, "file-only");

      const agentStatus = resolveAgentStatusFromRouting({
        routingKind: resolvedDecision,
      });
      this.store.updateTaskAgentStatus(
        task.id,
        runtimeAgentId,
        agentStatus,
      );
      if (agentStatus === "failed") {
        this.updateTaskStatusIfActive(task.id, "failed");
      } else {
        this.updateTaskStatusIfActive(task.id, "running");
      }

      const signalDone = this.parseSignal(response.finalMessage);
      const baseGraphAgentResult = {
        agentId: runtimeAgentId,
        messageId: taskMessage.id,
        status: "completed" as const,
        decisionAgent,
        agentStatus,
        agentContextContent,
        forwardedAgentMessage,
        signalDone,
      };
      if (resolvedDecision === "triggered" && parsedDecision.kind === "valid") {
        const triggeredResult: GraphAgentResult = {
          ...baseGraphAgentResult,
          routingKind: "triggered",
          trigger: parsedDecision.trigger,
        };
        return triggeredResult;
      }
      if (resolvedDecision === "default") {
        const defaultResult: GraphAgentResult = {
          ...baseGraphAgentResult,
          routingKind: "default",
        };
        return defaultResult;
      }
      const invalidResult: GraphAgentResult = {
        ...baseGraphAgentResult,
        routingKind: "invalid",
      };
      return invalidResult;
    } catch (error) {
      this.store.updateTaskAgentStatus(
        task.id,
        runtimeAgentId,
        "failed",
      );
      const failedMessage: MessageRecord = {
        id: randomUUID(),
        taskId: task.id,
        content: `[${runtimeAgentId}] 执行失败：${error instanceof Error ? error.message : "未知错误"}`,
        sender: "system",
        timestamp: toUtcIsoTimestamp(new Date().toISOString()),
        kind: "system-message",
      };
      this.store.insertMessage(failedMessage);
      this.updateTaskStatusIfActive(task.id, "failed");

      return {
        agentId: runtimeAgentId,
        messageId: failedMessage.id,
        status: "failed",
        decisionAgent,
        routingKind: "invalid",
        agentStatus: "failed",
        agentContextContent: "",
        forwardedAgentMessage: "",
        signalDone: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async completeTask(
    input:
      | {
          taskId: string;
          status: "finished";
          finishReason: string;
        }
      | {
          taskId: string;
          status: "failed";
          failureReason: string;
        },
  ) {
    // 2026-05-27: 用户要求“本轮已完成，可继续 @Agent 发起下一轮。”必须同步打印任务日志。
    const { taskId, status } = input;
    const currentTask = this.store.getTask(taskId);
    if (currentTask.status === status && currentTask.completedAt) {
      return;
    }

    const completedAt = new Date().toISOString();
    this.store.updateTaskStatus(taskId, status, completedAt);
    const snapshot = this.hydrateTask(taskId);
    const completionTimestamp = this.createTrailingMessageTimestamp(
      taskId,
    );
    const completionMessage: MessageRecord =
      status === "finished"
        ? {
            id: randomUUID(),
            taskId,
            sender: "system",
            timestamp: toUtcIsoTimestamp(completionTimestamp),
            content: buildTaskRoundFinishedMessageContent(),
            kind: "task-round-finished",
            finishReason: input.finishReason,
          }
        : {
            id: randomUUID(),
            taskId,
            sender: "system",
            timestamp: toUtcIsoTimestamp(completionTimestamp),
            content: buildTaskCompletionMessageContent(
              {
                status,
                taskTitle: snapshot.task.title,
                failureReason: input.failureReason,
              },
            ),
            kind: "task-completed",
            status: "failed",
          };
    this.store.insertMessage(completionMessage);
    if (completionMessage.kind === "task-round-finished") {
      appendAppLog("info", "task.round_finished", {
        messageId: completionMessage.id,
        finishReason: completionMessage.finishReason,
        content: completionMessage.content,
      }, "file-only");
    }
  }

  private createTrailingMessageTimestamp(taskId: string): string {
    const nowMs = Date.now();
    const messages = this.store.listMessages(taskId);
    const [latestMessage] = messages.slice(-1);
    if (!latestMessage) {
      return new Date(nowMs).toISOString();
    }

    const latestMs = Date.parse(latestMessage.timestamp);
    const nextMs = Number.isFinite(latestMs)
      ? Math.max(nowMs, latestMs + 1)
      : nowMs;
    return new Date(nextMs).toISOString();
  }

  protected getEdgeForwardingConfig(
    topology: TopologyRecord,
    sourceAgentId: string,
    targetAgentId: string,
    trigger: string,
  ): EdgeForwardingConfig {
    const edge = topology.edges.find(
      (item) =>
        item.source === sourceAgentId &&
        item.target === targetAgentId &&
        item.trigger === trigger,
    );
    const topologyNodeRecords = getTopologyNodeRecords(topology);
    if (edge) {
      const targetNode = topologyNodeRecords.find(
        (node) => node.id === targetAgentId,
      );
      if (!targetNode) {
        throw new Error(`拓扑缺少目标节点记录：${targetAgentId}`);
      }
      return {
        messageMode: edge.messageMode,
        initialMessageRouting: targetNode.initialMessageRouting,
      };
    }

    const targetNode = topologyNodeRecords.find(
      (node) => node.id === targetAgentId,
    );
    if (targetNode) {
      const inheritedEdge = topology.edges.find(
        (item) =>
          item.source === sourceAgentId &&
          item.target === targetNode.templateName &&
          item.trigger === trigger,
      );
      if (inheritedEdge) {
        return {
          messageMode: inheritedEdge.messageMode,
          initialMessageRouting: targetNode.initialMessageRouting,
        };
      }
    }

    throw new Error(
      `拓扑边不存在，无法解析转发配置：${sourceAgentId} -> ${targetAgentId} (${trigger})`,
    );
  }

}
