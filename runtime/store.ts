import fs from "node:fs";
import path from "node:path";
import { createTopologyLangGraphRecord, normalizeNeedsRevisionMaxRounds } from "@shared/types";
import type {
  MessageRecord,
  TaskAgentRecord,
  TaskRecord,
  TopologyRecord,
} from "@shared/types";
import {
  findTaskLocatorCwd,
  removeTaskLocatorEntry,
  upsertTaskLocatorEntry,
  type TaskLocatorEntry,
} from "./task-index";
import { writeFileAtomicSync } from "./atomic-file";

interface WorkspaceStateFile {
  version: number;
  topology: TopologyRecord;
  tasks: TaskRecord[];
  taskAgents: TaskAgentRecord[];
  messages: MessageRecord[];
}

interface TaskLocatorIndexFile {
  version: number;
  tasks: TaskLocatorEntry[];
}

type WorkspaceStateAccessMode = "read" | "write";

const WORKSPACE_DATA_DIR_NAME = ".agent-team";
const WORKSPACE_STATE_FILE_NAME = "state.json";
const TASK_LOCATOR_INDEX_FILE_NAME = "task-locator.json";

function sortByCreatedAtDesc<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function sortMessages(messages: MessageRecord[]): MessageRecord[] {
  return [...messages].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(item.id, item);
  }
  return [...map.values()];
}

function normalizeMessageMeta(meta: unknown): Record<string, string> | undefined {
  if (!meta || typeof meta !== "object") {
    return undefined;
  }

  const normalizedEntries = Object.entries(meta).filter(
    (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
  );
  return normalizedEntries.length > 0 ? Object.fromEntries(normalizedEntries) : undefined;
}

function normalizeMessageContent(content: string, meta?: Record<string, string>) {
  if (meta?.kind === "agent-final") {
    const finalMessage = meta.finalMessage?.trim();
    if (finalMessage) {
      return finalMessage;
    }
  }

  return content;
}

function normalizeTopologyNodes(topology: Record<string, unknown>): string[] {
  if (Array.isArray(topology.nodes)) {
    const nextNodes = topology.nodes
      .map((node) => {
        if (typeof node === "string") {
          return node;
        }
        if (node && typeof node === "object" && typeof node.id === "string") {
          return node.id;
        }
        return null;
      })
      .filter((node): node is string => typeof node === "string" && node.length > 0);
    if (nextNodes.length > 0) {
      return nextNodes;
    }
  }

  if (Array.isArray(topology.agentOrderIds)) {
    return topology.agentOrderIds.filter((item): item is string => typeof item === "string" && item.length > 0);
  }

  return [];
}

function createDefaultWorkspaceState(): WorkspaceStateFile {
  return {
    version: 1,
    topology: {
      nodes: [],
      edges: [],
      langgraph: createTopologyLangGraphRecord({
        nodes: [],
        edges: [],
        endSources: null,
      }),
    },
    tasks: [],
    taskAgents: [],
    messages: [],
  };
}

function serializeTaskRecord(task: TaskRecord) {
  const { opencodeSessionId: _ignored, ...serialized } = task;
  return serialized;
}

function serializeTaskAgentRecord(agent: TaskAgentRecord) {
  const {
    opencodeSessionId: _ignoredSessionId,
    opencodeAttachBaseUrl: _ignoredAttachBaseUrl,
    ...serialized
  } = agent;
  return serialized;
}

export function shouldMaterializeWorkspaceState(input: {
  accessMode: WorkspaceStateAccessMode;
  stateFileExists: boolean;
  rawState: string | null;
}) {
  if (input.accessMode !== "write") {
    return false;
  }

  if (!input.stateFileExists) {
    return true;
  }

  return false;
}

export class StoreService {
  private readonly userDataPath: string;

  constructor(userDataPath: string) {
    this.userDataPath = path.resolve(userDataPath);
    fs.mkdirSync(this.userDataPath, { recursive: true });
  }

  listTasks(cwd: string): TaskRecord[] {
    return sortByCreatedAtDesc(this.readWorkspaceState(cwd).tasks);
  }

  getTask(cwd: string, taskId: string): TaskRecord {
    const task = this.readWorkspaceState(cwd).tasks.find((item) => item.id === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    return task;
  }

  insertTask(record: TaskRecord) {
    this.updateWorkspaceState(record.cwd, (state) => ({
      ...state,
      tasks: uniqueById([...state.tasks, record]),
    }));
    this.updateTaskLocatorIndex((state) => ({
      ...state,
      tasks: upsertTaskLocatorEntry(state.tasks, {
        taskId: record.id,
        cwd: path.resolve(record.cwd),
      }),
    }));
  }

  deleteTask(cwd: string, taskId: string) {
    this.updateWorkspaceState(cwd, (state) => ({
      ...state,
      tasks: state.tasks.filter((task) => task.id !== taskId),
      taskAgents: state.taskAgents.filter((agent) => agent.taskId !== taskId),
      messages: state.messages.filter((message) => message.taskId !== taskId),
    }));
    this.removeTaskLocator(taskId);
  }

  getTaskLocatorCwd(taskId: string): string | null {
    return findTaskLocatorCwd(this.readTaskLocatorIndex().tasks, taskId);
  }

  removeTaskLocator(taskId: string) {
    this.updateTaskLocatorIndex((state) => ({
      ...state,
      tasks: removeTaskLocatorEntry(state.tasks, taskId),
    }));
  }

  updateTaskStatus(cwd: string, taskId: string, status: TaskRecord["status"], completedAt: string | null = null) {
    this.updateWorkspaceState(cwd, (state) => ({
      ...state,
      tasks: state.tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              status,
              completedAt,
            }
          : task,
      ),
    }));
  }

  updateTaskAgentCount(cwd: string, taskId: string, agentCount: number) {
    this.updateWorkspaceState(cwd, (state) => ({
      ...state,
      tasks: state.tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              agentCount,
            }
          : task,
      ),
    }));
  }

  updateTaskInitialized(cwd: string, taskId: string, initializedAt: string) {
    this.updateWorkspaceState(cwd, (state) => ({
      ...state,
      tasks: state.tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              initializedAt,
            }
          : task,
      ),
    }));
  }

  listTaskAgents(cwd: string, taskId: string): TaskAgentRecord[] {
    return [...this.readWorkspaceState(cwd).taskAgents]
      .filter((agent) => agent.taskId === taskId)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  insertTaskAgent(cwd: string, record: TaskAgentRecord) {
    this.updateWorkspaceState(cwd, (state) => ({
      ...state,
      taskAgents: uniqueById([...state.taskAgents, record]),
    }));
  }

  updateTaskAgentRun(cwd: string, taskId: string, agentName: string, status: TaskAgentRecord["status"]) {
    this.updateWorkspaceState(cwd, (state) => ({
      ...state,
      taskAgents: state.taskAgents.map((agent) =>
        agent.taskId === taskId && agent.name === agentName
          ? {
              ...agent,
              status,
              runCount: agent.runCount + 1,
            }
          : agent,
      ),
    }));
  }

  updateTaskAgentStatus(cwd: string, taskId: string, agentName: string, status: TaskAgentRecord["status"]) {
    this.updateWorkspaceState(cwd, (state) => ({
      ...state,
      taskAgents: state.taskAgents.map((agent) =>
        agent.taskId === taskId && agent.name === agentName
          ? {
              ...agent,
              status,
            }
          : agent,
      ),
    }));
  }

  getTopology(cwd: string): TopologyRecord {
    return this.readWorkspaceState(cwd).topology;
  }

  upsertTopology(cwd: string, topology: TopologyRecord) {
    this.updateWorkspaceState(cwd, (state) => ({
      ...state,
      topology,
    }));
  }

  listMessages(cwd: string, taskId?: string | null): MessageRecord[] {
    const scoped =
      typeof taskId === "string"
        ? this.readWorkspaceState(cwd).messages.filter((message) => message.taskId === taskId)
        : this.readWorkspaceState(cwd).messages;
    return sortMessages(scoped);
  }

  insertMessage(cwd: string, record: MessageRecord) {
    this.updateWorkspaceState(cwd, (state) => ({
      ...state,
      messages: sortMessages(uniqueById([...state.messages, record])),
    }));
  }

  getState(cwd: string): WorkspaceStateFile {
    return this.readWorkspaceState(cwd);
  }

  hasWorkspaceState(cwd: string): boolean {
    return fs.existsSync(this.getWorkspaceStatePath(cwd));
  }

  private getWorkspaceStatePath(cwd: string) {
    return path.join(path.resolve(cwd), WORKSPACE_DATA_DIR_NAME, WORKSPACE_STATE_FILE_NAME);
  }

  private getTaskLocatorIndexPath() {
    return path.join(this.userDataPath, TASK_LOCATOR_INDEX_FILE_NAME);
  }

  private readTaskLocatorIndex(): TaskLocatorIndexFile {
    const indexPath = this.getTaskLocatorIndexPath();
    if (!fs.existsSync(indexPath)) {
      const initialState: TaskLocatorIndexFile = {
        version: 1,
        tasks: [],
      };
      this.writeTaskLocatorIndex(initialState);
      return initialState;
    }

    const raw = fs.readFileSync(indexPath, "utf8").trim();
    if (!raw) {
      throw new Error(`${indexPath} 已存在但内容为空，已拒绝用空索引覆盖现有任务定位数据。`);
    }

    let parsed: Partial<TaskLocatorIndexFile>;
    try {
      parsed = JSON.parse(raw) as Partial<TaskLocatorIndexFile>;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${indexPath} JSON 解析失败：${reason}`);
    }
    return {
      version: 1,
      tasks: Array.isArray(parsed.tasks)
        ? parsed.tasks
            .filter((entry): entry is Partial<TaskLocatorEntry> => Boolean(entry) && typeof entry === "object")
            .map((entry) => ({
              taskId: typeof entry.taskId === "string" ? entry.taskId : "",
              cwd: typeof entry.cwd === "string" ? path.resolve(entry.cwd) : "",
            }))
            .filter((entry) => entry.taskId.length > 0 && entry.cwd.length > 0)
        : [],
    };
  }

  private readWorkspaceState(cwd: string, accessMode: WorkspaceStateAccessMode = "read"): WorkspaceStateFile {
    const normalizedCwd = path.resolve(cwd);
    const statePath = this.getWorkspaceStatePath(normalizedCwd);
    const initialState = createDefaultWorkspaceState();
    const stateFileExists = fs.existsSync(statePath);
    if (!stateFileExists) {
      if (shouldMaterializeWorkspaceState({
        accessMode,
        stateFileExists,
        rawState: null,
      })) {
        this.writeWorkspaceState(normalizedCwd, initialState);
      }
      return initialState;
    }

    const raw = fs.readFileSync(statePath, "utf8").trim();
    if (!raw) {
      if (shouldMaterializeWorkspaceState({
        accessMode,
        stateFileExists,
        rawState: raw,
      })) {
        this.writeWorkspaceState(normalizedCwd, initialState);
      }
      throw new Error(`${statePath} 已存在但内容为空，已拒绝把当前工作区状态重置成默认空状态。`);
    }

    let parsed: Partial<WorkspaceStateFile>;
    try {
      parsed = JSON.parse(raw) as Partial<WorkspaceStateFile>;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${statePath} JSON 解析失败：${reason}`);
    }
    const tasks: TaskRecord[] = Array.isArray(parsed.tasks)
      ? parsed.tasks
          .filter((task): task is Partial<TaskRecord> => Boolean(task) && typeof task === "object")
          .map((task) => ({
            id: typeof task.id === "string" ? task.id : "",
            title: typeof task.title === "string" ? task.title : "未命名任务",
            status:
              task.status === "running"
              || task.status === "waiting"
              || task.status === "finished"
              || task.status === "failed"
              || task.status === "needs_revision"
                ? task.status
                : "pending",
            cwd: typeof task.cwd === "string" ? task.cwd : normalizedCwd,
            opencodeSessionId: null,
            agentCount: typeof task.agentCount === "number" ? task.agentCount : 0,
            createdAt: typeof task.createdAt === "string" ? task.createdAt : new Date(0).toISOString(),
            completedAt: typeof task.completedAt === "string" ? task.completedAt : null,
            initializedAt: typeof task.initializedAt === "string" ? task.initializedAt : null,
          }))
          .filter((task) => task.id)
      : [];

    const finishedTaskIds = new Set(
      tasks.filter((task) => task.status === "finished").map((task) => task.id),
    );

    const taskAgents: TaskAgentRecord[] = Array.isArray(parsed.taskAgents)
      ? parsed.taskAgents
          .filter((agent): agent is Partial<TaskAgentRecord> => Boolean(agent) && typeof agent === "object")
          .map((agent) => {
            const taskId = typeof agent.taskId === "string" ? agent.taskId : "";
            const normalizedStatus =
              agent.status === "running"
              || agent.status === "completed"
              || agent.status === "failed"
              || agent.status === "needs_revision"
                ? agent.status
                : "idle";

            return {
              id: typeof agent.id === "string" ? agent.id : "",
              taskId,
              name: typeof agent.name === "string" ? agent.name : "",
              opencodeSessionId: null,
              opencodeAttachBaseUrl: null,
              status: finishedTaskIds.has(taskId) ? "completed" : normalizedStatus,
              runCount: typeof agent.runCount === "number" && Number.isFinite(agent.runCount) ? agent.runCount : 0,
            };
          })
          .filter((agent) => agent.id && agent.taskId && agent.name)
      : [];

    const topology: TopologyRecord =
      parsed.topology && typeof parsed.topology === "object"
        ? (() => {
            const nodes = normalizeTopologyNodes(parsed.topology);
            const edges = Array.isArray(parsed.topology.edges)
              ? parsed.topology.edges
                  .filter((edge): edge is Record<string, unknown> => Boolean(edge) && typeof edge === "object")
                  .map((edge) => ({
                    source: typeof edge.source === "string" ? edge.source : "",
                    target: typeof edge.target === "string" ? edge.target : "",
                    triggerOn: edge.triggerOn,
                    maxRevisionRounds: edge.maxRevisionRounds,
                  }))
                  .filter(
                    (edge): edge is TopologyRecord["edges"][number] =>
                      Boolean(edge.source)
                      && Boolean(edge.target)
                      && (
                        edge.triggerOn === "association"
                        || edge.triggerOn === "approved"
                        || edge.triggerOn === "needs_revision"
                      ),
                  )
                  .map((edge) => ({
                    source: edge.source,
                    target: edge.target,
                    triggerOn: edge.triggerOn,
                    ...(edge.triggerOn === "needs_revision"
                      ? {
                          maxRevisionRounds: normalizeNeedsRevisionMaxRounds(edge.maxRevisionRounds),
                        }
                      : {}),
                  }))
              : [];

            const rawLangGraph =
              parsed.topology.langgraph && typeof parsed.topology.langgraph === "object"
                ? parsed.topology.langgraph
                : null;

            return {
              nodes,
              edges,
              langgraph: createTopologyLangGraphRecord({
                nodes,
                edges,
                startTargets:
                  rawLangGraph
                  && rawLangGraph.start
                  && typeof rawLangGraph.start === "object"
                  && Array.isArray(rawLangGraph.start.targets)
                    ? rawLangGraph.start.targets.filter((value): value is string => typeof value === "string")
                    : undefined,
                endSources:
                  rawLangGraph
                  && rawLangGraph.end
                  && typeof rawLangGraph.end === "object"
                  && Array.isArray(rawLangGraph.end.sources)
                    ? rawLangGraph.end.sources.filter((value): value is string => typeof value === "string")
                    : rawLangGraph?.end === null
                      ? null
                      : undefined,
              }),
              nodeRecords: Array.isArray(parsed.topology.nodeRecords)
                ? parsed.topology.nodeRecords
                    .filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === "object")
                    .map((node) => ({
                      id: typeof node.id === "string" ? node.id : "",
                      kind: node.kind === "spawn" ? "spawn" : "agent",
                      templateName: typeof node.templateName === "string" ? node.templateName : "",
                      spawnRuleId: typeof node.spawnRuleId === "string" ? node.spawnRuleId : undefined,
                      spawnEnabled: node.spawnEnabled === true,
                      prompt: typeof node.prompt === "string" ? node.prompt : undefined,
                      writable: node.writable === true,
                    }))
                    .filter((node) => node.id && node.templateName)
                : undefined,
              spawnRules: Array.isArray(parsed.topology.spawnRules)
                ? parsed.topology.spawnRules
                    .filter((rule): rule is Record<string, unknown> => Boolean(rule) && typeof rule === "object")
                    .map((rule) => ({
                      id: typeof rule.id === "string" ? rule.id : "",
                      name: typeof rule.name === "string" ? rule.name : "",
                      sourceTemplateName: typeof rule.sourceTemplateName === "string" ? rule.sourceTemplateName : "",
                      itemKey: typeof rule.itemKey === "string" ? rule.itemKey : "",
                      entryRole: typeof rule.entryRole === "string" ? rule.entryRole : "",
                      spawnedAgents: Array.isArray(rule.spawnedAgents)
                        ? rule.spawnedAgents
                            .filter((agent): agent is Record<string, unknown> => Boolean(agent) && typeof agent === "object")
                            .map((agent) => ({
                              role: typeof agent.role === "string" ? agent.role : "",
                              templateName: typeof agent.templateName === "string" ? agent.templateName : "",
                            }))
                            .filter((agent) => agent.role && agent.templateName)
                        : [],
                      edges: Array.isArray(rule.edges)
                        ? rule.edges
                            .filter((edge): edge is Record<string, unknown> => Boolean(edge) && typeof edge === "object")
                            .map((edge) => ({
                              sourceRole: typeof edge.sourceRole === "string" ? edge.sourceRole : "",
                              targetRole: typeof edge.targetRole === "string" ? edge.targetRole : "",
                              triggerOn:
                                edge.triggerOn === "association"
                                || edge.triggerOn === "approved"
                                || edge.triggerOn === "needs_revision"
                                  ? edge.triggerOn
                                  : "association",
                            }))
                            .filter((edge) => edge.sourceRole && edge.targetRole)
                        : [],
                      exitWhen: rule.exitWhen === "one_side_agrees" ? "one_side_agrees" : "one_side_agrees",
                      reportToTemplateName: typeof rule.reportToTemplateName === "string" ? rule.reportToTemplateName : "",
                    }))
                    .filter(
                      (rule) =>
                        rule.id
                        && rule.name
                        && rule.sourceTemplateName
                        && rule.itemKey
                        && rule.entryRole
                        && rule.reportToTemplateName,
                    )
                : undefined,
            };
          })()
        : initialState.topology;

    const messages: MessageRecord[] = Array.isArray(parsed.messages)
      ? parsed.messages
          .filter((message): message is Partial<MessageRecord> => Boolean(message) && typeof message === "object")
          .map((message) => {
            const meta = normalizeMessageMeta(message.meta);
            const content =
              typeof message.content === "string" ? normalizeMessageContent(message.content, meta) : "";
            return {
              id: typeof message.id === "string" ? message.id : "",
              taskId: typeof message.taskId === "string" ? message.taskId : null,
              content,
              sender: typeof message.sender === "string" ? message.sender : "system",
              timestamp: typeof message.timestamp === "string" ? message.timestamp : new Date(0).toISOString(),
              meta,
            } satisfies MessageRecord;
          })
          .filter((message) => message.id)
      : [];

    return {
      version: 1,
      topology,
      tasks,
      taskAgents,
      messages,
    };
  }

  private writeWorkspaceState(cwd: string, state: WorkspaceStateFile) {
    const statePath = this.getWorkspaceStatePath(cwd);
    const sanitized: WorkspaceStateFile = {
      ...state,
      tasks: state.tasks.map(serializeTaskRecord) as TaskRecord[],
      taskAgents: state.taskAgents.map(serializeTaskAgentRecord) as TaskAgentRecord[],
    };
    writeFileAtomicSync(statePath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
  }

  private writeTaskLocatorIndex(state: TaskLocatorIndexFile) {
    const indexPath = this.getTaskLocatorIndexPath();
    writeFileAtomicSync(indexPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private updateWorkspaceState(cwd: string, updater: (state: WorkspaceStateFile) => WorkspaceStateFile) {
    const normalizedCwd = path.resolve(cwd);
    const current = this.readWorkspaceState(normalizedCwd, "write");
    const next = updater(current);
    this.writeWorkspaceState(normalizedCwd, next);
  }

  private updateTaskLocatorIndex(updater: (state: TaskLocatorIndexFile) => TaskLocatorIndexFile) {
    const current = this.readTaskLocatorIndex();
    const next = updater(current);
    this.writeTaskLocatorIndex(next);
  }
}
