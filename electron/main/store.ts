import fs from "node:fs";
import path from "node:path";
import { normalizeNeedsRevisionMaxRounds } from "@shared/types";
import type {
  MessageRecord,
  TaskAgentRecord,
  TaskPanelRecord,
  TaskRecord,
  TopologyRecord,
} from "@shared/types";

interface WorkspaceStateFile {
  version: number;
  topology: TopologyRecord;
  tasks: TaskRecord[];
  taskAgents: TaskAgentRecord[];
  taskPanels: TaskPanelRecord[];
  messages: MessageRecord[];
}

const WORKSPACE_DATA_DIR_NAME = ".agentflow";
const WORKSPACE_STATE_FILE_NAME = "state.json";

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
    },
    tasks: [],
    taskAgents: [],
    taskPanels: [],
    messages: [],
  };
}

export class StoreService {
  constructor(userDataPath: string) {
    fs.mkdirSync(userDataPath, { recursive: true });
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
  }

  deleteTask(cwd: string, taskId: string) {
    this.updateWorkspaceState(cwd, (state) => ({
      ...state,
      tasks: state.tasks.filter((task) => task.id !== taskId),
      taskAgents: state.taskAgents.filter((agent) => agent.taskId !== taskId),
      taskPanels: state.taskPanels.filter((panel) => panel.taskId !== taskId),
      messages: state.messages.filter((message) => message.taskId !== taskId),
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

  listTaskPanels(cwd: string, taskId: string): TaskPanelRecord[] {
    return [...this.readWorkspaceState(cwd).taskPanels]
      .filter((panel) => panel.taskId === taskId)
      .sort((left, right) => left.order - right.order || left.agentName.localeCompare(right.agentName));
  }

  insertTaskPanel(cwd: string, record: TaskPanelRecord) {
    this.updateWorkspaceState(cwd, (state) => ({
      ...state,
      taskPanels: uniqueById([...state.taskPanels, record]),
    }));
  }

  upsertTaskPanel(cwd: string, record: TaskPanelRecord) {
    this.updateWorkspaceState(cwd, (state) => ({
      ...state,
      taskPanels: uniqueById(
        state.taskPanels.filter((panel) => panel.id !== record.id).concat(record),
      ),
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

  updateTaskAgentSessionId(cwd: string, taskId: string, agentName: string, sessionId: string) {
    this.updateWorkspaceState(cwd, (state) => ({
      ...state,
      taskAgents: state.taskAgents.map((agent) =>
        agent.taskId === taskId && agent.name === agentName
          ? {
              ...agent,
              opencodeSessionId: sessionId,
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

  private getWorkspaceStatePath(cwd: string) {
    return path.join(path.resolve(cwd), WORKSPACE_DATA_DIR_NAME, WORKSPACE_STATE_FILE_NAME);
  }

  private readWorkspaceState(cwd: string): WorkspaceStateFile {
    const normalizedCwd = path.resolve(cwd);
    const statePath = this.getWorkspaceStatePath(normalizedCwd);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    if (!fs.existsSync(statePath)) {
      const initialState = createDefaultWorkspaceState();
      this.writeWorkspaceState(normalizedCwd, initialState);
      return initialState;
    }

    const raw = fs.readFileSync(statePath, "utf8").trim();
    if (!raw) {
      const initialState = createDefaultWorkspaceState();
      this.writeWorkspaceState(normalizedCwd, initialState);
      return initialState;
    }

    const parsed = JSON.parse(raw) as Partial<WorkspaceStateFile>;
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
            zellijSessionId: typeof task.zellijSessionId === "string" ? task.zellijSessionId : null,
            opencodeSessionId: typeof task.opencodeSessionId === "string" ? task.opencodeSessionId : null,
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
              opencodeSessionId: typeof agent.opencodeSessionId === "string" ? agent.opencodeSessionId : null,
              status: finishedTaskIds.has(taskId) ? "completed" : normalizedStatus,
              runCount: typeof agent.runCount === "number" && Number.isFinite(agent.runCount) ? agent.runCount : 0,
            };
          })
          .filter((agent) => agent.id && agent.taskId && agent.name)
      : [];

    const topology: TopologyRecord =
      parsed.topology && typeof parsed.topology === "object"
        ? {
            nodes: normalizeTopologyNodes(parsed.topology),
            edges: Array.isArray(parsed.topology.edges)
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
              : [],
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
          }
        : createDefaultWorkspaceState().topology;

    const taskPanels: TaskPanelRecord[] = Array.isArray(parsed.taskPanels)
      ? parsed.taskPanels
          .filter((panel): panel is Partial<TaskPanelRecord> => Boolean(panel) && typeof panel === "object")
          .map((panel, index) => ({
            id: typeof panel.id === "string" ? panel.id : "",
            taskId: typeof panel.taskId === "string" ? panel.taskId : "",
            sessionName: typeof panel.sessionName === "string" ? panel.sessionName : "",
            paneId: typeof panel.paneId === "string" ? panel.paneId : "",
            agentName: typeof panel.agentName === "string" ? panel.agentName : "",
            cwd: typeof panel.cwd === "string" ? panel.cwd : normalizedCwd,
            order: typeof panel.order === "number" && Number.isFinite(panel.order) ? panel.order : index,
          }))
          .filter((panel) => panel.id && panel.taskId && panel.agentName)
      : [];

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
      taskPanels,
      messages,
    };
  }

  private writeWorkspaceState(cwd: string, state: WorkspaceStateFile) {
    const statePath = this.getWorkspaceStatePath(cwd);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private updateWorkspaceState(cwd: string, updater: (state: WorkspaceStateFile) => WorkspaceStateFile) {
    const normalizedCwd = path.resolve(cwd);
    const current = this.readWorkspaceState(normalizedCwd);
    const next = updater(current);
    this.writeWorkspaceState(normalizedCwd, next);
  }
}
