import fs from "node:fs";
import path from "node:path";
import { getProjectNameFromPath } from "@shared/types";
import type {
  MessageRecord,
  ProjectRecord,
  TaskAgentRecord,
  TaskPanelRecord,
  TaskRecord,
  TopologyRecord,
} from "@shared/types";

interface ProjectRegistryEntry {
  id: string;
  path: string;
  createdAt: string;
}

interface ProjectRegistryFile {
  version: number;
  projects: ProjectRegistryEntry[];
}

interface ProjectStateFile {
  version: number;
  topology: TopologyRecord;
  tasks: TaskRecord[];
  taskAgents: TaskAgentRecord[];
  taskPanels: TaskPanelRecord[];
  messages: MessageRecord[];
  taskTopologySnapshots: Record<string, TopologyRecord>;
}

interface TaskProjectLocation {
  project: ProjectRecord;
  state: ProjectStateFile;
}

const REGISTRY_FILE_NAME = "projects.json";
const PROJECT_DATA_DIR_NAME = ".agentflow";
const PROJECT_STATE_FILE_NAME = "state.json";

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

function createDefaultProjectState(projectId: string): ProjectStateFile {
  return {
    version: 1,
    topology: {
      projectId,
      rootAgentId: null,
      agentOrderIds: [],
      nodes: [],
      edges: [],
    },
    tasks: [],
    taskAgents: [],
    taskPanels: [],
    messages: [],
    taskTopologySnapshots: {},
  };
}

export class StoreService {
  private readonly registryPath: string;

  constructor(userDataPath: string) {
    fs.mkdirSync(userDataPath, { recursive: true });
    this.registryPath = path.join(userDataPath, REGISTRY_FILE_NAME);
    this.ensureRegistry();
  }

  listProjects(): ProjectRecord[] {
    return sortByCreatedAtDesc(this.readRegistry().projects).map((entry) => this.hydrateProjectRecord(entry));
  }

  getProject(projectId: string): ProjectRecord {
    const entry = this.readRegistry().projects.find((item) => item.id === projectId);
    if (!entry) {
      throw new Error(`Project ${projectId} not found`);
    }
    return this.hydrateProjectRecord(entry);
  }

  insertProject(record: ProjectRecord) {
    const registry = this.readRegistry();
    const normalizedPath = path.resolve(record.path);
    const retained = registry.projects.filter(
      (entry) => entry.id !== record.id && path.resolve(entry.path) !== normalizedPath,
    );
    retained.push({
      id: record.id,
      path: normalizedPath,
      createdAt: record.createdAt,
    });
    this.writeRegistry({
      ...registry,
      projects: sortByCreatedAtDesc(retained),
    });
    this.ensureProjectState(record);
  }

  listTasks(projectId: string): TaskRecord[] {
    const state = this.readProjectStateById(projectId);
    return sortByCreatedAtDesc(state.tasks);
  }

  getTask(taskId: string): TaskRecord {
    const { state } = this.findTaskProject(taskId);
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    return task;
  }

  insertTask(record: TaskRecord, topologySnapshot: TopologyRecord) {
    this.updateProjectState(record.projectId, (state) => ({
      ...state,
      tasks: uniqueById([...state.tasks, record]),
      taskTopologySnapshots: {
        ...state.taskTopologySnapshots,
        [record.id]: topologySnapshot,
      },
    }));
  }

  deleteTask(taskId: string) {
    const { project } = this.findTaskProject(taskId);
    this.updateProjectState(project.id, (state) => {
      const nextTaskTopologySnapshots = { ...state.taskTopologySnapshots };
      delete nextTaskTopologySnapshots[taskId];

      return {
        ...state,
        tasks: state.tasks.filter((task) => task.id !== taskId),
        taskAgents: state.taskAgents.filter((agent) => agent.taskId !== taskId),
        taskPanels: state.taskPanels.filter((panel) => panel.taskId !== taskId),
        messages: state.messages.filter((message) => message.taskId !== taskId),
        taskTopologySnapshots: nextTaskTopologySnapshots,
      };
    });
  }

  updateTaskStatus(taskId: string, status: TaskRecord["status"], completedAt: string | null = null) {
    this.updateTaskState(taskId, (state) => ({
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
    this.updateTaskState(taskId, (state) => ({
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
    this.updateTaskState(taskId, (state) => ({
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

  getTaskTopology(taskId: string): TopologyRecord {
    const { state } = this.findTaskProject(taskId);
    return state.taskTopologySnapshots[taskId] ?? state.topology;
  }

  listTaskAgents(taskId: string): TaskAgentRecord[] {
    const { state } = this.findTaskProject(taskId);
    return [...state.taskAgents]
      .filter((agent) => agent.taskId === taskId)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  insertTaskAgent(record: TaskAgentRecord) {
    this.updateProjectState(record.projectId, (state) => ({
      ...state,
      taskAgents: uniqueById([...state.taskAgents, record]),
    }));
  }

  listTaskPanels(taskId: string): TaskPanelRecord[] {
    const { state } = this.findTaskProject(taskId);
    return [...state.taskPanels]
      .filter((panel) => panel.taskId === taskId)
      .sort((left, right) => left.agentName.localeCompare(right.agentName));
  }

  insertTaskPanel(record: TaskPanelRecord) {
    this.updateProjectState(record.projectId, (state) => ({
      ...state,
      taskPanels: uniqueById([...state.taskPanels, record]),
    }));
  }

  upsertTaskPanel(record: TaskPanelRecord) {
    this.updateProjectState(record.projectId, (state) => ({
      ...state,
      taskPanels: uniqueById(
        state.taskPanels.filter((panel) => panel.id !== record.id).concat(record),
      ),
    }));
  }

  updateTaskAgentRun(taskId: string, agentName: string, status: TaskAgentRecord["status"]) {
    this.updateTaskState(taskId, (state) => ({
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

  updateTaskAgentStatus(taskId: string, agentName: string, status: TaskAgentRecord["status"]) {
    this.updateTaskState(taskId, (state) => ({
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

  updateTaskAgentSessionId(taskId: string, agentName: string, sessionId: string) {
    this.updateTaskState(taskId, (state) => ({
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

  getTopology(projectId: string): TopologyRecord {
    return this.readProjectStateById(projectId).topology;
  }

  upsertTopology(topology: TopologyRecord) {
    this.updateProjectState(topology.projectId, (state) => ({
      ...state,
      topology,
    }));
  }

  listMessages(projectId: string, taskId?: string | null): MessageRecord[] {
    const state = this.readProjectStateById(projectId);
    const scoped =
      typeof taskId === "string"
        ? state.messages.filter((message) => message.taskId === taskId)
        : state.messages;
    return sortMessages(scoped);
  }

  insertMessage(record: MessageRecord) {
    this.updateProjectState(record.projectId, (state) => ({
      ...state,
      messages: sortMessages(uniqueById([...state.messages, record])),
    }));
  }

  private ensureRegistry() {
    if (fs.existsSync(this.registryPath)) {
      return;
    }
    this.writeRegistry({
      version: 1,
      projects: [],
    });
  }

  private hydrateProjectRecord(entry: ProjectRegistryEntry): ProjectRecord {
    return {
      id: entry.id,
      name: getProjectNameFromPath(entry.path),
      path: entry.path,
      createdAt: entry.createdAt,
    };
  }

  private readRegistry(): ProjectRegistryFile {
    if (!fs.existsSync(this.registryPath)) {
      return {
        version: 1,
        projects: [],
      };
    }

    const raw = fs.readFileSync(this.registryPath, "utf8").trim();
    if (!raw) {
      return {
        version: 1,
        projects: [],
      };
    }

    const parsed = JSON.parse(raw) as Partial<ProjectRegistryFile>;
    return {
      version: 1,
      projects: Array.isArray(parsed.projects)
        ? parsed.projects
            .map((entry) => ({
              id: typeof entry?.id === "string" ? entry.id : "",
              path: typeof entry?.path === "string" ? path.resolve(entry.path) : "",
              createdAt: typeof entry?.createdAt === "string" ? entry.createdAt : new Date(0).toISOString(),
            }))
            .filter((entry) => entry.id && entry.path)
        : [],
    };
  }

  private writeRegistry(registry: ProjectRegistryFile) {
    fs.writeFileSync(this.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  }

  private ensureProjectState(project: ProjectRecord) {
    const statePath = this.getProjectStatePath(project.path);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    if (!fs.existsSync(statePath)) {
      this.writeProjectState(project.path, createDefaultProjectState(project.id));
      return;
    }

    const state = this.readProjectState(project.path, project.id);
    this.writeProjectState(project.path, state);
  }

  private getProjectStatePath(projectPath: string) {
    return path.join(projectPath, PROJECT_DATA_DIR_NAME, PROJECT_STATE_FILE_NAME);
  }

  private readProjectStateById(projectId: string): ProjectStateFile {
    const project = this.getProject(projectId);
    return this.readProjectState(project.path, project.id);
  }

  private readProjectState(projectPath: string, projectId: string): ProjectStateFile {
    const statePath = this.getProjectStatePath(projectPath);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    if (!fs.existsSync(statePath)) {
      const initialState = createDefaultProjectState(projectId);
      this.writeProjectState(projectPath, initialState);
      return initialState;
    }

    const raw = fs.readFileSync(statePath, "utf8").trim();
    if (!raw) {
      const initialState = createDefaultProjectState(projectId);
      this.writeProjectState(projectPath, initialState);
      return initialState;
    }

    const parsed = JSON.parse(raw) as Partial<ProjectStateFile>;
    const state: ProjectStateFile = {
      version: 1,
      topology:
        parsed.topology && typeof parsed.topology === "object"
          ? {
              projectId,
              rootAgentId:
                typeof parsed.topology.rootAgentId === "string" ? parsed.topology.rootAgentId : null,
              agentOrderIds: Array.isArray(parsed.topology.agentOrderIds)
                ? parsed.topology.agentOrderIds.filter((item): item is string => typeof item === "string")
                : [],
              nodes: Array.isArray(parsed.topology.nodes) ? parsed.topology.nodes : [],
              edges: Array.isArray(parsed.topology.edges) ? parsed.topology.edges : [],
            }
          : createDefaultProjectState(projectId).topology,
      tasks: Array.isArray(parsed.tasks)
        ? parsed.tasks
            .filter((task): task is Partial<TaskRecord> => Boolean(task) && typeof task === "object")
            .map((task) => ({
              id: typeof task.id === "string" ? task.id : "",
              projectId,
              title: typeof task.title === "string" ? task.title : "未命名任务",
              entryAgentId: typeof task.entryAgentId === "string" ? task.entryAgentId : "",
              status:
                task.status === "running" ||
                task.status === "success" ||
                task.status === "failed" ||
                task.status === "needs_revision"
                  ? task.status
                  : "pending",
              cwd: typeof task.cwd === "string" ? task.cwd : projectPath,
              zellijSessionId: typeof task.zellijSessionId === "string" ? task.zellijSessionId : null,
              opencodeSessionId: typeof task.opencodeSessionId === "string" ? task.opencodeSessionId : null,
              agentCount: typeof task.agentCount === "number" ? task.agentCount : 0,
              createdAt:
                typeof task.createdAt === "string" ? task.createdAt : new Date(0).toISOString(),
              completedAt: typeof task.completedAt === "string" ? task.completedAt : null,
              initializedAt: typeof task.initializedAt === "string" ? task.initializedAt : null,
            }))
            .filter((task) => task.id)
        : [],
      taskAgents: Array.isArray(parsed.taskAgents) ? parsed.taskAgents.filter(Boolean) : [],
      taskPanels: Array.isArray(parsed.taskPanels) ? parsed.taskPanels.filter(Boolean) : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages.filter(Boolean) : [],
      taskTopologySnapshots:
        parsed.taskTopologySnapshots && typeof parsed.taskTopologySnapshots === "object"
          ? Object.fromEntries(
              Object.entries(parsed.taskTopologySnapshots).map(([taskId, topology]) => [
                taskId,
                {
                  projectId,
                  rootAgentId:
                    topology &&
                    typeof topology === "object" &&
                    typeof (topology as TopologyRecord).rootAgentId === "string"
                      ? (topology as TopologyRecord).rootAgentId
                      : null,
                  agentOrderIds:
                    topology &&
                    typeof topology === "object" &&
                    Array.isArray((topology as TopologyRecord).agentOrderIds)
                      ? (topology as TopologyRecord).agentOrderIds.filter(
                          (item): item is string => typeof item === "string",
                        )
                      : [],
                  nodes:
                    topology && typeof topology === "object" && Array.isArray((topology as TopologyRecord).nodes)
                      ? (topology as TopologyRecord).nodes
                      : [],
                  edges:
                    topology && typeof topology === "object" && Array.isArray((topology as TopologyRecord).edges)
                      ? (topology as TopologyRecord).edges
                      : [],
                },
              ]),
            )
          : {},
    };

    return state;
  }

  private writeProjectState(projectPath: string, state: ProjectStateFile) {
    const statePath = this.getProjectStatePath(projectPath);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private updateProjectState(projectId: string, updater: (state: ProjectStateFile) => ProjectStateFile) {
    const project = this.getProject(projectId);
    const current = this.readProjectState(project.path, project.id);
    const next = updater(current);
    this.writeProjectState(project.path, next);
  }

  private updateTaskState(taskId: string, updater: (state: ProjectStateFile) => ProjectStateFile) {
    const { project, state } = this.findTaskProject(taskId);
    const next = updater(state);
    this.writeProjectState(project.path, next);
  }

  private findTaskProject(taskId: string): TaskProjectLocation {
    for (const project of this.listProjects()) {
      const state = this.readProjectState(project.path, project.id);
      if (state.tasks.some((task) => task.id === taskId)) {
        return {
          project,
          state,
        };
      }
    }
    throw new Error(`Task ${taskId} not found`);
  }
}
