import { BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { IPC_CHANNELS } from "@shared/ipc";
import { resolveTaskSubmissionTarget } from "@shared/task-submission";
import {
  type AgentFlowEvent,
  type AgentRuntimeSnapshot,
  type BuiltinAgentTemplateRecord,
  BUILD_AGENT_NAME,
  createDefaultTopology,
  type AgentFileRecord,
  type CreateProjectPayload,
  type DeleteProjectPayload,
  type DeleteAgentPayload,
  type DeleteTaskPayload,
  type GetTaskRuntimePayload,
  type InitializeTaskPayload,
  getProjectNameFromPath,
  type MessageRecord,
  type OpenAgentTerminalPayload,
  type OpenLangGraphStudioPayload,
  type OpenTaskSessionPayload,
  type ProjectRecord,
  type ProjectSnapshot,
  type ReadAgentFilePayload,
  type ReadBuiltinAgentTemplatePayload,
  type ResetBuiltinAgentTemplatePayload,
  type SaveAgentPromptPayload,
  type SaveBuiltinAgentTemplatePayload,
  resolveBuildAgentName,
  resolveTopologyAgentOrder,
  type SubmitTaskPayload,
  type TaskAgentRecord,
  type TaskPanelRecord,
  type TaskRecord,
  type TaskSnapshot,
  type TopologyEdge,
  type TopologyRecord,
  type UpdateTopologyPayload,
  isReviewAgentInTopology,
} from "@shared/types";
import {
  formatAgentDispatchContent,
  formatRevisionRequestContent,
} from "@shared/chat-message-format";
import {
  stripReviewResponseMarkup,
} from "@shared/review-response";
import { buildZellijMissingReminder } from "@shared/zellij";
import { CustomAgentConfigService } from "./custom-agent-config";
import { buildAgentSystemPrompt } from "./agent-system-prompt";
import {
  parseReview as parseReviewPure,
  stripStructuredSignals as stripStructuredSignalsPure,
  type ParsedReview,
} from "./review-parser";
import { OpenCodeClient } from "./opencode-client";
import { OpenCodeRunner } from "./opencode-runner";
import { StoreService } from "./store";
import { ZellijManager } from "./zellij-manager";
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
import { LangGraphStudioManager } from "./langgraph-studio";
import type { GraphDispatchBatch, GraphAgentResult } from "./gating-router";
import type { GraphTaskState } from "./gating-state";

const execFileAsync = promisify(execFile);

interface OrchestratorOptions {
  userDataPath: string;
  autoOpenTaskSession?: boolean;
  enableEventStream?: boolean;
  runtimeRefreshDebounceMs?: number;
  zellijManager?: ZellijManager;
}

interface ParsedSignal {
  done: boolean;
}

interface GitSummaryCommandResult {
  stdout: string;
  unavailable: boolean;
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
  private readonly customAgentConfig: CustomAgentConfigService;
  private readonly opencodeClient: OpenCodeClient;
  private readonly opencodeRunner: OpenCodeRunner;
  private readonly zellijManager: ZellijManager;
  private readonly langGraphStudioManager: LangGraphStudioManager;
  private readonly events = new EventEmitter();
  private readonly langGraphRuntimes = new Map<string, LangGraphRuntime>();
  private readonly autoOpenTaskSession: boolean;
  private readonly enableEventStream: boolean;
  private readonly connectedEventProjects = new Set<string>();
  private readonly pendingRuntimeRefreshProjects = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingEventReconnects = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingTaskRuns = new Set<Promise<void>>();
  private readonly runtimeRefreshDebounceMs: number;
  private window: BrowserWindow | null = null;

  constructor(options: OrchestratorOptions) {
    this.store = new StoreService(options.userDataPath);
    this.customAgentConfig = new CustomAgentConfigService(options.userDataPath);
    this.opencodeClient = new OpenCodeClient(options.userDataPath);
    this.opencodeRunner = new OpenCodeRunner(this.opencodeClient);
    this.autoOpenTaskSession = options.autoOpenTaskSession ?? false;
    this.enableEventStream = options.enableEventStream ?? true;
    this.runtimeRefreshDebounceMs = options.runtimeRefreshDebounceMs ?? 120;
    this.zellijManager = options.zellijManager ?? new ZellijManager();
    this.langGraphStudioManager = new LangGraphStudioManager({
      runtimeRoot: path.join(options.userDataPath, "langgraph-studio"),
    });
  }

  async initialize() {
    if (this.store.listProjects().length === 0) {
      await this.ensureProjectForPath(process.cwd());
    }

    const projects = this.store.listProjects();
    const cwd = path.resolve(process.cwd());
    const currentProject =
      projects.find((project) => path.resolve(project.path) === cwd) ??
      projects[0] ??
      null;
    this.setInjectedConfigForProject(currentProject);

    await this.ensureEventStream();
  }

  async dispose() {
    this.pendingRuntimeRefreshProjects.forEach((timer) => clearTimeout(timer));
    this.pendingRuntimeRefreshProjects.clear();
    this.pendingEventReconnects.forEach((timer) => clearTimeout(timer));
    this.pendingEventReconnects.clear();
    if (this.pendingTaskRuns.size > 0) {
      await Promise.allSettled([...this.pendingTaskRuns]);
    }
    this.langGraphRuntimes.clear();
    await this.langGraphStudioManager.shutdownAll();
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
      await this.reconcilePersistedProjectTasks(project.id);
      snapshots.push(this.hydrateProject(project.id));
    }
    return snapshots;
  }

  async getProjectSnapshot(projectId: string): Promise<ProjectSnapshot> {
    await this.reconcilePersistedProjectTasks(projectId);
    return this.hydrateProject(projectId);
  }

  async getTaskSnapshot(taskId: string): Promise<TaskSnapshot> {
    await this.reconcilePersistedTaskStatus(taskId);
    return this.hydrateTask(taskId);
  }

  async findProjectByPath(projectPath: string): Promise<ProjectSnapshot | null> {
    const normalizedPath = path.resolve(projectPath);
    this.store.reconcileLegacyProjectRegistry(normalizedPath);
    const project = this.store.listProjects().find((item) => path.resolve(item.path) === normalizedPath);
    if (!project) {
      return null;
    }
    await this.reconcilePersistedProjectTasks(project.id);
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
    const agentFiles = this.listProjectAgents(record);
    const topology = this.syncTopology(record, agentFiles);

    const welcome: MessageRecord = {
      id: randomUUID(),
      projectId,
      taskId: null,
      content:
        "项目已初始化：支持 Project/Task 两层结构、Task 级独立会话、用户目录下的自定义 Agent 配置，以及项目级拓扑编辑。",
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

    await this.ensureEventStream(record.path);

    return {
      ...snapshot,
      topology,
    };
  }

  async readAgentFile(payload: ReadAgentFilePayload): Promise<AgentFileRecord> {
    const project = this.store.getProject(payload.projectId);
    return this.customAgentConfig.getProjectAgent(project.path, payload.agentName);
  }

  async readBuiltinAgentTemplate(
    payload: ReadBuiltinAgentTemplatePayload,
  ): Promise<BuiltinAgentTemplateRecord> {
    const project = this.store.getProject(payload.projectId);
    return this.customAgentConfig.getBuiltinAgentTemplate(project.path, payload.templateName);
  }

  async saveAgentPrompt(payload: SaveAgentPromptPayload): Promise<ProjectSnapshot> {
    const project = this.store.getProject(payload.projectId);
    const hasTaskRecords = this.store.listTasks(project.id).length > 0;
    if (hasTaskRecords) {
      throw new Error("当前 Project 已有 Task 启动记录，不允许再修改 Agent 配置。");
    }
    this.customAgentConfig.saveProjectAgentPrompt(
      project.path,
      payload.currentAgentName,
      payload.nextAgentName,
      payload.prompt,
      payload.isWritable ?? false,
    );
    this.customAgentConfig.validateProjectAgents(project.path);
    const updated = this.hydrateProject(project.id, true);
    this.emit({
      type: "project-updated",
      projectId: project.id,
      payload: updated,
    });
    return updated;
  }

  async saveBuiltinAgentTemplate(
    payload: SaveBuiltinAgentTemplatePayload,
  ): Promise<ProjectSnapshot> {
    const project = this.store.getProject(payload.projectId);
    const hasTaskRecords = this.store.listTasks(project.id).length > 0;
    if (hasTaskRecords) {
      throw new Error("当前 Project 已有 Task 启动记录，不允许再修改内置模板。");
    }
    this.customAgentConfig.saveBuiltinAgentTemplate(
      project.path,
      payload.templateName,
      payload.prompt,
    );
    const updated = this.hydrateProject(project.id);
    this.emit({
      type: "project-updated",
      projectId: project.id,
      payload: updated,
    });
    return updated;
  }

  async resetBuiltinAgentTemplate(
    payload: ResetBuiltinAgentTemplatePayload,
  ): Promise<ProjectSnapshot> {
    const project = this.store.getProject(payload.projectId);
    const hasTaskRecords = this.store.listTasks(project.id).length > 0;
    if (hasTaskRecords) {
      throw new Error("当前 Project 已有 Task 启动记录，不允许再修改内置模板。");
    }
    this.customAgentConfig.resetBuiltinAgentTemplate(project.path, payload.templateName);
    const updated = this.hydrateProject(project.id);
    this.emit({
      type: "project-updated",
      projectId: project.id,
      payload: updated,
    });
    return updated;
  }

  async deleteAgent(payload: DeleteAgentPayload): Promise<ProjectSnapshot> {
    const project = this.store.getProject(payload.projectId);
    const hasTaskRecords = this.store.listTasks(project.id).length > 0;
    if (hasTaskRecords) {
      throw new Error("当前 Project 已进入任务驱动阶段，不允许删除 Agent。");
    }
    this.customAgentConfig.deleteProjectAgent(project.path, payload.agentName);
    this.customAgentConfig.validateProjectAgents(project.path);
    const updated = this.hydrateProject(project.id, true);
    this.emit({
      type: "project-updated",
      projectId: project.id,
      payload: updated,
    });
    return updated;
  }

  private listProjectAgents(project: ProjectRecord): AgentFileRecord[] {
    return this.customAgentConfig.listProjectAgents(project.path);
  }

  async saveTopology(payload: UpdateTopologyPayload): Promise<ProjectSnapshot> {
    const project = this.store.getProject(payload.projectId);
    const agentFiles = this.listProjectAgents(project);
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

    await this.deleteTaskGraphRuntime(task);
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

  async deleteProject(payload: DeleteProjectPayload): Promise<ProjectSnapshot[]> {
    const project = this.store.getProject(payload.projectId);
    const tasks = this.store.listTasks(project.id);

    for (const task of tasks) {
      await this.deleteTaskGraphRuntime(task);
      await this.zellijManager.deleteTaskSession(task.zellijSessionId).catch(() => undefined);
    }

    await this.opencodeClient.deleteProject(project.path).catch(() => undefined);
    this.connectedEventProjects.delete(path.resolve(project.path));
    this.customAgentConfig.deleteProject(project.path);
    this.store.deleteProject(project.id);

    const remainingProjects = this.store.listProjects();
    const nextCurrentProject =
      remainingProjects.find((item) => path.resolve(item.path) === path.resolve(process.cwd()))
      ?? remainingProjects[0]
      ?? null;
    this.setInjectedConfigForProject(nextCurrentProject);

    const snapshots: ProjectSnapshot[] = [];
    for (const remainingProject of remainingProjects) {
      await this.reconcilePersistedProjectTasks(remainingProject.id);
      snapshots.push(this.hydrateProject(remainingProject.id));
    }

    return snapshots;
  }

  async submitTask(payload: SubmitTaskPayload): Promise<TaskSnapshot> {
    const project = this.store.getProject(payload.projectId);
    const agentFiles = this.listProjectAgents(project);
    this.customAgentConfig.validateProjectAgents(project.path);
    this.syncTopology(project, agentFiles);
    const resolution = resolveTaskSubmissionTarget({
      content: payload.content,
      mentionAgent: payload.mentionAgent,
      availableAgents: agentFiles.map((agent) => agent.name),
    });
    if (!resolution.ok) {
      throw new Error(resolution.message);
    }
    const mentionName = resolution.targetAgent;

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
    const agentFiles = this.listProjectAgents(project);
    this.customAgentConfig.validateProjectAgents(project.path);
    this.syncTopology(project, agentFiles);

    return this.createTask(project, agentFiles, {
      title: (payload.title ?? "").trim() || "未命名任务",
      source: "initialize",
    });
  }

  async openAgentTerminal(payload: OpenAgentTerminalPayload) {
    const project = this.store.getProject(payload.projectId);
    const task = this.store.getTask(payload.taskId);
    if (task.projectId !== project.id) {
      throw new Error("Task 不属于当前 Project");
    }

    const snapshot = await this.ensureTaskInitialized(
      project,
      task,
      this.customAgentConfig.listProjectAgents(project.path),
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
    await this.syncOpenCodeAttachEndpoint(project.path);
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
      this.listProjectAgents(project),
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

  async openLangGraphStudio(payload: OpenLangGraphStudioPayload): Promise<string> {
    const project = this.store.getProject(payload.projectId);
    const agentFiles = this.listProjectAgents(project);
    this.syncTopology(project, agentFiles);
    return this.langGraphStudioManager.open(project.path);
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
      throw new Error("当前项目没有可用的 Agent");
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
    if (isTerminalTaskStatus(task.status)) {
      this.store.updateTaskStatus(task.id, "running", null);
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

    const forwardedContent = stripTargetMentionPure(content, targetAgent.name);
    const topology = this.store.getTopology(project.id);
    const runtime = this.getLangGraphRuntime(project);
    this.trackBackgroundTask(runtime.resumeTask({
      taskId: task.id,
      projectId: project.id,
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
    return this.hydrateTask(task.id);
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
    projectId: string,
    taskId: string,
    taskTitle: string,
    content: string,
    targetAgentId: string,
  ): MessageRecord {
    const normalizedContent = buildUserHistoryContentPure(content, targetAgentId);
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
    if (behavior.followTopology) {
      throw new Error("runAgent 已不再负责拓扑调度；请通过 submitTask/continueTask 走 LangGraph runtime。");
    }

    const result = await this.executeLangGraphAgentOnce(
      project,
      task,
      agentName,
      prompt,
      1,
    );
    if (!(behavior.completeTaskOnFinish ?? true)) {
      return;
    }

    const latestTask = this.store.getTask(task.id);
    if (isTerminalTaskStatus(latestTask.status)) {
      if (latestTask.status === "failed" && latestTask.completedAt === null) {
        await this.completeTask(task.id, "failed");
      }
      return;
    }

    if (latestTask.status === "needs_revision") {
      return;
    }

    const nextTaskStatus = resolveStandaloneTaskStatusAfterAgentRun({
      latestAgentStatus: result.agentStatus,
      agentStatuses: this.store.listTaskAgents(task.id),
    });

    if (nextTaskStatus === "finished") {
      await this.completeTask(task.id, "finished");
      return;
    }

    if (nextTaskStatus === "failed") {
      await this.completeTask(task.id, "failed");
      return;
    }

    this.moveTaskToWaiting(project.id, task.id, agentName);
  }

  private shouldSuppressDuplicateDispatchMessage(
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

  private isTaskTerminal(taskId: string): boolean {
    return isTerminalTaskStatus(this.store.getTask(taskId).status);
  }

  private updateTaskStatusIfActive(
    taskId: string,
    status: TaskRecord["status"],
    completedAt: string | null = null,
  ): boolean {
    if (this.isTaskTerminal(taskId)) {
      return false;
    }
    this.store.updateTaskStatus(taskId, status, completedAt);
    return true;
  }

  private async reconcilePersistedTaskStatus(taskId: string) {
    const task = this.store.getTask(taskId);
    if (!shouldFinishTaskFromPersistedStatePure({
      taskStatus: task.status,
      topology: this.store.getTopology(task.projectId),
      agents: this.store.listTaskAgents(taskId),
      messages: this.store.listMessages(task.projectId, taskId),
    })) {
      return;
    }

    await this.completeTask(taskId, "finished");
  }

  private async reconcilePersistedProjectTasks(projectId: string) {
    for (const task of this.store.listTasks(projectId)) {
      await this.reconcilePersistedTaskStatus(task.id);
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

  private async ensureAgentSession(
    project: ProjectRecord,
    task: TaskRecord,
    agent: TaskAgentRecord,
  ): Promise<string> {
    this.setInjectedConfigForProject(project);
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
    await this.ensureTaskInitialized(project, task, this.listProjectAgents(project));
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
    await this.ensureEventStream(project.path);
    this.setInjectedConfigForProject(project);
    this.syncTaskAgents(task, agentFiles);
    const currentTask = this.store.getTask(task.id);
    const agents = this.orderTaskAgents(task.id, this.store.listTaskAgents(task.id));
    const agentSessions = await this.ensureTaskAgentSessions(project, currentTask);
    await this.syncOpenCodeAttachEndpoint(project.path);
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
    agentFiles: Array<Pick<AgentFileRecord, "name">>,
    topologyOverride?: TopologyRecord,
  ): string[] {
    const topology = topologyOverride ?? this.store.getTopology(projectId);
    return resolveTopologyAgentOrder(agentFiles, topology.nodes);
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
      this.listProjectAgents(project),
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
        await this.syncOpenCodeAttachEndpoint(project.path);
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

  private async syncOpenCodeAttachEndpoint(projectPath: string) {
    const attachBaseUrl = await this.opencodeClient.getAttachBaseUrl(projectPath);
    this.zellijManager.setOpenCodeAttachBaseUrl(attachBaseUrl);
    return attachBaseUrl;
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

  private setInjectedConfigForProject(project: ProjectRecord | null) {
    if (!project) {
      return;
    }
    this.opencodeClient.setInjectedConfigContent(
      project.path,
      this.customAgentConfig.buildInjectedConfigContent(project.path),
    );
  }

  private findAgentFile(agentFiles: AgentFileRecord[], name: string | undefined): AgentFileRecord | undefined {
    if (!name) {
      return undefined;
    }
    return agentFiles.find((agent) => agent.name === name);
  }

  private hydrateProject(projectId: string, forceSyncTopology = false): ProjectSnapshot {
    const project = this.store.getProject(projectId);
    const agentFiles = this.listProjectAgents(project);
    const builtinAgentTemplates = this.customAgentConfig.listBuiltinAgentTemplates(project.path);
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
      builtinAgentTemplates,
      topology,
      messages: this.store.listMessages(project.id),
      tasks: tasks.map((task) => this.hydrateTask(task.id)),
    };
  }

  private hydrateTask(taskId: string): TaskSnapshot {
    const task = this.store.getTask(taskId);
    const project = this.store.getProject(task.projectId);
    const agentFiles = this.listProjectAgents(project);
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
      }));
    const nodes = resolveTopologyAgentOrder(
      agentFiles.map((file) => ({ name: file.name })),
      topology.nodes.filter((item) => validNames.has(item)),
    );

    return {
      projectId,
      nodes,
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
        .filter(
          (task) =>
            task.zellijSessionId
            && !liveSessions.has(task.zellijSessionId)
            && (task.status === "finished" || task.status === "failed"),
        )
        .map((task) => task.id);

      for (const taskId of staleTaskIds) {
        const task = this.store.getTask(taskId);
        await this.deleteTaskGraphRuntime(task);
        this.store.deleteTask(taskId);
      }
    }
  }

  private getLangGraphRuntime(project: ProjectRecord): LangGraphRuntime {
    let runtime = this.langGraphRuntimes.get(project.id);
    if (runtime) {
      return runtime;
    }

    const host: LangGraphTaskLoopHost = {
      createBatchRunners: async ({ taskId, state, batch }) =>
        this.createLangGraphBatchRunners(project, taskId, state, batch),
      moveTaskToWaiting: async ({ taskId, state }) =>
        this.moveTaskToWaiting(
          project.id,
          taskId,
          this.resolveWaitingSourceAgentId(taskId, state),
        ),
      completeTask: async ({ taskId, status }) =>
        this.completeTask(taskId, status),
    };
    runtime = new LangGraphRuntime({
      checkpointDir: path.join(project.path, ".agentflow", "langgraph"),
      host,
    });
    this.langGraphRuntimes.set(project.id, runtime);
    return runtime;
  }

  private async deleteTaskGraphRuntime(task: Pick<TaskRecord, "id" | "projectId">) {
    const project = this.store.getProject(task.projectId);
    await this.getLangGraphRuntime(project).deleteTask(task.id);
  }

  private resolveWaitingSourceAgentId(taskId: string, state: GraphTaskState): string {
    const latestAgentMessage = [...this.store.listMessages(state.projectId, taskId)]
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
    project: ProjectRecord,
    taskId: string,
    state: GraphTaskState,
    batch: GraphDispatchBatch,
  ) {
    const task = this.store.getTask(taskId);
    const topology = this.store.getTopology(project.id);
    const batchSize = batch.jobs.length;

    if (batch.jobs.every((job) => job.kind === "association" || job.kind === "approved")) {
      const sourceAgentId = batch.sourceAgentId ?? "System";
      if (!this.shouldSuppressDuplicateDispatchMessage(project.id, taskId, sourceAgentId, batch.triggerTargets)) {
        const triggerMessage: MessageRecord = {
          id: randomUUID(),
          projectId: project.id,
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
          },
        };
        this.store.insertMessage(triggerMessage);
        this.emit({
          type: "message-created",
          projectId: project.id,
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
        this.store.listMessages(task.projectId, taskId),
        batch.sourceContent ?? "",
        includeInitialTask,
      )
      : null;
    const initialUserContent = includeInitialTask
      ? getInitialUserMessageContentPure(this.store.listMessages(task.projectId, taskId))
      : "";

    return batch.jobs.map((job, index) => {
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
          gitDiffSummary: this.shouldAttachGitDiffSummary(topology, job.agentName) ? gitDiffSummary : undefined,
          allowDirectFallbackWhenNoBatch: true,
        };
        const remediationMessage: MessageRecord = {
          id: randomUUID(),
          projectId: project.id,
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
          },
        };
        this.store.insertMessage(remediationMessage);
        this.emit({
          type: "message-created",
          projectId: project.id,
          payload: remediationMessage,
        });
      } else {
        prompt = {
          mode: "structured",
          from: batch.sourceAgentId ?? "System",
          userMessage: forwardedContext?.userMessage,
          agentMessage: forwardedContext?.agentMessage,
          gitDiffSummary: this.shouldAttachGitDiffSummary(topology, job.agentName) ? gitDiffSummary : undefined,
        };
      }

      return {
        id: `${batch.sourceAgentId ?? "user"}:${job.agentName}:${index}:${Date.now()}`,
        agentName: job.agentName,
        promise: this.executeLangGraphAgentOnce(
          project,
          task,
          job.agentName,
          prompt,
          batchSize,
        ),
      };
    });
  }

  private async executeLangGraphAgentOnce(
    project: ProjectRecord,
    task: TaskRecord,
    agentName: string,
    prompt: AgentExecutionPrompt,
    concurrentBatchSize: number,
  ): Promise<GraphAgentResult> {
    this.setInjectedConfigForProject(project);
    this.store.updateTaskAgentRun(task.id, agentName, "running");
    this.updateTaskStatusIfActive(task.id, "running", null);
    const currentAgent = this.store.listTaskAgents(task.id).find((item) => item.name === agentName);
    if (!currentAgent) {
      return {
        agentName,
        status: "failed",
        reviewAgent: false,
        reviewDecision: "invalid",
        agentStatus: "failed",
        agentContextContent: "",
        opinion: null,
        allowDirectFallbackWhenNoBatch: false,
        signalDone: false,
        errorMessage: `Task ${task.id} 缺少 Agent ${agentName}`,
      };
    }

    try {
      const currentTask = this.store.getTask(task.id);
      await this.ensureTaskPanels(currentTask);
      const agentSessionId = await this.ensureAgentSession(project, currentTask, currentAgent);
      const latestAgentFile = this.findAgentFile(this.listProjectAgents(project), agentName);
      if (!latestAgentFile) {
        throw new Error(`当前 Project 缺少 Agent ${agentName}`);
      }

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
      const response = await this.opencodeRunner.run({
        projectPath: project.path,
        sessionId: agentSessionId,
        content: dispatchedContent,
        agent: agentName,
        system: this.createSystemPrompt(latestAgentFile, topology, prompt),
      });

      if (response.status === "error") {
        throw new Error(
          response.rawMessage.error || response.finalMessage || `${agentName} 返回错误状态`,
        );
      }

      const reviewAgent = this.isReviewAgent(latestAgentFile, topology);
      const parsedReview = this.parseReview(response.finalMessage, reviewAgent);
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
          reviewOpinion: parsedReview.opinion ?? "",
          rawResponse: response.finalMessage,
          sessionId: agentSessionId,
        },
      };
      this.store.insertMessage(taskMessage);

      const needsRevisionureTargets =
        parsedReview.decision === "needs_revision"
          ? this.getOutgoingEdges(topology, agentName, "needs_revision")
          : [];
      const agentStatus = resolveAgentStatusFromReview({
        reviewDecision: parsedReview.decision,
        reviewAgent,
      });
      this.store.updateTaskAgentStatus(task.id, agentName, agentStatus);
      if (parsedReview.decision === "needs_revision" && needsRevisionureTargets.length > 0) {
        this.updateTaskStatusIfActive(
          task.id,
          concurrentBatchSize > 1 ? "running" : "needs_revision",
          null,
        );
      } else if (agentStatus === "failed") {
        this.updateTaskStatusIfActive(task.id, "failed", null);
      } else {
        this.updateTaskStatusIfActive(task.id, "running", null);
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

      const signal = this.parseSignal(response.finalMessage);
      return {
        agentName,
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
      const topology = this.store.getTopology(project.id);
      const reviewAgent = this.isReviewAgent({ name: agentName }, topology);
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
      this.updateTaskStatusIfActive(task.id, "failed", null);
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

      return {
        agentName,
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

  private async completeTask(taskId: string, status: TaskRecord["status"]) {
    const currentTask = this.store.getTask(taskId);
    if (currentTask.status === status && currentTask.completedAt) {
      return;
    }

    const completedAt = status === "finished" || status === "failed" ? new Date().toISOString() : null;
    if (status === "finished") {
      for (const agent of this.store.listTaskAgents(taskId)) {
        if (agent.status === "completed") {
          continue;
        }
        this.store.updateTaskAgentStatus(taskId, agent.name, "completed");
        this.emit({
          type: "agent-status-changed",
          projectId: agent.projectId,
          payload: {
            taskId,
            agentId: agent.name,
            status: "completed",
            runCount: agent.runCount,
          },
        });
      }
    }
    this.store.updateTaskStatus(taskId, status, completedAt);
    const snapshot = this.hydrateTask(taskId);
    const completionMessage: MessageRecord = {
      id: randomUUID(),
      projectId: snapshot.task.projectId,
      taskId,
      sender: "system",
      timestamp: new Date().toISOString(),
      content:
        status === "finished"
          ? "所有Agent任务已完成"
          : `Task「${snapshot.task.title}」已结束，本轮结果未通过检查，或执行过程已中断。请直接查看群聊中最近一条失败消息，并继续处理状态为“审视不通过”或“执行失败”的 Agent。`,
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

  private getOutgoingEdges(
    topology: TopologyRecord,
    sourceAgentId: string,
    triggerOn: "association" | "approved" | "needs_revision",
  ) {
    return topology.edges.filter(
      (edge) => edge.source === sourceAgentId && edge.triggerOn === triggerOn,
    );
  }

  private moveTaskToWaiting(projectId: string, taskId: string, sourceAgentId: string) {
    const currentTask = this.store.getTask(taskId);
    if (currentTask.status === "waiting") {
      return;
    }

    if (!this.updateTaskStatusIfActive(taskId, "waiting", null)) {
      return;
    }
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

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  }

  private findProjectRecordByPath(projectPath: string): ProjectRecord | null {
    const normalized = path.resolve(projectPath);
    return (
      this.store.listProjects().find((project) => path.resolve(project.path) === normalized) ?? null
    );
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

  private scheduleRuntimeRefresh(projectPath: string, sessionId: string | null) {
    const project = this.findProjectRecordByPath(projectPath);
    if (!project) {
      return;
    }

    const existing = this.pendingRuntimeRefreshProjects.get(project.id);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.pendingRuntimeRefreshProjects.delete(project.id);
      this.emit({
        type: "runtime-updated",
        projectId: project.id,
        payload: {
          sessionId,
          timestamp: new Date().toISOString(),
        },
      });
    }, this.runtimeRefreshDebounceMs);
    this.pendingRuntimeRefreshProjects.set(project.id, timer);
  }

  private scheduleEventStreamReconnect(projectPath: string) {
    const normalized = path.resolve(projectPath);
    if (this.pendingEventReconnects.has(normalized)) {
      return;
    }

    const timer = setTimeout(() => {
      this.pendingEventReconnects.delete(normalized);
      if (!this.findProjectRecordByPath(normalized)) {
        return;
      }
      void this.ensureEventStream(normalized);
    }, 1000);
    this.pendingEventReconnects.set(normalized, timer);
  }

  private emit(event: AgentFlowEvent) {
    this.events.emit("agentflow-event", event);
  }

  private async ensureEventStream(projectPath?: string) {
    if (!this.enableEventStream) {
      return;
    }

    if (projectPath) {
      const normalized = path.resolve(projectPath);
      if (this.connectedEventProjects.has(normalized)) {
        return;
      }
      this.connectedEventProjects.add(normalized);
      void this.opencodeClient.connectEvents(normalized, (event) => {
        this.scheduleRuntimeRefresh(normalized, this.extractSessionIdFromOpenCodeEvent(event));
      })
        .catch(() => undefined)
        .finally(() => {
          this.connectedEventProjects.delete(normalized);
          this.scheduleEventStreamReconnect(normalized);
        });
      return;
    }

    await Promise.all(
      this.store.listProjects().map((project) => this.ensureEventStream(project.path)),
    );
  }
}
