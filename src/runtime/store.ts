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
  taskSlot: TaskSlot;
  taskAgents: TaskAgentRecord[];
  messages: MessageRecord[];
}

type TaskSlot =
  | {
      kind: "present";
      task: TaskRecord;
    }
  | {
      kind: "empty";
    };

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
    taskSlot: { kind: "empty" },
    taskAgents: [],
    messages: [],
  };
}

export class StoreService {
  private state: WorkspaceStateFile;

  constructor() {
    this.state = createDefaultWorkspaceState();
  }

  getTask(): TaskRecord {
    if (this.state.taskSlot.kind === "empty") {
      throw new Error("当前没有 Task");
    }
    return this.state.taskSlot.task;
  }

  insertTask(record: TaskRecord) {
    this.updateWorkspaceState((state) => ({
      ...state,
      taskSlot: {
        kind: "present",
        task: record,
      },
    }));
  }

  updateTaskStatus(status: TaskRecord["status"], completedAt = "") {
    this.updateWorkspaceState((state) => ({
      ...state,
      taskSlot: state.taskSlot.kind === "present"
        ? {
            kind: "present",
            task: {
              ...state.taskSlot.task,
              status,
              completedAt,
            },
          }
        : state.taskSlot,
    }));
  }

  updateTaskAgentCount(agentCount: number) {
    this.updateWorkspaceState((state) => ({
      ...state,
      taskSlot: state.taskSlot.kind === "present"
        ? {
            kind: "present",
            task: {
              ...state.taskSlot.task,
              agentCount,
            },
          }
        : state.taskSlot,
    }));
  }

  updateTaskInitialized(initializedAt: string) {
    this.updateWorkspaceState((state) => ({
      ...state,
      taskSlot: state.taskSlot.kind === "present"
        ? {
            kind: "present",
            task: {
              ...state.taskSlot.task,
              initializedAt,
            },
          }
        : state.taskSlot,
    }));
  }

  listTaskAgents(): TaskAgentRecord[] {
    return [...this.state.taskAgents]
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  insertTaskAgent(record: TaskAgentRecord) {
    this.updateWorkspaceState((state) => ({
      ...state,
      taskAgents: uniqueById([...state.taskAgents, record]),
    }));
  }

  updateTaskAgentRun(agentId: string, status: TaskAgentRecord["status"]) {
    this.updateWorkspaceState((state) => ({
      ...state,
      taskAgents: state.taskAgents.map((agent) =>
        agent.id === agentId
          ? {
              ...agent,
              status,
              runCount: agent.runCount + 1,
            }
          : agent,
      ),
    }));
  }

  updateTaskAgentStatus(agentId: string, status: TaskAgentRecord["status"]) {
    this.updateWorkspaceState((state) => ({
      ...state,
      taskAgents: state.taskAgents.map((agent) =>
        agent.id === agentId
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

  listMessages(): MessageRecord[] {
    return sortMessages(this.state.messages);
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
