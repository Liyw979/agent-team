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
  createDefaultTopology,
  type AgentFileRecord,
  type CreateProjectPayload,
  type DeleteTaskPayload,
  type GetTaskRuntimePayload,
  type InitializeTaskPayload,
  isBuiltinAgentPath,
  getProjectNameFromPath,
  type MessageRecord,
  type OpenTaskSessionPayload,
  type ProjectRecord,
  type ProjectSnapshot,
  type ReadAgentFilePayload,
  resolveTopologyAgentOrder,
  resolveTopologyRootAgent,
  type SubmitTaskPayload,
  type TaskAgentRecord,
  type TaskPanelRecord,
  type TaskRecord,
  type TaskSnapshot,
  type TopologyRecord,
  type UpdateTopologyPayload,
} from "@shared/types";
import { AgentFileService } from "./agent-files";
import { OpenCodeClient } from "./opencode-client";
import { OpenCodeRunner } from "./opencode-runner";
import { StoreService } from "./store";
import { ZellijManager } from "./zellij-manager";

const execFileAsync = promisify(execFile);

interface OrchestratorOptions {
  userDataPath: string;
  autoOpenTaskSession?: boolean;
  enableEventStream?: boolean;
}

interface ParsedSignal {
  done: boolean;
  targets: string[];
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
  deliveredMessageIdsByAgent: Map<string, Set<string>>;
}

interface AgentExecutionPrompt {
  from: string;
  message: string;
  requirement?: string;
}

const SELF_REVIEW_PROMPT = `在你完成本轮所有工作后，必须用中文严格按照以下格式给出最终决策，不要有任何其他解释或额外文字：
- 如果你认为自己负责的任务已完全完成（或你负责审核的部分已严格通过），请直接输出：【DECISION】检查通过
- 如果存在问题需要修改，请直接输出：【DECISION】需要修改
具体修改意见：（此处详细列出需要修改的点，越具体越好）`;

export class Orchestrator {
  private readonly store: StoreService;
  private readonly agentFiles = new AgentFileService();
  private readonly opencodeClient: OpenCodeClient;
  private readonly opencodeRunner: OpenCodeRunner;
  private readonly zellijManager = new ZellijManager();
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
  }

  async initialize() {
    await this.ensureEventStream();

    const existing = this.store.listProjects();
    if (existing.length === 0) {
      await this.createProject({
        path: process.cwd(),
      });
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

    if (payload.taskId) {
      return this.continueTask(project, payload.taskId, payload.content, payload.mentionAgent, agentFiles);
    }

    const initialized = await this.createTask(project, agentFiles, {
      preferredEntryAgent: payload.mentionAgent || this.extractMention(payload.content),
      title: this.createTaskTitle(payload.content),
      source: "submit",
    });

    return this.continueTask(
      project,
      initialized.task.id,
      payload.content,
      payload.mentionAgent,
      agentFiles,
    );
  }

  async initializeTask(payload: InitializeTaskPayload): Promise<TaskSnapshot> {
    const project = this.store.getProject(payload.projectId);
    const agentFiles = this.agentFiles.listAgentFiles(project.id, project.path);
    this.syncTopology(project, agentFiles);

    return this.createTask(project, agentFiles, {
      preferredEntryAgent: payload.entryAgent,
      title: (payload.title ?? "").trim() || "未命名任务",
      source: "initialize",
    });
  }

  async focusAgentPANEL(_projectId: string, taskId: string, agentId: string) {
    const panel = this.store.listTaskPanels(taskId).find((item) => item.agentName === agentId);
    if (!panel) {
      return;
    }
    await this.zellijManager.focusAgentPANEL(panel);
  }

  async openTaskSession(payload: OpenTaskSessionPayload): Promise<void> {
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
      preferredEntryAgent?: string;
      title: string;
      source: "initialize" | "submit";
    },
  ): Promise<TaskSnapshot> {
    const entryAgent = this.resolveEntryAgent(
      project.id,
      agentFiles,
      options.preferredEntryAgent,
    );
    if (!entryAgent) {
      throw new Error("当前项目没有可用的 Agent 文件");
    }

    const taskId = randomUUID();
    const zellijSessionId = await this.zellijManager.createTaskSession(project.id, taskId);

    const task: TaskRecord = {
      id: taskId,
      projectId: project.id,
      title: options.title,
      entryAgentId: entryAgent.name,
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

    const taskCreatedMessage: MessageRecord = {
      id: randomUUID(),
      projectId: project.id,
      taskId,
      content:
        options.source === "initialize"
          ? `Task 已初始化，入口 Agent 为 @${entryAgent.name}。系统已扫描 ${agentFiles.length} 个 Project 级 Agent，并完成当前 Task 的 Zellij / OpenCode 运行时初始化，等待首条发送给 @${entryAgent.name} 的消息。`
          : `Task 已创建并完成初始化，入口 Agent 为 @${entryAgent.name}。系统已扫描 ${agentFiles.length} 个 Project 级 Agent，并已为当前 Task 准备好全部 Agent pane 与会话。`,
      sender: "system",
      timestamp: new Date().toISOString(),
      meta: {
        kind: "task-created",
      },
    };
    this.store.insertMessage(taskCreatedMessage);

    this.taskRuntime.set(taskId, {
      completedEdges: new Set(),
      lastSignatureByAgent: new Map(),
      runningAgents: new Set(),
      deliveredMessageIdsByAgent: new Map(),
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
    mentionAgent: string | undefined,
    agentFiles: AgentFileRecord[],
  ): Promise<TaskSnapshot> {
    const task = this.store.getTask(taskId);
    if (task.projectId !== project.id) {
      throw new Error("Task 不属于当前 Project");
    }

    this.syncTaskAgents(task, agentFiles);
    const mentionName = mentionAgent || this.extractMention(content) || task.entryAgentId;
    const targetAgent = this.findAgentFile(agentFiles, mentionName);

    if (!targetAgent) {
      throw new Error(`未找到被 @ 的 Agent：${mentionName}`);
    }

    await this.ensureTaskInitialized(project, task, agentFiles);
    const runtime = this.getRuntime(task.id);
    if (targetAgent.name === task.entryAgentId && !runtime.lastSignatureByAgent.has(targetAgent.name)) {
      runtime.lastSignatureByAgent.set(targetAgent.name, `entry:${task.id}`);
    }

    const message = this.createUserMessage(project.id, task.id, task.title, content);
    this.store.insertMessage(message);
    this.emit({
      type: "message-created",
      projectId: project.id,
      payload: message,
    });

    const runPromise = this.runAgent(project, this.store.getTask(task.id), targetAgent.name, {
      from: "User",
      message: content,
      requirement: "请基于 [Message] 中的用户请求，继续完成你当前负责的工作。",
    });
    this.markMessagesDelivered(task.id, targetAgent.name, [message.id]);
    void runPromise.catch((error) => {
      console.error("[orchestrator] 后台发送任务失败", {
        taskId: task.id,
        agentName: targetAgent.name,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return this.hydrateTask(task.id);
  }

  private createUserMessage(
    projectId: string,
    taskId: string,
    taskTitle: string,
    content: string,
  ): MessageRecord {
    return {
      id: randomUUID(),
      projectId,
      taskId,
      content,
      sender: "user",
      timestamp: new Date().toISOString(),
      meta: {
        scope: "task",
        taskTitle,
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
  ) {
    const runtime = this.getRuntime(task.id);
    runtime.runningAgents.add(agentName);

    this.store.updateTaskAgentRun(task.id, agentName, "running");
    this.store.updateTaskStatus(task.id, "running", null);
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

      const dispatchedContent = this.buildAgentExecutionPrompt(prompt);
      await this.opencodeClient.reloadConfig(project.path);
      const response = await this.opencodeRunner.run({
        projectPath: project.path,
        sessionId: agentSessionId,
        content: dispatchedContent,
        agent: agentName,
        system: this.createSystemPrompt(latestAgentFile),
      });

      if (response.status === "error") {
        throw new Error(
          response.rawMessage.error || response.finalMessage || `${agentName} 返回错误状态`,
        );
      }

      const parsedReview = this.parseReview(response.finalMessage);
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
          finalMessage: parsedReview.cleanContent,
          reviewDecision: parsedReview.decision,
          reviewFeedback: parsedReview.feedback ?? "",
          rawResponse: response.finalMessage,
          sessionId: agentSessionId,
        },
      };
      this.store.insertMessage(taskMessage);

      const agentStatus = parsedReview.decision === "needs_revision" ? "needs_revision" : "success";
      this.store.updateTaskAgentStatus(task.id, agentName, agentStatus);
      this.store.updateTaskStatus(task.id, agentStatus === "needs_revision" ? "needs_revision" : "running", null);
      runtime.runningAgents.delete(agentName);

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
      if (parsedReview.decision === "needs_revision") {
        await this.handleRevision(project, task.id, agentName, parsedReview, signal, taskMessage.content);
        this.emit({
          type: "task-updated",
          projectId: project.id,
          payload: this.hydrateTask(task.id),
        });
        return;
      }

      const triggered = await this.triggerDownstream(project, task.id, agentName, parsedReview.cleanContent, signal);
      const topology = this.store.getTopology(project.id);

      if (
        signal.done ||
        (agentName === task.entryAgentId &&
          triggered === 0 &&
          this.hasCompletedIncomingSuccess(topology, runtime.completedEdges, agentName))
      ) {
        await this.completeTask(task.id, "success");
      }
    } catch (error) {
      runtime.runningAgents.delete(agentName);
      this.store.updateTaskAgentStatus(task.id, agentName, "failed");
      await this.completeTask(task.id, "failed");

      const failedMessage: MessageRecord = {
        id: randomUUID(),
        projectId: project.id,
        taskId: task.id,
        content: `[${agentName}] 执行失败：${error instanceof Error ? error.message : "未知错误"}`,
        sender: "system",
        timestamp: new Date().toISOString(),
      };
      this.store.insertMessage(failedMessage);

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
    }
  }

  private async triggerDownstream(
    project: ProjectRecord,
    taskId: string,
    sourceAgentId: string,
    content: string,
    signal: ParsedSignal,
  ): Promise<number> {
    const runtime = this.getRuntime(taskId);
    const topology = this.store.getTopology(project.id);
    const agents = this.store.listTaskAgents(taskId);
    const outgoing = topology.edges.filter((edge) => edge.source === sourceAgentId);
    const completed = new Set(runtime.completedEdges);

    for (const edge of outgoing.filter((item) => item.triggerOn === "success")) {
      completed.add(edge.id);
      runtime.completedEdges.add(edge.id);
    }

    const targetNames = new Set<string>();
    if (signal.targets.length > 0) {
      for (const target of signal.targets) {
        const edge = outgoing.find(
          (item) =>
            item.target === target &&
            (item.triggerOn === "success" || item.triggerOn === "manual"),
        );
        if (!edge) {
          this.emitTopologyBlockedMessage(project.id, taskId, sourceAgentId, target);
          continue;
        }
        completed.add(edge.id);
        runtime.completedEdges.add(edge.id);
        targetNames.add(target);
      }
    } else {
      for (const edge of outgoing.filter((item) => item.triggerOn === "success")) {
        targetNames.add(edge.target);
      }
    }

    const readyTargets = [...targetNames].filter((targetName) =>
      this.canTriggerTarget(taskId, topology, completed, targetName, runtime),
    );

    if (readyTargets.length === 0) {
      const hasAutomaticOutgoing = outgoing.some((edge) => edge.triggerOn === "success");
      if (outgoing.length > 0 && !hasAutomaticOutgoing && signal.targets.length === 0 && !signal.done) {
        const waitingMessage = {
          id: randomUUID(),
          projectId: project.id,
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
          projectId: project.id,
          payload: waitingMessage,
        });
      }
      return 0;
    }

    const triggerMessage: MessageRecord = {
      id: randomUUID(),
      projectId: project.id,
      taskId,
      sender: sourceAgentId,
      timestamp: new Date().toISOString(),
      content: `${readyTargets.map((targetName) => `@${targetName}`).join(" ")} 请基于我刚刚完成的结果继续处理。`,
      meta: {
        kind: "high-level-trigger",
        sourceAgentId,
        targetAgentIds: readyTargets.join(","),
      },
    };
    this.store.insertMessage(triggerMessage);
    this.emit({
      type: "message-created",
      projectId: project.id,
      payload: triggerMessage,
    });

    const gitDiffSummary = await this.buildProjectGitDiffSummary(task.cwd);

    await Promise.all(
      readyTargets.map(async (targetName) => {
        const targetAgent = agents.find((item) => item.name === targetName);
        if (!targetAgent) {
          return;
        }

        const incrementalContext = this.buildIncrementalAgentContext(taskId, targetName);
        const forwardedMessage =
          incrementalContext.content.trim().length > 0
            ? `${incrementalContext.content}\n\n请基于以上新增历史继续处理当前任务。`
            : `上游 Agent ${sourceAgentId} 已完成，请继续处理以下上下文：\n\n${content}`;
        const forwardedRequirement = this.buildAgentHandoffRequirement(
          "请结合 [Message] 中的上下文继续推进当前任务，并只关注你当前负责的部分。",
          gitDiffSummary,
        );
        const signature = this.buildTriggerSignature(topology, completed, targetName);
        runtime.lastSignatureByAgent.set(targetName, signature);
        this.markMessagesDelivered(taskId, targetName, incrementalContext.messageIds);
        await this.runAgent(project, this.store.getTask(taskId), targetName, {
          from: sourceAgentId,
          message: forwardedMessage,
          requirement: forwardedRequirement,
        });
      }),
    );

    return readyTargets.length;
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

    const incomingSuccessEdges = topology.edges.filter(
      (edge) => edge.target === targetName && edge.triggerOn === "success",
    );
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

  private emitTopologyBlockedMessage(
    projectId: string,
    taskId: string,
    sourceAgentId: string,
    targetAgentId: string,
  ) {
    const blockedMessage: MessageRecord = {
      id: randomUUID(),
      projectId,
      taskId,
      content: `系统提示：当前 Project 拓扑未允许 @${sourceAgentId} 触发 @${targetAgentId}，因此未执行该下游派发。`,
      sender: "system",
      timestamp: new Date().toISOString(),
      meta: {
        kind: "topology-blocked",
        sourceAgentId,
        targetAgentId,
      },
    };
    this.store.insertMessage(blockedMessage);
    this.emit({
      type: "message-created",
      projectId,
      payload: blockedMessage,
    });
  }

  private buildTriggerSignature(
    topology: TopologyRecord,
    completedEdges: Set<string>,
    targetName: string,
  ): string {
    const relevantEdgeIds = topology.edges
      .filter((edge) => edge.target === targetName && completedEdges.has(edge.id))
      .map((edge) => edge.id)
      .sort();
    return relevantEdgeIds.join("|") || `direct:${targetName}`;
  }

  private hasCompletedIncomingSuccess(
    topology: TopologyRecord,
    completedEdges: Set<string>,
    agentName: string,
  ): boolean {
    return topology.edges.some(
      (edge) =>
        edge.target === agentName &&
        edge.triggerOn === "success" &&
        completedEdges.has(edge.id),
    );
  }

  private parseSignal(content: string): ParsedSignal {
    const nextMatch = content.match(/NEXT_AGENTS:\s*(.+)$/im);
    const targets = nextMatch
      ? nextMatch[1]
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : [];

    return {
      done: /\bTASK_DONE\b/i.test(content),
      targets,
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
        : /【DECISION】\s*检查通过/.test(decisionBlock)
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
    const from = prompt.from.trim() || "System";
    const message = prompt.message.trim() || "（无）";
    const requirement = this.buildAgentExecutionRequirement(prompt.requirement);
    return [`[From] ${from}`, `[Message]\n${message}`, `[Requeirement]\n${requirement}`]
      .join("\n\n")
      .trim();
  }

  private buildAgentExecutionRequirement(requirement?: string): string {
    return [requirement ?? "", SELF_REVIEW_PROMPT]
      .map((item) => item.trim())
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }

  private extractDisplaySummary(content: string): string | null {
    const normalized = content
      .replace(/\r/g, "")
      .split(/\n+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (normalized.length === 0) {
      return null;
    }

    const lastBlock = normalized.at(-1) ?? "";
    const sentences =
      lastBlock
        .match(/[^。！？!?]+[。！？!?]?/g)
        ?.map((item) => item.trim())
        .filter(Boolean) ?? [];
    const lastSentence = (sentences.at(-1) ?? lastBlock)
      .replace(/^[-*]\s+/u, "")
      .replace(/^\d+[.)、]\s*/u, "")
      .trim();

    return lastSentence || lastBlock || null;
  }

  private createDisplayContent(parsedReview: ParsedReview, fallbackMessage?: string | null): string {
    if (parsedReview.cleanContent.trim()) {
      return this.extractDisplaySummary(parsedReview.cleanContent) ?? parsedReview.cleanContent.trim();
    }
    if (fallbackMessage?.trim()) {
      return this.extractDisplaySummary(fallbackMessage) ?? fallbackMessage.trim();
    }
    if (parsedReview.decision === "needs_revision") {
      return "（该 Agent 已给出“需要修改”的决策，详细修改意见由 Orchestrator 以返工消息形式展示。）";
    }
    if (parsedReview.decision === "pass") {
      return "（该 Agent 已完成本轮工作并通过自检，未额外返回高层说明。）";
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

  private async handleRevision(
    project: ProjectRecord,
    taskId: string,
    sourceAgentId: string,
    parsedReview: ParsedReview,
    signal: ParsedSignal,
    visibleContent: string,
  ) {
    const task = this.store.getTask(taskId);
    const topology = this.store.getTopology(project.id);
    const downstreamAgents = this.collectReachableTargets(topology, sourceAgentId);
    for (const agentName of downstreamAgents) {
      this.store.updateTaskAgentStatus(taskId, agentName, "needs_revision");
    }
    this.store.updateTaskStatus(taskId, "needs_revision", null);

    const revisionTargets = this.resolveRevisionTargets(task, topology, sourceAgentId, signal);
    const feedback = parsedReview.feedback ?? "请根据当前审查意见补充必要修改。";
    const contextSummary = visibleContent.trim()
      ? `当前阶段高层结果：\n${visibleContent.trim()}\n\n`
      : "";

    if (revisionTargets.length === 0) {
      const noTargetMessage: MessageRecord = {
        id: randomUUID(),
        projectId: project.id,
        taskId,
        sender: "system",
        timestamp: new Date().toISOString(),
        content: `@${sourceAgentId} 返回“需要修改”，但当前未能从拓扑中解析出明确返工目标。请手动在 Task 群聊中 @ 对应 Agent 继续处理。\n\n具体修改意见：\n${feedback}`,
        meta: {
          kind: "revision-request",
          sourceAgentId,
        },
      };
      this.store.insertMessage(noTargetMessage);
      this.emit({
        type: "message-created",
        projectId: project.id,
        payload: noTargetMessage,
      });
      return;
    }

    await Promise.all(
      revisionTargets.map(async (targetName) => {
        const revisionMessage: MessageRecord = {
          id: randomUUID(),
          projectId: project.id,
          taskId,
          sender: sourceAgentId,
          timestamp: new Date().toISOString(),
          content: `@${targetName} 需要返工，请根据以下修改意见继续处理。\n\n${contextSummary}具体修改意见：\n${feedback}`,
          meta: {
            kind: "revision-request",
            sourceAgentId,
            targetAgentId: targetName,
          },
        };
        this.store.insertMessage(revisionMessage);
        this.emit({
          type: "message-created",
          projectId: project.id,
          payload: revisionMessage,
        });

        const incrementalContext = this.buildIncrementalAgentContext(taskId, targetName);
        const forwardedMessage =
          incrementalContext.content.trim().length > 0
            ? `${incrementalContext.content}\n\n请根据以上新增历史继续返工，并重点处理以下修改意见：\n${feedback}`
            : `返工来源 Agent：${sourceAgentId}\n\n${contextSummary}具体修改意见：\n${feedback}`;
        this.markMessagesDelivered(taskId, targetName, incrementalContext.messageIds);
        await this.runAgent(project, this.store.getTask(taskId), targetName, {
          from: sourceAgentId,
          message: forwardedMessage,
          requirement: "请根据 [Message] 中的返工背景与修改意见继续处理，并优先修复阻塞当前链路的问题。",
        });
      }),
    );
  }

  private resolveRevisionTargets(
    task: TaskRecord,
    topology: TopologyRecord,
    sourceAgentId: string,
    signal: ParsedSignal,
  ): string[] {
    const fromSignal = signal.targets.filter((target) =>
      topology.edges.some(
        (edge) =>
          edge.source === sourceAgentId &&
          edge.target === target &&
          (edge.triggerOn === "failed" || edge.triggerOn === "manual"),
      ),
    );
    if (fromSignal.length > 0) {
      return [...new Set(fromSignal)];
    }

    const outgoingFailedTargets = topology.edges
      .filter((edge) => edge.source === sourceAgentId && edge.triggerOn === "failed")
      .map((edge) => edge.target);

    if (outgoingFailedTargets.length > 0) {
      return [...new Set(outgoingFailedTargets)];
    }

    const outgoingSuccessTargets = topology.edges
      .filter((edge) => edge.source === sourceAgentId && edge.triggerOn === "success")
      .map((edge) => edge.target);

    if (sourceAgentId === task.entryAgentId && outgoingSuccessTargets.length > 0) {
      return [...new Set(outgoingSuccessTargets)];
    }

    const incomingSources = topology.edges
      .filter((edge) => edge.target === sourceAgentId && edge.triggerOn === "success")
      .map((edge) => edge.source);

    if (incomingSources.length > 0) {
      return [...new Set(incomingSources)];
    }

    return [...new Set(outgoingSuccessTargets)];
  }

  private collectReachableTargets(topology: TopologyRecord, sourceAgentId: string): string[] {
    const visited = new Set<string>([sourceAgentId]);
    const queue = [sourceAgentId];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      for (const edge of topology.edges.filter((item) => item.source === current)) {
        if (!visited.has(edge.target)) {
          visited.add(edge.target);
          queue.push(edge.target);
        }
      }
    }
    visited.delete(sourceAgentId);
    return [...visited];
  }

  private createSystemPrompt(_agent: AgentFileRecord): string {
    const orchestrationRules =
      "请只关注你当前负责的工作本身，不要假设还有其他 Agent，也不要描述任何调度链路。先输出对用户有意义的高层结果；用户消息末尾会自动附带自检要求，请严格按该要求输出最终的【DECISION】结论。";
    return orchestrationRules;
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

  private resolveEntryAgent(
    projectId: string,
    agentFiles: AgentFileRecord[],
    preferredEntryAgent: string | undefined,
  ): AgentFileRecord | undefined {
    const preferred = this.findAgentFile(agentFiles, preferredEntryAgent);
    if (preferred) {
      return preferred;
    }

    const topology = this.store.getTopology(projectId);
    const orderedAgentNames = resolveTopologyAgentOrder(
      agentFiles.map((agent) => ({
        name: agent.name,
        mode: agent.mode,
        role: agent.role,
        relativePath: agent.relativePath,
      })),
      topology.agentOrderIds,
    );

    return this.findAgentFile(agentFiles, orderedAgentNames[0]) ?? agentFiles[0];
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
    const edges = topology.edges
      .filter((edge) => validNames.has(edge.source) && validNames.has(edge.target))
      .filter((edge) => {
        const key = `${edge.source}__${edge.target}__${edge.triggerOn}`;
        if (seenEdges.has(key)) {
          return false;
        }
        seenEdges.add(key);
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
      rootAgentId: resolveTopologyRootAgent(
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
          : `Task「${snapshot.task.title}」执行失败，请根据当前群聊消息和对应 Agent 状态继续排查。`,
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
        deliveredMessageIdsByAgent: new Map(),
      };
      this.taskRuntime.set(taskId, runtime);
    }
    return runtime;
  }

  private buildIncrementalAgentContext(
    taskId: string,
    targetAgentName: string,
  ): { content: string; messageIds: string[] } {
    const task = this.store.getTask(taskId);
    const runtime = this.getRuntime(taskId);
    const delivered = runtime.deliveredMessageIdsByAgent.get(targetAgentName) ?? new Set<string>();
    const allMessages = this.store.listMessages(task.projectId, taskId);
    const contextMessages = allMessages.filter((message) => {
      if (delivered.has(message.id)) {
        return false;
      }
      if (message.meta?.optimistic === "true") {
        return false;
      }
      if (message.meta?.kind === "task-created" || message.meta?.kind === "task-completed") {
        return false;
      }
      return true;
    });

    if (contextMessages.length === 0) {
      return {
        content: "",
        messageIds: [],
      };
    }

    const rendered = contextMessages
      .map((message) => this.renderContextMessage(message))
      .filter(Boolean)
      .join("\n\n");

    return {
      content: `以下是你尚未收到的群聊历史，请按时间顺序阅读：\n\n${rendered}`.trim(),
      messageIds: contextMessages.map((message) => message.id),
    };
  }

  private renderContextMessage(message: MessageRecord): string {
    const time = this.toShortTime(message.timestamp);
    const sender = this.getMessageSenderLabel(message);
    const content = message.content.trim();
    if (!content) {
      return "";
    }
    return `[${time}] ${sender}\n${content}`;
  }

  private markMessagesDelivered(taskId: string, targetAgentName: string, messageIds: string[]) {
    if (messageIds.length === 0) {
      return;
    }
    const runtime = this.getRuntime(taskId);
    const delivered = runtime.deliveredMessageIdsByAgent.get(targetAgentName) ?? new Set<string>();
    for (const messageId of messageIds) {
      delivered.add(messageId);
    }
    runtime.deliveredMessageIdsByAgent.set(targetAgentName, delivered);
  }

  private getMessageSenderLabel(message: MessageRecord) {
    if (message.sender === "user") {
      return "User";
    }
    if (message.sender === "system") {
      return "System";
    }
    return message.sender;
  }

  private toShortTime(timestamp: string) {
    const value = new Date(timestamp);
    if (Number.isNaN(value.getTime())) {
      return timestamp;
    }
    return value.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
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
