import path from "node:path";
import { createTopologyLangGraphRecord } from "@shared/types";
import type {
  MessageRecord,
  TaskAgentRecord,
  TaskRecord,
  TopologyRecord,
} from "@shared/types";

interface WorkspaceStateFile {
  version: number;
  topology: TopologyRecord;
  tasks: TaskRecord[];
  taskAgents: TaskAgentRecord[];
  messages: MessageRecord[];
}

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

export class StoreService {
  private readonly workspaceStates = new Map<string, WorkspaceStateFile>();

  private readonly taskLocatorById = new Map<string, string>();

  constructor(_userDataPath: string) {}

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
    this.taskLocatorById.set(record.id, path.resolve(record.cwd));
  }

  deleteTask(cwd: string, taskId: string) {
    this.updateWorkspaceState(cwd, (state) => ({
      ...state,
      tasks: state.tasks.filter((task) => task.id !== taskId),
      taskAgents: state.taskAgents.filter((agent) => agent.taskId !== taskId),
      messages: state.messages.filter((message) => message.taskId !== taskId),
    }));
    this.taskLocatorById.delete(taskId);
  }

  getTaskLocatorCwd(taskId: string): string | null {
    return this.taskLocatorById.get(taskId) ?? null;
  }

  removeTaskLocator(taskId: string) {
    this.taskLocatorById.delete(taskId);
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
    return this.workspaceStates.has(path.resolve(cwd));
  }

  private readWorkspaceState(cwd: string): WorkspaceStateFile {
    const normalizedCwd = path.resolve(cwd);
    return this.workspaceStates.get(normalizedCwd) ?? createDefaultWorkspaceState();
  }

  private updateWorkspaceState(cwd: string, updater: (state: WorkspaceStateFile) => WorkspaceStateFile) {
    const normalizedCwd = path.resolve(cwd);
    const current = this.readWorkspaceState(normalizedCwd);
    const next = updater(current);
    this.workspaceStates.set(normalizedCwd, next);
  }
}
