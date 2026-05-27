import {
  buildTopologyNodeRecords,
  createTopologyFlowRecord,
} from "@shared/types";
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

function getMessageKindSortRank(message: MessageRecord): number {
  switch (message.kind) {
    case "task-created":
      return 10;
    case "user":
      return 20;
    case "system-message":
      return 30;
    case "agent-progress":
      return 40;
    case "agent-final":
      return 50;
    case "agent-dispatch":
      return 60;
    case "task-round-finished":
      return 70;
    case "task-completed":
      return 80;
    default:
      return 999;
  }
}

function sortMessages(messages: MessageRecord[]): MessageRecord[] {
  return [...messages].sort((left, right) => {
    const timestampComparison = left.timestamp.localeCompare(right.timestamp);
    if (timestampComparison !== 0) {
      return timestampComparison;
    }

    const rankComparison = getMessageKindSortRank(left) - getMessageKindSortRank(right);
    if (rankComparison !== 0) {
      return rankComparison;
    }

    return left.id.localeCompare(right.id);
  });
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
      flow: createTopologyFlowRecord({
        nodes: [],
        edges: [],
      }),
      nodeRecords: buildTopologyNodeRecords({
        nodes: [],
        groupNodeIds: new Set(),
        templateNameByNodeId: new Map(),
        initialMessageRoutingByNodeId: new Map(),
        groupRuleIdByNodeId: new Map(),
        promptByNodeId: new Map(),
        writableNodeIds: new Set(),
      }),
    },
    tasks: [],
    taskAgents: [],
    messages: [],
  };
}

export class StoreService {
  private state: WorkspaceStateFile;

  constructor() {
    this.state = createDefaultWorkspaceState();
  }

  listTasks(): TaskRecord[] {
    return sortByCreatedAtDesc(this.state.tasks);
  }

  getTask(taskId: string): TaskRecord {
    const task = this.state.tasks.find((item) => item.id === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    return task;
  }

  insertTask(record: TaskRecord) {
    this.updateWorkspaceState((state) => ({
      ...state,
      tasks: uniqueById([...state.tasks, record]),
    }));
  }

  deleteTask(taskId: string) {
    this.updateWorkspaceState((state) => ({
      ...state,
      tasks: state.tasks.filter((task) => task.id !== taskId),
      taskAgents: state.taskAgents.filter((agent) => agent.taskId !== taskId),
      messages: state.messages.filter((message) => message.taskId !== taskId),
    }));
  }

  updateTaskStatus(taskId: string, status: TaskRecord["status"], completedAt = "") {
    this.updateWorkspaceState((state) => ({
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

  updateTaskAgentCount(taskId: string, agentCount: number) {
    this.updateWorkspaceState((state) => ({
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

  updateTaskInitialized(taskId: string, initializedAt: string) {
    this.updateWorkspaceState((state) => ({
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

  listTaskAgents(taskId: string): TaskAgentRecord[] {
    return [...this.state.taskAgents]
      .filter((agent) => agent.taskId === taskId)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  insertTaskAgent(record: TaskAgentRecord) {
    this.updateWorkspaceState((state) => ({
      ...state,
      taskAgents: uniqueById([...state.taskAgents, record]),
    }));
  }

  updateTaskAgentRun(taskId: string, agentId: string, status: TaskAgentRecord["status"]) {
    this.updateWorkspaceState((state) => ({
      ...state,
      taskAgents: state.taskAgents.map((agent) =>
        agent.taskId === taskId && agent.id === agentId
          ? {
              ...agent,
              status,
              runCount: agent.runCount + 1,
            }
          : agent,
      ),
    }));
  }

  updateTaskAgentStatus(taskId: string, agentId: string, status: TaskAgentRecord["status"]) {
    this.updateWorkspaceState((state) => ({
      ...state,
      taskAgents: state.taskAgents.map((agent) =>
        agent.taskId === taskId && agent.id === agentId
          ? {
              ...agent,
              status,
            }
          : agent,
      ),
    }));
  }

  getTopology(): TopologyRecord {
    return this.state.topology;
  }

  upsertTopology(topology: TopologyRecord) {
    this.updateWorkspaceState((state) => ({
      ...state,
      topology,
    }));
  }

  listMessages(taskId?: string | null): MessageRecord[] {
    const scoped =
      typeof taskId === "string"
        ? this.state.messages.filter((message) => message.taskId === taskId)
        : this.state.messages;
    return sortMessages(scoped);
  }

  insertMessage(record: MessageRecord) {
    this.updateWorkspaceState((state) => ({
      ...state,
      messages: sortMessages(uniqueById([...state.messages, record])),
    }));
  }

  getState(): WorkspaceStateFile {
    return this.state;
  }
  private updateWorkspaceState(updater: (state: WorkspaceStateFile) => WorkspaceStateFile) {
    this.state = updater(this.state);
  }
}
