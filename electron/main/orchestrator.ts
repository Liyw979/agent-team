import { BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { IPC_CHANNELS } from "@shared/ipc";
import {
  type AgentFlowEvent,
  type AgentRuntimeSnapshot,
  BUILD_AGENT_NAME,
  createDefaultTopology,
  type AgentFileRecord,
  type CreateProjectPayload,
  type DeleteTaskPayload,
  type GetTaskRuntimePayload,
  type InitializeTaskPayload,
  isBuiltinAgentPath,
  getProjectNameFromPath,
  type MessageRecord,
  type OpenAgentPanePayload,
  type OpenTaskSessionPayload,
  type ProjectRecord,
  type ProjectSnapshot,
  type ReadAgentFilePayload,
  resolveTopologyAgentOrder,
  resolveTopologyStartAgent,
  type SubmitTaskPayload,
  type TaskAgentRecord,
  type TaskPanelRecord,
  type TaskRecord,
  type TaskSnapshot,
  type TopologyRecord,
  type UpdateTopologyPayload,
  isReviewAgentInTopology,
} from "@shared/types";
import {
  formatHighLevelTriggerContent,
  formatRevisionRequestContent,
} from "@shared/chat-message-format";
import { buildZellijMissingReminder } from "@shared/zellij";
import { AgentFileService } from "./agent-files";
import { buildAgentSystemPrompt } from "./agent-system-prompt";
import { OpenCodeClient } from "./opencode-client";
import { OpenCodeRunner } from "./opencode-runner";
import { StoreService } from "./store";
import { ZellijManager } from "./zellij-manager";

const execFileAsync = promisify(execFile);

interface OrchestratorOptions {
  userDataPath: string;
  autoOpenTaskSession?: boolean;
  enableEventStream?: boolean;
  zellijManager?: ZellijManager;
}

interface ParsedSignal {
  done: boolean;
}

type ReviewDecision = "pass" | "needs_revision" | "unknown";

interface ParsedReview {
  cleanContent: string;
  decision: ReviewDecision;
  feedback: string | null;
  rawDecisionBlock: string | null;
}

interface TaskRuntimeState {
  completedEdges: Set<string>;
  lastSignatureByAgent: Map<string, string>;
  runningAgents: Set<string>;
  queuedAgents: Set<string>;
  queuedPromptsByAgent: Map<string, AgentExecutionPrompt>;
}

type AgentExecutionPrompt =
  | {
      mode: "raw";
      content: string;
      from?: string;
    }
  | {
      mode: "structured";
      from: string;
      userMessage?: string;
      agentMessage?: string;
      requirement?: string;
    };

interface AgentRunBehaviorOptions {
  followTopology?: boolean;
  updateTaskStatusOnStart?: boolean;
  completeTaskOnFinish?: boolean;
}

export class Orchestrator {
  private readonly store: StoreService;
  private readonly agentFiles = new AgentFileService();
  private readonly opencodeClient: OpenCodeClient;
  private readonly opencodeRunner: OpenCodeRunner;
  private readonly zellijManager: ZellijManager;
  private readonly events = new EventEmitter();
  private readonly taskRuntime = new Map<string, TaskRuntimeState>();
  private readonly autoOpenTaskSession: boolean;
  private readonly enableEventStream: boolean;
  private eventsConnected = false;
  private window: BrowserWindow | null = null;

  constructor(options: OrchestratorOptions) {
    this.store = new StoreService(options.userDataPath);
    this.opencodeClient = new OpenCodeClient(options.userDataPath);
    this.opencodeRunner = new OpenCodeRunner(this.opencodeClient);
    this.autoOpenTaskSession = options.autoOpenTaskSession ?? false;
    this.enableEventStream = options.enableEventStream ?? true;
    this.zellijManager = options.zellijManager ?? new ZellijManager();
  }

  async initialize() {
    await this.ensureEventStream();

    const existing = this.store.listProjects();
    if (existing.length === 0) {
      await this.ensureProjectForPath(process.cwd());
    }
  }

  async dispose() {
    await this.opencodeClient.shutdown();
  }

  attachWindow(window: BrowserWindow) {
    this.window = window;
    this.events.on("agentflow-event", (event: AgentFlowEvent) => {
      this.window?.webContents.send(IPC_CHANNELS.eventStream, event);
    });
  }

  async bootstrap(): Promise<ProjectSnapshot[]> {
    await this.reconcileTasksWithZellijSessions();

    const snapshots: ProjectSnapshot[] = [];
    for (const project of this.store.listProjects()) {
      snapshots.push(this.hydrateProject(project.id));
    }
    return snapshots;
  }

  async getProjectSnapshot(projectId: string): Promise<ProjectSnapshot> {
    return this.hydrateProject(projectId);
  }

  async getTaskSnapshot(taskId: string): Promise<TaskSnapshot> {
    return this.hydrateTask(taskId);
  }

  async findProjectByPath(projectPath: string): Promise<ProjectSnapshot | null> {
    const normalizedPath = path.resolve(projectPath);
    this.store.reconcileLegacyProjectRegistry(normalizedPath);
    const project = this.store.listProjects().find((item) => path.resolve(item.path) === normalizedPath);
    if (!project) {
      return null;
    }
    return this.hydrateProject(project.id);
  }

  async ensureProjectForPath(projectPath: string): Promise<ProjectSnapshot> {
    const normalizedPath = path.resolve(projectPath);
    const existing = await this.findProjectByPath(normalizedPath);
    if (existing) {
      return existing;
    }

    return this.createProject({
      path: normalizedPath,
    });
  }

  async createProject(payload: CreateProjectPayload): Promise<ProjectSnapshot> {
    const projectId = randomUUID();
    const projectPath = path.resolve(payload.path);
    const record: ProjectRecord = {
      id: projectId,
      name: getProjectNameFromPath(projectPath),
      path: projectPath,
      createdAt: new Date().toISOString(),
    };

    this.store.insertProject(record);
    this.agentFiles.ensureProjectAgents(projectPath);
    const agentFiles = this.agentFiles.listAgentFiles(projectId, projectPath);
    const topology = this.syncTopology(record, agentFiles);

    const welcome: MessageRecord = {
      id: randomUUID(),
      projectId,
      taskId: null,
      content:
        "项目已初始化：支持 Project/Task 两层结构、Task 级独立会话、.opencode/agents 本地 Agent 文件，以及项目级拓扑编辑。",
      sender: "system",
      timestamp: new Date().toISOString(),
    };
    this.store.insertMessage(welcome);

    const snapshot = this.hydrateProject(projectId);
    this.emit({
      type: "project-created",
      projectId,
      payload: snapshot,
    });

    return {
      ...snapshot,
      topology,
    };
  }

  async readAgentFile(payload: ReadAgentFilePayload): Promise<AgentFileRecord> {
    const project = this.store.getProject(payload.projectId);
    return this.agentFiles.readAgentFile(project.id, project.path, payload.relativePath);
  }

  async saveTopology(payload: UpdateTopologyPayload): Promise<ProjectSnapshot> {
    const project = this.store.getProject(payload.projectId);
    const agentFiles = this.agentFiles.listAgentFiles(project.id, project.path);
    const normalized = this.normalizeTopology(project.id, agentFiles, payload.topology);
    this.store.upsertTopology(normalized);
    this.syncProjectTaskPanelOrders(project.id, agentFiles, normalized);
    await this.rebuildProjectTaskPanels(project, agentFiles, normalized);
    const updated = this.hydrateProject(project.id);
    this.emit({
      type: "project-updated",
      projectId: project.id,
      payload: updated,
    });
    return updated;
  }

  async deleteTask(payload: DeleteTaskPayload): Promise<ProjectSnapshot> {
    const task = this.store.getTask(payload.taskId);
    if (task.projectId !== payload.projectId) {
      throw new Error(`Task ${payload.taskId} 不属于 Project ${payload.projectId}`);
    }

    this.taskRuntime.delete(task.id);
    await this.zellijManager.deleteTaskSession(task.zellijSessionId).catch(() => undefined);
    this.store.deleteTask(task.id);

    const updated = this.hydrateProject(payload.projectId);
    this.emit({
      type: "project-updated",
      projectId: payload.projectId,
      payload: updated,
    });
    return updated;
  }

  async submitTask(payload: SubmitTaskPayload): Promise<TaskSnapshot> {
    const project = this.store.getProject(payload.projectId);
    const agentFiles = this.agentFiles.listAgentFiles(project.id, project.path);
    this.syncTopology(project, agentFiles);
    const mentionName =
      payload.mentionAgent ||
      this.extractMention(payload.content) ||
      this.findAgentFile(agentFiles, BUILD_AGENT_NAME)?.name;
    if (!mentionName) {
      throw new Error("当前没有可用的目标 Agent。");
    }

    if (payload.taskId) {
      return this.continueTask(project, payload.taskId, payload.content, mentionName, agentFiles);
    }

    const initialized = await this.createTask(project, agentFiles, {
      title: this.createTaskTitle(payload.content),
      source: "submit",
    });

    return this.continueTask(
      project,
      initialized.task.id,
      payload.content,
      mentionName,
      agentFiles,
    );
  }

  async initializeTask(payload: InitializeTaskPayload): Promise<TaskSnapshot> {
    const project = this.store.getProject(payload.projectId);
    const agentFiles = this.agentFiles.listAgentFiles(project.id, project.path);
    this.syncTopology(project, agentFiles);

    return this.createTask(project, agentFiles, {
      title: (payload.title ?? "").trim() || "未命名任务",
      source: "initialize",
    });
  }

  async focusAgentPANEL(payload: OpenAgentPanePayload) {
    const project = this.store.getProject(payload.projectId);
    const task = this.store.getTask(payload.taskId);
    if (task.projectId !== project.id) {
      throw new Error("Task 不属于当前 Project");
    }

    const snapshot = await this.ensureTaskInitialized(
      project,
      task,
      this.agentFiles.listAgentFiles(project.id, project.path),
    );
    this.emit({
      type: "task-updated",
      projectId: project.id,
      payload: snapshot,
    });

    const panel = this.store.listTaskPanels(task.id).find((item) => item.agentName === payload.agentName);
    const taskAgent = this.store.listTaskAgents(task.id).find((item) => item.name === payload.agentName);
    if (!panel || !taskAgent) {
      throw new Error(`未找到 Agent ${payload.agentName} 对应的运行信息。`);
    }
    await this.zellijManager.openAgentTerminal({
      sessionName: panel.sessionName,
      cwd: panel.cwd,
      agentName: payload.agentName,
      opencodeSessionId: taskAgent.opencodeSessionId,
    });
  }

  async openTaskSession(payload: OpenTaskSessionPayload): Promise<void> {
    const project = this.store.getProject(payload.projectId);
    const task = this.store.getTask(payload.taskId);
    if (task.projectId !== project.id) {
      throw new Error("Task 不属于当前 Project");
    }

    await this.zellijManager.assertAvailable("无法打开 Zellij Session");
    const snapshot = await this.ensureTaskInitialized(
      project,
      task,
      this.agentFiles.listAgentFiles(project.id, project.path),
    );
    this.emit({
      type: "task-updated",
      projectId: project.id,
      payload: snapshot,
    });

    const sessionName =
      task.zellijSessionId ?? `oap-${task.projectId.slice(0, 6)}-${task.id.slice(0, 6)}`;
    await this.zellijManager.openTaskSession(sessionName, task.cwd);
  }

  async getTaskRuntime(payload: GetTaskRuntimePayload): Promise<AgentRuntimeSnapshot[]> {
    const project = this.store.getProject(payload.projectId);
    const task = this.store.getTask(payload.taskId);
    if (task.projectId !== project.id) {
      throw new Error("Task 不属于当前 Project");
    }

    const agents = this.store.listTaskAgents(task.id);
    return Promise.all(
      agents.map(async (agent) => {
        const baseSnapshot: AgentRuntimeSnapshot = {
          projectId: project.id,
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
            project.path,
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
    project: ProjectRecord,
    agentFiles: AgentFileRecord[],
    options: {
      title: string;
      source: "initialize" | "submit";
    },
  ): Promise<TaskSnapshot> {
    if (agentFiles.length === 0) {
      throw new Error("当前项目没有可用的 Agent 文件");
    }

    const taskId = randomUUID();
    const zellijSessionId = await this.zellijManager.createTaskSession(project.id, taskId);

    const task: TaskRecord = {
      id: taskId,
      projectId: project.id,
      title: options.title,
      status: "pending",
      cwd: project.path,
      zellijSessionId,
      opencodeSessionId: null,
      agentCount: agentFiles.length,
      createdAt: new Date().toISOString(),
      completedAt: null,
      initializedAt: null,
    };

    this.store.insertTask(task);
    for (const agentFile of agentFiles) {
      this.store.insertTaskAgent({
        id: randomUUID(),
        taskId,
        projectId: project.id,
        name: agentFile.name,
        opencodeSessionId: null,
        status: "idle",
        runCount: 0,
      });
    }

    await this.ensureTaskInitialized(project, task, agentFiles);

    const zellijSessionSummary = task.zellijSessionId
      ? `, Zellij Session: ${task.zellijSessionId}`
      : "";

    const taskCreatedMessage: MessageRecord = {
      id: randomUUID(),
      projectId: project.id,
      taskId,
      content:
        options.source === "initialize"
          ? `Task 已初始化${zellijSessionSummary}`
          : `Task 已创建并完成初始化${zellijSessionSummary}`,
      sender: "system",
      timestamp: new Date().toISOString(),
      meta: {
        kind: "task-created",
      },
    };
    this.store.insertMessage(taskCreatedMessage);

    if (!(await this.zellijManager.isAvailable())) {
      this.store.insertMessage({
        id: randomUUID(),
        projectId: project.id,
        taskId,
        content: buildZellijMissingReminder(),
        sender: "system",
        timestamp: new Date().toISOString(),
        meta: {
          kind: "zellij-missing",
        },
      });
    }

    this.taskRuntime.set(taskId, {
      completedEdges: new Set(),
      lastSignatureByAgent: new Map(),
      runningAgents: new Set(),
      queuedAgents: new Set(),
      queuedPromptsByAgent: new Map(),
    });

    const snapshot = this.hydrateTask(taskId);
    this.emit({
      type: "task-created",
      projectId: project.id,
      payload: snapshot,
    });

    if (this.autoOpenTaskSession && snapshot.task.zellijSessionId) {
      await this.zellijManager.openTaskSession(snapshot.task.zellijSessionId, project.path).catch(() => undefined);
    }

    return snapshot;
  }

  private async continueTask(
    project: ProjectRecord,
    taskId: string,
    content: string,
    mentionAgent: string,
    agentFiles: AgentFileRecord[],
  ): Promise<TaskSnapshot> {
    const task = this.store.getTask(taskId);
    if (task.projectId !== project.id) {
      throw new Error("Task 不属于当前 Project");
    }

    this.syncTaskAgents(task, agentFiles);
    const targetAgent = this.findAgentFile(agentFiles, mentionAgent);

    if (!targetAgent) {
      throw new Error(`未找到被 @ 的 Agent：${mentionAgent}`);
    }

    await this.ensureTaskInitialized(project, task, agentFiles);

    const message = this.createUserMessage(project.id, task.id, task.title, content, targetAgent.name);
    this.store.insertMessage(message);
    this.emit({
      type: "message-created",
      projectId: project.id,
      payload: message,
    });

    const forwardedContent = this.stripTargetMention(content, targetAgent.name);
    const runPromise = this.dispatchAgentRun(project, task.id, targetAgent.name, {
      mode: "raw",
      from: "User",
      content: forwardedContent,
    }, [message.id]);
    void runPromise.catch((error) => {
      console.error("[orchestrator] 后台发送任务失败", {
        taskId: task.id,
        agentName: targetAgent.name,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return this.hydrateTask(task.id);
  }

  private async dispatchAgentRun(
    project: ProjectRecord,
    taskId: string,
    agentName: string,
    prompt: AgentExecutionPrompt,
    behavior: AgentRunBehaviorOptions = {},
  ) {
    const runtime = this.getRuntime(taskId);
    if (runtime.runningAgents.has(agentName)) {
      runtime.queuedAgents.add(agentName);
      runtime.queuedPromptsByAgent.set(agentName, prompt);
      return;
    }

    await this.runAgent(project, this.store.getTask(taskId), agentName, prompt, behavior);
  }

  private createUserMessage(
    projectId: string,
    taskId: string,
    taskTitle: string,
    content: string,
    targetAgentId: string,
  ): MessageRecord {
    const normalizedContent = this.buildUserHistoryContent(content, targetAgentId);
    return {
      id: randomUUID(),
      projectId,
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

  private buildUserHistoryContent(content: string, targetAgentId: string): string {
    const trimmed = content.trim();
    if (!trimmed) {
      return `@${targetAgentId}`;
    }
    if (this.extractMention(trimmed)) {
      return content;
    }
    return `@${targetAgentId} ${trimmed}`;
  }

  private getLatestUserMessageContent(taskId: string): string {
    const task = this.store.getTask(taskId);
    const messages = this.store.listMessages(task.projectId, taskId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.sender === "user") {
        return message.content.trim();
      }
    }
    return "";
  }

  private contentContainsNormalized(content: string, candidate: string): boolean {
    const normalizedContent = this.normalizeContentForDedup(content);
    const normalizedCandidate = this.normalizeContentForDedup(candidate);
    if (!normalizedContent || !normalizedCandidate) {
      return false;
    }
    return normalizedContent.includes(normalizedCandidate);
  }

  private normalizeContentForDedup(value: string): string {
    return value.replace(/\s+/g, " ").trim().toLowerCase();
  }

  private syncTaskAgents(task: TaskRecord, agentFiles: AgentFileRecord[]) {
    const orderedAgentFiles = this.orderAgentFiles(task.projectId, agentFiles);
    const existingByName = new Set(this.store.listTaskAgents(task.id).map((item) => item.name));
    for (const agentFile of orderedAgentFiles) {
      if (existingByName.has(agentFile.name)) {
        continue;
      }
      this.store.insertTaskAgent({
        id: randomUUID(),
        taskId: task.id,
        projectId: task.projectId,
        name: agentFile.name,
        opencodeSessionId: null,
        status: "idle",
        runCount: 0,
      });
    }

    const existingPanels = new Set(this.store.listTaskPanels(task.id).map((item) => item.agentName));
    const nextPanels = this.zellijManager.createPanelBindings({
      projectId: task.projectId,
      taskId: task.id,
      sessionName: task.zellijSessionId ?? `oap-${task.projectId.slice(0, 6)}-${task.id.slice(0, 6)}`,
      cwd: task.cwd,
      agents: orderedAgentFiles.map((item) => ({
        name: item.name,
        opencodeSessionId: null,
        status: "idle",
      })),
    });
    for (const panel of nextPanels) {
      if (!existingPanels.has(panel.agentName)) {
        this.store.insertTaskPanel(panel);
      }
    }

    this.store.updateTaskAgentCount(task.id, agentFiles.length);
  }

  private async runAgent(
    project: ProjectRecord,
    task: TaskRecord,
    agentName: string,
    prompt: AgentExecutionPrompt,
    behavior: AgentRunBehaviorOptions = {},
  ) {
    const runtime = this.getRuntime(task.id);
    runtime.runningAgents.add(agentName);

    this.store.updateTaskAgentRun(task.id, agentName, "running");
    if (behavior.updateTaskStatusOnStart ?? true) {
      this.store.updateTaskStatus(task.id, "running", null);
    }
    const currentAgent = this.store.listTaskAgents(task.id).find((item) => item.name === agentName);
    if (!currentAgent) {
      throw new Error(`Task ${task.id} 缺少 Agent ${agentName}`);
    }
    let panels: TaskPanelRecord[] = [];

    try {
      const currentTask = this.store.getTask(task.id);
      await this.ensureTaskPanels(currentTask);
      const agentSessionId = await this.ensureAgentSession(project, currentTask, currentAgent);
      const latestAgentFile =
        this.findAgentFile(this.agentFiles.listAgentFiles(project.id, project.path), agentName);
      if (!latestAgentFile) {
        throw new Error(`当前 Project 缺少 Agent 文件 ${agentName}`);
      }
      panels = this.store.listTaskPanels(task.id);

      this.emit({
        type: "agent-status-changed",
        projectId: project.id,
        payload: {
          taskId: task.id,
          agentId: agentName,
          status: "running",
          runCount: currentAgent.runCount,
        },
      });
      this.emit({
        type: "task-updated",
        projectId: project.id,
        payload: this.hydrateTask(task.id),
      });

      const topology = this.store.getTopology(project.id);
      const dispatchedContent = this.buildAgentExecutionPrompt(prompt);
      await this.opencodeClient.reloadConfig(
        project.path,
        this.agentFiles.listAgentFiles(project.id, project.path),
        topology,
      );
      const response = await this.opencodeRunner.run({
        projectPath: project.path,
        sessionId: agentSessionId,
        content: dispatchedContent,
        agent: agentName,
        system: this.createSystemPrompt(latestAgentFile, topology),
      });

      if (response.status === "error") {
        throw new Error(
          response.rawMessage.error || response.finalMessage || `${agentName} 返回错误状态`,
        );
      }

      const parsedReview = this.parseReview(response.finalMessage);
      const agentContextContent = this.resolveAgentContextContent(
        parsedReview,
        response.finalMessage,
        response.fallbackMessage,
      );
      const taskMessage: MessageRecord = {
        id: response.messageId,
        projectId: project.id,
        taskId: task.id,
        content: this.createDisplayContent(parsedReview, response.fallbackMessage),
        sender: agentName,
        timestamp: response.timestamp,
        meta: {
          kind: "agent-final",
          status: response.status,
          finalMessage: agentContextContent,
          reviewDecision: parsedReview.decision,
          reviewFeedback: parsedReview.feedback ?? "",
          rawResponse: response.finalMessage,
          sessionId: agentSessionId,
        },
      };
      this.store.insertMessage(taskMessage);

      const directTargets = this.getOutgoingEdges(topology, agentName, "association");
      const reviewFailureTargets =
        parsedReview.decision === "needs_revision"
          ? this.getOutgoingEdges(topology, agentName, "review_fail")
          : [];
      const reviewAgent = this.isReviewAgent(latestAgentFile, topology);
      const agentStatus = parsedReview.decision === "needs_revision" ? "failed" : "success";
      this.store.updateTaskAgentStatus(task.id, agentName, agentStatus);
      if (behavior.updateTaskStatusOnStart ?? true) {
        this.store.updateTaskStatus(
          task.id,
          agentStatus === "failed" && reviewFailureTargets.length > 0
            ? "needs_revision"
            : agentStatus === "failed" && directTargets.length > 0 && !reviewAgent
              ? "running"
              : agentStatus === "failed"
              ? "failed"
              : "running",
          null,
        );
      }

      this.emit({
        type: "message-created",
        projectId: project.id,
        payload: taskMessage,
      });
      this.emit({
        type: "agent-status-changed",
        projectId: project.id,
        payload: {
          taskId: task.id,
          agentId: agentName,
          status: agentStatus,
          runCount:
            this.store.listTaskAgents(task.id).find((item) => item.name === agentName)?.runCount ??
            currentAgent.runCount,
        },
      });
      this.emit({
        type: "task-updated",
        projectId: project.id,
        payload: this.hydrateTask(task.id),
      });

      if (runtime.queuedAgents.has(agentName)) {
        return;
      }

      const signal = this.parseSignal(response.finalMessage);
      if (parsedReview.decision === "needs_revision") {
        const reviewTriggered =
          reviewFailureTargets.length > 0
            ? await this.triggerReviewDownstream(
                project,
                task.id,
                latestAgentFile,
                parsedReview,
              )
            : 0;
        if (reviewTriggered === 0 && (behavior.completeTaskOnFinish ?? true)) {
          await this.completeTask(task.id, "failed");
        }
        this.emit({
          type: "task-updated",
          projectId: project.id,
          payload: this.hydrateTask(task.id),
        });
        return;
      }

      const triggered =
        behavior.followTopology ?? true
          ? reviewAgent
            ? await this.triggerReviewPassDownstream(project, task.id, agentName, agentContextContent)
            : await this.triggerAssociationDownstream(project, task.id, agentName, agentContextContent, signal)
          : 0;
      const hasOtherRunningAgents = [...runtime.runningAgents].some((runningAgent) => runningAgent !== agentName);
      const hasQueuedAgents = runtime.queuedAgents.size > 0;

      if (
        (behavior.completeTaskOnFinish ?? true) &&
        (
          (!hasOtherRunningAgents && !hasQueuedAgents && signal.done) ||
          (!hasOtherRunningAgents &&
            !hasQueuedAgents &&
            triggered === 0 &&
            this.hasSatisfiedIncomingAssociation(topology, runtime.completedEdges, agentName) &&
            this.hasSatisfiedOutgoingAssociation(topology, runtime.completedEdges, agentName))
        )
      ) {
        await this.completeTask(task.id, "success");
      } else if (
        (behavior.completeTaskOnFinish ?? true) &&
        !hasOtherRunningAgents &&
        !hasQueuedAgents &&
        triggered === 0
      ) {
        this.moveTaskToWaiting(project.id, task.id, agentName);
      }
    } catch (error) {
      this.store.updateTaskAgentStatus(task.id, agentName, "failed");
      const failedMessage: MessageRecord = {
        id: randomUUID(),
        projectId: project.id,
        taskId: task.id,
        content: `[${agentName}] 执行失败：${error instanceof Error ? error.message : "未知错误"}`,
        sender: "system",
        timestamp: new Date().toISOString(),
      };
      this.store.insertMessage(failedMessage);

      const topology = this.store.getTopology(project.id);
      const associationTargets = this.getOutgoingEdges(topology, agentName, "association");
      const reviewAgent = this.isReviewAgent({ name: agentName }, topology);
      if (behavior.updateTaskStatusOnStart ?? true) {
        this.store.updateTaskStatus(
          task.id,
          associationTargets.length > 0 && !reviewAgent
              ? "running"
              : "failed",
          null,
        );
      }

      this.emit({
        type: "message-created",
        projectId: project.id,
        payload: failedMessage,
      });
      this.emit({
        type: "agent-status-changed",
        projectId: project.id,
        payload: {
          taskId: task.id,
          agentId: agentName,
          status: "failed",
          runCount: this.store.listTaskAgents(task.id).find((item) => item.name === agentName)?.runCount ?? 0,
        },
      });
      this.emit({
        type: "task-updated",
        projectId: project.id,
        payload: this.hydrateTask(task.id),
      });

      if (behavior.completeTaskOnFinish ?? true) {
        await this.completeTask(task.id, "failed");
      }
    } finally {
      runtime.runningAgents.delete(agentName);

      if (!runtime.queuedAgents.delete(agentName)) {
        return;
      }

      const latestTask = this.store.getTask(task.id);
      if (latestTask.status === "failed" || latestTask.status === "success") {
        return;
      }

      const queuedPrompt = runtime.queuedPromptsByAgent.get(agentName);
      runtime.queuedPromptsByAgent.delete(agentName);
      if (!queuedPrompt) {
        return;
      }

      void this.dispatchAgentRun(
        project,
        task.id,
        agentName,
        queuedPrompt,
      ).catch((queuedError) => {
        console.error("[orchestrator] 排队 Agent 重跑失败", {
          taskId: task.id,
          agentName,
          error: queuedError instanceof Error ? queuedError.message : String(queuedError),
        });
      });
    }
  }

  private async triggerAssociationDownstream(
    project: ProjectRecord,
    taskId: string,
    sourceAgentId: string,
    sourceContent: string,
    _signal: ParsedSignal,
    excludeTargets = new Set<string>(),
  ): Promise<number> {
    const runtime = this.getRuntime(taskId);
    const topology = this.store.getTopology(project.id);
    const agents = this.store.listTaskAgents(taskId);
    const outgoing = this.getOutgoingEdges(topology, sourceAgentId, "association");
    const completed = new Set(runtime.completedEdges);

    for (const edge of outgoing) {
      completed.add(edge.id);
      runtime.completedEdges.add(edge.id);
    }

    const targetNames = new Set<string>();
    for (const edge of outgoing) {
      if (excludeTargets.has(edge.target)) {
        continue;
      }
      targetNames.add(edge.target);
    }

    const readyTargets: string[] = [];
    const queuedTargets = new Set<string>();
    for (const targetName of targetNames) {
      if (runtime.runningAgents.has(targetName)) {
        runtime.queuedAgents.add(targetName);
        queuedTargets.add(targetName);
        continue;
      }
      if (this.canTriggerTarget(taskId, topology, completed, targetName, runtime)) {
        readyTargets.push(targetName);
      }
    }

    if (readyTargets.length === 0 && queuedTargets.size === 0) {
      return 0;
    }

    const triggerTargets = [...readyTargets, ...queuedTargets];

    if (!this.shouldSuppressDuplicateHighLevelTrigger(project.id, taskId, sourceAgentId, triggerTargets)) {
      const triggerMessage: MessageRecord = {
        id: randomUUID(),
        projectId: project.id,
        taskId,
        sender: sourceAgentId,
        timestamp: new Date().toISOString(),
        content: this.buildHighLevelTriggerMessageContent(triggerTargets, sourceContent),
        meta: {
          kind: "high-level-trigger",
          sourceAgentId,
          targetAgentIds: triggerTargets.join(","),
        },
      };
      this.store.insertMessage(triggerMessage);
      this.emit({
        type: "message-created",
        projectId: project.id,
        payload: triggerMessage,
      });
    }

    const currentTask = this.store.getTask(taskId);
    const gitDiffSummary = await this.buildProjectGitDiffSummary(currentTask.cwd);

    await Promise.all(
      readyTargets.map(async (targetName) => {
        const targetAgent = agents.find((item) => item.name === targetName);
        if (!targetAgent) {
          return;
        }

        const forwardedContext = this.buildDownstreamForwardedContext(taskId, sourceContent);
        const forwardedRequirement = this.buildAgentHandoffRequirement(
          "请结合 [User Message] 与上游 Agent Message 中的上下文继续推进当前任务，并只关注你当前负责的部分。",
          gitDiffSummary,
        );
        const signature = this.buildTriggerSignature(topology, completed, targetName);
        runtime.lastSignatureByAgent.set(targetName, signature);
        await this.dispatchAgentRun(project, taskId, targetName, {
          mode: "structured",
          from: sourceAgentId,
          userMessage: forwardedContext.userMessage,
          agentMessage: forwardedContext.agentMessage,
          requirement: targetName === BUILD_AGENT_NAME ? undefined : forwardedRequirement,
        });
      }),
    );

    return triggerTargets.length;
  }

  private async triggerReviewPassDownstream(
    project: ProjectRecord,
    taskId: string,
    sourceAgentId: string,
    sourceContent: string,
  ): Promise<number> {
    const runtime = this.getRuntime(taskId);
    const topology = this.store.getTopology(project.id);
    const outgoing = this.getOutgoingEdges(topology, sourceAgentId, "review_pass");
    const completed = new Set(runtime.completedEdges);

    for (const edge of outgoing) {
      completed.add(edge.id);
      runtime.completedEdges.add(edge.id);
    }

    const readyTargets: string[] = [];
    for (const edge of outgoing) {
      if (this.canTriggerTarget(taskId, topology, completed, edge.target, runtime)) {
        readyTargets.push(edge.target);
      }
    }

    if (readyTargets.length === 0) {
      return 0;
    }

    const uniqueTargets = [...new Set(readyTargets)];
    if (!this.shouldSuppressDuplicateHighLevelTrigger(project.id, taskId, sourceAgentId, uniqueTargets)) {
      const triggerMessage: MessageRecord = {
        id: randomUUID(),
        projectId: project.id,
        taskId,
        sender: sourceAgentId,
        timestamp: new Date().toISOString(),
        content: this.buildHighLevelTriggerMessageContent(uniqueTargets, sourceContent),
        meta: {
          kind: "high-level-trigger",
          sourceAgentId,
          targetAgentIds: uniqueTargets.join(","),
        },
      };
      this.store.insertMessage(triggerMessage);
      this.emit({
        type: "message-created",
        projectId: project.id,
        payload: triggerMessage,
      });
    }

    const currentTask = this.store.getTask(taskId);
    const gitDiffSummary = await this.buildProjectGitDiffSummary(currentTask.cwd);
    const forwardedContext = this.buildDownstreamForwardedContext(taskId, sourceContent);

    await Promise.all(
      uniqueTargets.map(async (targetName) => {
        const signature = this.buildTriggerSignature(topology, completed, targetName);
        runtime.lastSignatureByAgent.set(targetName, signature);
        await this.dispatchAgentRun(project, taskId, targetName, {
          mode: "structured",
          from: sourceAgentId,
          userMessage: forwardedContext.userMessage,
          agentMessage: forwardedContext.agentMessage,
          requirement: targetName === BUILD_AGENT_NAME
            ? undefined
            : this.buildAgentHandoffRequirement(
                "请结合 [User Message] 与上游 Agent Message 中的上下文继续推进当前任务，并只关注你当前负责的部分。",
                gitDiffSummary,
              ),
        });
      }),
    );

    return uniqueTargets.length;
  }

  private async triggerReviewDownstream(
    project: ProjectRecord,
    taskId: string,
    sourceAgent: Pick<AgentFileRecord, "name">,
    parsedReview: ParsedReview,
  ): Promise<number> {
    const topology = this.store.getTopology(project.id);
    const reviewTargets = [...new Set(
      this.getOutgoingEdges(topology, sourceAgent.name, "review_fail")
        .map((edge) => edge.target)
        .filter((targetName) => targetName !== sourceAgent.name),
    )];
    if (reviewTargets.length === 0) {
      return 0;
    }

    const feedback = parsedReview.feedback?.trim() || "请根据当前审视意见修复问题，并重新提交本轮结果。";
    const reviewContent = `具体修改意见：\n${feedback}`.trim();
    const latestUserContent = this.getLatestUserMessageContent(taskId);
    const userMessage = latestUserContent && !this.contentContainsNormalized(reviewContent, latestUserContent)
      ? latestUserContent
      : undefined;
    const currentTask = this.store.getTask(taskId);
    const gitDiffSummary = await this.buildProjectGitDiffSummary(currentTask.cwd);
    const forwardedRequirement = this.buildAgentHandoffRequirement(
      "请根据 [User Message] 与上游 Agent Message 中的审视意见完成修复，仅处理阻塞当前交付的问题。",
      gitDiffSummary,
    );

    for (const targetName of reviewTargets) {
      const remediationBody = `审视不通过，请根据以下意见继续处理。\n\n具体修改意见：\n${feedback}`;
      const remediationMessage: MessageRecord = {
        id: randomUUID(),
        projectId: project.id,
        taskId,
        sender: sourceAgent.name,
        timestamp: new Date().toISOString(),
        content: formatRevisionRequestContent(remediationBody, targetName),
        meta: {
          kind: "revision-request",
          sourceAgentId: sourceAgent.name,
          targetAgentId: targetName,
        },
      };
      this.store.insertMessage(remediationMessage);
      this.emit({
        type: "message-created",
        projectId: project.id,
        payload: remediationMessage,
      });
    }

    this.store.updateTaskStatus(taskId, "needs_revision", null);
    this.emit({
      type: "task-updated",
      projectId: project.id,
      payload: this.hydrateTask(taskId),
    });

    await Promise.all(
      reviewTargets.map(async (targetName) => {
        const targetAgent = this.findAgentFile(
          this.agentFiles.listAgentFiles(project.id, project.path),
          targetName,
        );
        if (!targetAgent) {
          return;
        }
        await this.dispatchAgentRun(
          project,
          taskId,
          targetName,
          {
            mode: "structured",
            from: sourceAgent.name,
            userMessage,
            agentMessage: reviewContent,
            requirement: targetName === BUILD_AGENT_NAME ? undefined : forwardedRequirement,
          },
        );
      }),
    );

    return reviewTargets.length;
  }

  private shouldSuppressDuplicateHighLevelTrigger(
    projectId: string,
    taskId: string,
    sourceAgentId: string,
    targetAgentIds: string[],
  ): boolean {
    const now = Date.now();
    const incomingTargets = [...targetAgentIds].sort().join(",");
    const messages = this.store.listMessages(projectId, taskId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const timestamp = Date.parse(message.timestamp);
      if (!Number.isFinite(timestamp)) {
        continue;
      }
      if (now - timestamp > 1500) {
        break;
      }
      if (message.sender !== sourceAgentId || message.meta?.kind !== "high-level-trigger") {
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

  private canTriggerTarget(
    taskId: string,
    topology: TopologyRecord,
    completedEdges: Set<string>,
    targetName: string,
    runtime: TaskRuntimeState,
  ): boolean {
    if (runtime.runningAgents.has(targetName)) {
      return false;
    }

    const agents = this.store.listTaskAgents(taskId);
    const agent = agents.find((item) => item.name === targetName);
    if (!agent) {
      return false;
    }

    const incomingSuccessEdges = this.getIncomingEdges(topology, targetName, "association")
      .concat(this.getIncomingEdges(topology, targetName, "review_pass"));
    if (incomingSuccessEdges.some((edge) => !completedEdges.has(edge.id))) {
      return false;
    }

    const signature = this.buildTriggerSignature(topology, completedEdges, targetName);
    if (
      runtime.lastSignatureByAgent.get(targetName) === signature &&
      agent.status !== "failed" &&
      agent.status !== "needs_revision"
    ) {
      return false;
    }

    return true;
  }

  private buildTriggerSignature(
    topology: TopologyRecord,
    completedEdges: Set<string>,
    targetName: string,
  ): string {
    const relevantEdgeIds = topology.edges
      .filter(
        (edge) =>
          edge.target === targetName &&
          (edge.triggerOn === "association" || edge.triggerOn === "review_pass") &&
          completedEdges.has(edge.id),
      )
      .map((edge) => edge.id)
      .sort();
    return relevantEdgeIds.join("|") || `direct:${targetName}`;
  }

  private hasSatisfiedIncomingAssociation(
    topology: TopologyRecord,
    completedEdges: Set<string>,
    agentName: string,
  ): boolean {
    const incomingEdges = this.getIncomingEdges(topology, agentName, "association")
      .concat(this.getIncomingEdges(topology, agentName, "review_pass"));
    return incomingEdges.every((edge) => completedEdges.has(edge.id));
  }

  private hasSatisfiedOutgoingAssociation(
    topology: TopologyRecord,
    completedEdges: Set<string>,
    agentName: string,
  ): boolean {
    const outgoingEdges = this.getOutgoingEdges(topology, agentName, "association")
      .concat(this.getOutgoingEdges(topology, agentName, "review_pass"));
    return outgoingEdges.every((edge) => completedEdges.has(edge.id));
  }

  private parseSignal(content: string): ParsedSignal {
    return {
      done: /\bTASK_DONE\b/i.test(content),
    };
  }

  private parseReview(content: string): ParsedReview {
    const decisionIndex = content.lastIndexOf("【DECISION】");
    if (decisionIndex < 0) {
      return {
        cleanContent: this.stripStructuredSignals(content),
        decision: "unknown",
        feedback: null,
        rawDecisionBlock: null,
      };
    }

    const body = content.slice(0, decisionIndex).trim();
    const decisionBlock = content.slice(decisionIndex).trim();
    const feedbackMatch = decisionBlock.match(/具体修改意见[:：]\s*([\s\S]*)$/);
    const feedback = feedbackMatch?.[1]?.trim() ?? null;

    return {
      cleanContent: this.stripStructuredSignals(body),
      decision: /【DECISION】\s*需要修改/.test(decisionBlock)
        ? "needs_revision"
        : /【DECISION】\s*(检查通过|已完成)/.test(decisionBlock)
          ? "pass"
          : "unknown",
      feedback,
      rawDecisionBlock: decisionBlock,
    };
  }

  private stripStructuredSignals(content: string): string {
    return content
      .split(/\r?\n/)
      .filter((line) => !/^\s*(NEXT_AGENTS:|TASK_DONE\b|SESSION_REF:|【DECISION】)/i.test(line))
      .join("\n")
      .trim();
  }

  private async buildProjectGitDiffSummary(cwd: string): Promise<string> {
    try {
      const [statusResult, stagedStatResult, unstagedStatResult] = await Promise.all([
        execFileAsync("git", ["-C", cwd, "status", "--short", "--untracked-files=all"], {
          timeout: 2500,
        }).catch(() => ({ stdout: "" })),
        execFileAsync("git", ["-C", cwd, "diff", "--cached", "--stat", "--compact-summary"], {
          timeout: 2500,
        }).catch(() => ({ stdout: "" })),
        execFileAsync("git", ["-C", cwd, "diff", "--stat", "--compact-summary"], {
          timeout: 2500,
        }).catch(() => ({ stdout: "" })),
      ]);

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

  private limitGitSummaryLines(lines: string[], maxLines: number): string[] {
    if (lines.length <= maxLines) {
      return lines;
    }
    return [...lines.slice(0, maxLines), `... 共 ${lines.length} 行，仅展示前 ${maxLines} 行`];
  }

  private buildAgentHandoffRequirement(baseRequirement: string, gitDiffSummary: string): string {
    return [baseRequirement, gitDiffSummary]
      .map((item) => item.trim())
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }

  private buildAgentExecutionPrompt(prompt: AgentExecutionPrompt): string {
    if (prompt.mode === "raw") {
      const content = prompt.content.trim();
      const from = this.getAgentDisplayName(prompt.from?.trim() || "System");
      return `[${from}] ${content || "（无）"}`.trim();
    }

    const from = this.getAgentDisplayName(prompt.from.trim() || "System");
    const sections: string[] = [];
    if (prompt.userMessage?.trim()) {
      sections.push(`[User Message]\n${prompt.userMessage.trim()}`);
    }
    if (prompt.agentMessage?.trim()) {
      sections.push(`[${from} Agent Message]\n${prompt.agentMessage.trim()}`);
    }
    if (sections.length === 0) {
      sections.push("[User Message]\n（无）");
    }
    if (prompt.requirement?.trim()) {
      sections.push(`[Requeirement]\n${prompt.requirement.trim()}`);
    }
    return sections
      .join("\n\n")
      .trim();
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

  private buildDownstreamForwardedContext(
    taskId: string,
    sourceContent: string,
  ): { userMessage?: string; agentMessage: string } {
    const latestUserContent = this.getLatestUserMessageContent(taskId);
    const latestSourceContent = sourceContent.trim();
    return {
      userMessage:
        latestUserContent && !this.contentContainsNormalized(latestSourceContent, latestUserContent)
          ? latestUserContent
          : undefined,
      agentMessage: latestSourceContent || "（该上游 Agent 未返回可继续流转的正文。）",
    };
  }

  private buildHighLevelTriggerMessageContent(targetAgentIds: string[], content: string): string {
    return formatHighLevelTriggerContent(content, targetAgentIds);
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
    if (cleanContent) {
      return cleanContent;
    }

    const fallbackContent = this.extractAgentDisplayContent(fallbackMessage?.trim() ?? "");
    if (fallbackContent) {
      return fallbackContent;
    }

    const feedback = parsedReview.feedback?.trim();
    if (feedback) {
      return `具体修改意见：\n${feedback}`;
    }

    if (parsedReview.decision === "needs_revision") {
      return "（该 Agent 已给出需要修改的结论，但未返回可展示的高层结果。）";
    }
    if (parsedReview.decision === "pass") {
      return "通过";
    }
    return "（该 Agent 未返回可展示的高层结果。）";
  }

  private async ensureAgentSession(
    project: ProjectRecord,
    task: TaskRecord,
    agent: TaskAgentRecord,
  ): Promise<string> {
    if (agent.opencodeSessionId) {
      return agent.opencodeSessionId;
    }

    const sessionId = await this.opencodeClient.createSession(
      project.path,
      `${task.title}:${agent.name}`,
    );
    this.store.updateTaskAgentSessionId(task.id, agent.name, sessionId);
    return sessionId;
  }

  private async ensureTaskPanels(task: TaskRecord) {
    const project = this.store.getProject(task.projectId);
    await this.ensureTaskInitialized(project, task, this.agentFiles.listAgentFiles(project.id, project.path));
  }

  private async ensureTaskAgentSessions(project: ProjectRecord, task: TaskRecord): Promise<Map<string, string>> {
    const sessions = await Promise.all(
      this.store.listTaskAgents(task.id).map(async (agent) => [
        agent.name,
        await this.ensureAgentSession(project, task, agent),
      ] as const),
    );
    return new Map(sessions);
  }

  private async ensureTaskInitialized(
    project: ProjectRecord,
    task: TaskRecord,
    agentFiles: AgentFileRecord[],
  ): Promise<TaskSnapshot> {
    this.syncTaskAgents(task, agentFiles);
    const currentTask = this.store.getTask(task.id);
    const agents = this.orderTaskAgents(task.id, this.store.listTaskAgents(task.id));
    const agentSessions = await this.ensureTaskAgentSessions(project, currentTask);
    const panels = await this.zellijManager.materializePanelBindings({
      projectId: currentTask.projectId,
      taskId: currentTask.id,
      sessionName:
        currentTask.zellijSessionId ?? `oap-${currentTask.projectId.slice(0, 6)}-${currentTask.id.slice(0, 6)}`,
      cwd: currentTask.cwd,
      agents: agents.map((agent) => ({
        name: agent.name,
        opencodeSessionId: agentSessions.get(agent.name) ?? null,
        status: agent.status,
      })),
    });
    for (const panel of panels) {
      this.store.upsertTaskPanel(panel);
    }

    const refreshedTask = this.store.getTask(task.id);
    if (!refreshedTask.initializedAt) {
      this.store.updateTaskInitialized(task.id, new Date().toISOString());
    }

    return this.hydrateTask(task.id);
  }

  private getOrderedAgentNames(
    projectId: string,
    agentFiles: Array<Pick<AgentFileRecord, "name" | "mode" | "role" | "relativePath">>,
    topologyOverride?: TopologyRecord,
  ): string[] {
    const topology = topologyOverride ?? this.store.getTopology(projectId);
    return resolveTopologyAgentOrder(agentFiles, topology.agentOrderIds);
  }

  private orderAgentFiles(
    projectId: string,
    agentFiles: AgentFileRecord[],
    topologyOverride?: TopologyRecord,
  ): AgentFileRecord[] {
    const orderedNames = this.getOrderedAgentNames(projectId, agentFiles, topologyOverride);
    const fileByName = new Map(agentFiles.map((agent) => [agent.name, agent]));
    return orderedNames.map((name) => fileByName.get(name)).filter((agent): agent is AgentFileRecord => Boolean(agent));
  }

  private orderTaskAgents(
    taskId: string,
    agents: TaskAgentRecord[],
    topologyOverride?: TopologyRecord,
  ): TaskAgentRecord[] {
    const task = this.store.getTask(taskId);
    const project = this.store.getProject(task.projectId);
    const orderedNames = this.getOrderedAgentNames(
      task.projectId,
      this.agentFiles.listAgentFiles(project.id, project.path),
      topologyOverride,
    );
    const agentByName = new Map(agents.map((agent) => [agent.name, agent]));
    return orderedNames.map((name) => agentByName.get(name)).filter((agent): agent is TaskAgentRecord => Boolean(agent));
  }

  private syncProjectTaskPanelOrders(
    projectId: string,
    agentFiles: AgentFileRecord[],
    topology: TopologyRecord,
  ) {
    const orderedNames = this.getOrderedAgentNames(projectId, agentFiles, topology);
    const orderIndex = new Map(orderedNames.map((name, index) => [name, index]));
    for (const task of this.store.listTasks(projectId)) {
      const taskPanels = this.store.listTaskPanels(task.id);
      for (const [fallbackIndex, panel] of taskPanels.entries()) {
        this.store.upsertTaskPanel({
          ...panel,
          order: orderIndex.get(panel.agentName) ?? orderedNames.length + fallbackIndex,
        });
      }
    }
  }

  private async rebuildProjectTaskPanels(
    project: ProjectRecord,
    agentFiles: AgentFileRecord[],
    topology: TopologyRecord,
  ) {
    for (const task of this.store.listTasks(project.id)) {
      if (!task.initializedAt || !task.zellijSessionId) {
        continue;
      }

      try {
        const orderedAgents = this.orderTaskAgents(
          task.id,
          this.store.listTaskAgents(task.id),
          topology,
        );
        const agentSessions = await this.ensureTaskAgentSessions(project, task);
        const panels = await this.zellijManager.materializePanelBindings({
          projectId: task.projectId,
          taskId: task.id,
          sessionName: task.zellijSessionId,
          cwd: task.cwd,
          agents: orderedAgents.map((agent) => ({
            name: agent.name,
            opencodeSessionId: agentSessions.get(agent.name) ?? null,
            status: agent.status,
          })),
          forceRebuild: true,
        });
        for (const panel of panels) {
          this.store.upsertTaskPanel(panel);
        }
      } catch (error) {
        console.error("[orchestrator] 重建 Task pane 顺序失败", {
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private isReviewAgent(
    agent: Pick<AgentFileRecord, "name">,
    topology: Pick<TopologyRecord, "edges">,
  ): boolean {
    return isReviewAgentInTopology(topology, agent.name);
  }

  private createSystemPrompt(
    agent: AgentFileRecord,
    topology: Pick<TopologyRecord, "edges">,
  ): string {
    const reviewAgent = this.isReviewAgent(agent, topology);
    if (!reviewAgent) {
      return "";
    }

    return buildAgentSystemPrompt(agent, reviewAgent);
  }

  private createTaskTitle(content: string): string {
    const firstLine = content
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find(Boolean);
    return (firstLine ?? "未命名任务").slice(0, 80);
  }

  private extractMention(content: string): string | undefined {
    const match = content.match(/@([^\s]+)/);
    return match?.[1];
  }

  private stripLeadingTargetMention(content: string, targetAgentName: string): string {
    const trimmed = content.trim();
    if (!trimmed) {
      return "";
    }

    const mentionToken = `@${targetAgentName}`;
    if (!trimmed.startsWith(mentionToken)) {
      return trimmed;
    }

    const nextChar = trimmed.charAt(mentionToken.length);
    if (nextChar && !/\s/u.test(nextChar)) {
      return trimmed;
    }

    const stripped = trimmed.slice(mentionToken.length).trimStart();
    return stripped || trimmed;
  }

  private stripTargetMention(content: string, targetAgentName: string): string {
    const trimmed = this.stripLeadingTargetMention(content, targetAgentName);
    if (!trimmed) {
      return "";
    }

    const mentionToken = `@${targetAgentName}`;
    const trailingPattern = new RegExp(`(?:^|\\s)${this.escapeRegExp(mentionToken)}\\s*$`, "u");
    const strippedTrailing = trimmed.replace(trailingPattern, "").trimEnd();
    return strippedTrailing || trimmed;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private findAgentFile(agentFiles: AgentFileRecord[], name: string | undefined): AgentFileRecord | undefined {
    if (!name) {
      return undefined;
    }
    return agentFiles.find((agent) => agent.name === name);
  }

  private hydrateProject(projectId: string, forceSyncTopology = false): ProjectSnapshot {
    const project = this.store.getProject(projectId);
    const agentFiles = this.agentFiles.listAgentFiles(project.id, project.path);
    const topology = forceSyncTopology
      ? this.syncTopology(project, agentFiles)
      : this.ensureTopologyExists(project, agentFiles);
    const tasks = this.store.listTasks(project.id);
    for (const task of tasks) {
      this.syncTaskAgents(task, agentFiles);
    }

    return {
      project,
      agentFiles,
      topology,
      messages: this.store.listMessages(project.id),
      tasks: tasks.map((task) => this.hydrateTask(task.id)),
    };
  }

  private hydrateTask(taskId: string): TaskSnapshot {
    const task = this.store.getTask(taskId);
    const project = this.store.getProject(task.projectId);
    const agentFiles = this.agentFiles.listAgentFiles(project.id, project.path);
    this.syncTaskAgents(task, agentFiles);
    return {
      task: this.store.getTask(taskId),
      agents: this.store.listTaskAgents(taskId),
      panels: this.store.listTaskPanels(taskId),
      messages: this.store.listMessages(task.projectId, taskId),
      topology: this.store.getTopology(task.projectId),
    };
  }

  private ensureTopologyExists(project: ProjectRecord, agentFiles: AgentFileRecord[]): TopologyRecord {
    const current = this.store.getTopology(project.id);
    if (current.nodes.length === 0 && current.edges.length === 0) {
      const fallback = createDefaultTopology(project.id, agentFiles);
      this.store.upsertTopology(fallback);
      return fallback;
    }
    return this.normalizeTopology(project.id, agentFiles, current);
  }

  private syncTopology(project: ProjectRecord, agentFiles: AgentFileRecord[]): TopologyRecord {
    const current = this.store.getTopology(project.id);
    const next =
      current.nodes.length === 0 && current.edges.length === 0
        ? createDefaultTopology(project.id, agentFiles)
        : this.normalizeTopology(project.id, agentFiles, current);

    this.store.upsertTopology(next);
    return next;
  }

  private normalizeTopology(
    projectId: string,
    agentFiles: AgentFileRecord[],
    topology: TopologyRecord,
  ): TopologyRecord {
    const validNames = new Set(agentFiles.map((item) => item.name));
    const seenEdges = new Set<string>();
    const seenPairs = new Set<string>();
    const edges = topology.edges
      .map((edge) => ({
        ...edge,
        triggerOn: edge.triggerOn === "review" ? "review_fail" : edge.triggerOn,
      }))
      .filter(
        (edge) =>
          edge.triggerOn === "association" ||
          edge.triggerOn === "review_pass" ||
          edge.triggerOn === "review_fail",
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
        ...edge,
        id: `${edge.source}__${edge.target}__${edge.triggerOn}`,
      }));
    const nodes = agentFiles.map((file) => ({
      id: file.name,
      label: file.name,
      kind: "agent" as const,
    }));
    const agentOrderIds = resolveTopologyAgentOrder(
      agentFiles.map((file) => ({
        name: file.name,
        mode: file.mode,
        role: file.role,
        relativePath: file.relativePath,
      })),
      Array.isArray(topology.agentOrderIds)
        ? topology.agentOrderIds
            .filter((item): item is string => typeof item === "string" && validNames.has(item))
        : null,
    );
    const orderedNodes = agentOrderIds.map((agentName) => {
      const node = nodes.find((item) => item.id === agentName);
      return node ?? { id: agentName, label: agentName, kind: "agent" as const };
    });

    return {
      projectId,
      startAgentId: resolveTopologyStartAgent(
        agentFiles.map((file) => ({
          name: file.name,
          mode: file.mode,
          role: file.role,
          relativePath: file.relativePath,
        })),
      ),
      agentOrderIds,
      nodes: orderedNodes,
      edges,
    };
  }

  private async reconcileTasksWithZellijSessions(): Promise<void> {
    const liveSessions = await this.zellijManager.listSessionNames();
    if (liveSessions === null) {
      return;
    }

    for (const project of this.store.listProjects()) {
      const staleTaskIds = this.store
        .listTasks(project.id)
        .filter((task) => task.zellijSessionId && !liveSessions.has(task.zellijSessionId))
        .map((task) => task.id);

      for (const taskId of staleTaskIds) {
        this.taskRuntime.delete(taskId);
        this.store.deleteTask(taskId);
      }
    }
  }

  private async completeTask(taskId: string, status: TaskRecord["status"]) {
    const currentTask = this.store.getTask(taskId);
    if (currentTask.status === status && currentTask.completedAt) {
      return;
    }

    const completedAt = status === "success" || status === "failed" ? new Date().toISOString() : null;
    this.store.updateTaskStatus(taskId, status, completedAt);
    const snapshot = this.hydrateTask(taskId);
    const completionMessage: MessageRecord = {
      id: randomUUID(),
      projectId: snapshot.task.projectId,
      taskId,
      sender: "system",
      timestamp: new Date().toISOString(),
      content:
        status === "success"
          ? `Task「${snapshot.task.title}」已完成，群聊中保留的是高层阶段消息与最终回复。`
          : `Task「${snapshot.task.title}」已收口为“不通过”或执行失败，请根据当前群聊消息和对应 Agent 状态继续排查。`,
      meta: {
        kind: "task-completed",
        status,
      },
    };
    this.store.insertMessage(completionMessage);
    this.emit({
      type: "message-created",
      projectId: snapshot.task.projectId,
      payload: completionMessage,
    });
    this.emit({
      type: "task-updated",
      projectId: snapshot.task.projectId,
      payload: snapshot,
    });
  }

  private getRuntime(taskId: string): TaskRuntimeState {
    let runtime = this.taskRuntime.get(taskId);
    if (!runtime) {
      runtime = {
        completedEdges: new Set(),
        lastSignatureByAgent: new Map(),
        runningAgents: new Set(),
        queuedAgents: new Set(),
        queuedPromptsByAgent: new Map(),
      };
      this.taskRuntime.set(taskId, runtime);
    }
    return runtime;
  }

  private getOutgoingEdges(
    topology: TopologyRecord,
    sourceAgentId: string,
    triggerOn: "association" | "review_pass" | "review_fail",
  ) {
    return topology.edges.filter(
      (edge) => edge.source === sourceAgentId && edge.triggerOn === triggerOn,
    );
  }

  private getIncomingEdges(
    topology: TopologyRecord,
    targetAgentId: string,
    triggerOn: "association" | "review_pass" | "review_fail",
  ) {
    return topology.edges.filter(
      (edge) => edge.target === targetAgentId && edge.triggerOn === triggerOn,
    );
  }

  private moveTaskToWaiting(projectId: string, taskId: string, sourceAgentId: string) {
    const currentTask = this.store.getTask(taskId);
    if (currentTask.status === "waiting") {
      return;
    }

    this.store.updateTaskStatus(taskId, "waiting", null);
    const waitingMessage = {
      id: randomUUID(),
      projectId,
      taskId,
      content: `Orchestrator 已收到 ${sourceAgentId} 的结果，但当前拓扑下没有可自动继续推进的下游节点，Task 保持等待状态。`,
      sender: "system",
      timestamp: new Date().toISOString(),
      meta: {
        kind: "orchestrator-waiting",
        sourceAgentId,
      },
    } satisfies MessageRecord;
    this.store.insertMessage(waitingMessage);
    this.emit({
      type: "message-created",
      projectId,
      payload: waitingMessage,
    });
    this.emit({
      type: "task-updated",
      projectId,
      payload: this.hydrateTask(taskId),
    });
  }

  private getAgentDisplayName(name: string) {
    return name;
  }

  private emit(event: AgentFlowEvent) {
    this.events.emit("agentflow-event", event);
  }
  private async ensureEventStream() {
    if (!this.enableEventStream || this.eventsConnected) {
      return;
    }

    this.eventsConnected = true;
    void this.opencodeClient.connectEvents(() => undefined);
  }
}
