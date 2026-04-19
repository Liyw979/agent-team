import fs from "node:fs";
import path from "node:path";
import {
  getProjectNameFromPath,
  normalizeNeedsRevisionMaxRounds,
} from "@shared/types";
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

function createDefaultProjectState(projectId: string): ProjectStateFile {
  return {
    version: 1,
    topology: {
      projectId,
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
  private readonly registryPath: string;

  constructor(userDataPath: string) {
    fs.mkdirSync(userDataPath, { recursive: true });
    this.registryPath = path.join(userDataPath, REGISTRY_FILE_NAME);
    this.ensureRegistry();
  }

  listProjects(): ProjectRecord[] {
    return sortByCreatedAtDesc(this.readRegistry().projects).map((entry) => this.hydrateProjectRecord(entry));
  }

  reconcileLegacyProjectRegistry(projectPath: string): ProjectRecord | null {
    const normalizedPath = path.resolve(projectPath);
    const globalRegistry = this.readRegistry();
    const globalEntry =
      globalRegistry.projects.find((entry) => path.resolve(entry.path) === normalizedPath) ?? null;
    const legacyRegistryPath = this.getLegacyProjectRegistryPath(normalizedPath);
    if (!fs.existsSync(legacyRegistryPath) || path.resolve(legacyRegistryPath) === path.resolve(this.registryPath)) {
      if (globalEntry) {
        this.normalizeProjectState(normalizedPath, globalEntry.id);
      }
      return globalEntry ? this.hydrateProjectRecord(globalEntry) : null;
    }

    const legacyRegistry = this.readRegistryFile(legacyRegistryPath);
    const legacyEntry =
      legacyRegistry.projects.find((entry) => path.resolve(entry.path) === normalizedPath) ?? null;

    if (!legacyEntry) {
      this.archiveLegacyProjectRegistry(legacyRegistryPath, "empty");
      if (globalEntry) {
        this.normalizeProjectState(normalizedPath, globalEntry.id);
      }
      return globalEntry ? this.hydrateProjectRecord(globalEntry) : null;
    }

    if (!globalEntry) {
      this.writeRegistry({
        ...globalRegistry,
        projects: sortByCreatedAtDesc(
          globalRegistry.projects
            .filter((entry) => path.resolve(entry.path) !== normalizedPath)
            .concat(legacyEntry),
        ),
      });
      this.archiveLegacyProjectRegistry(legacyRegistryPath, "migrated");
      this.normalizeProjectState(normalizedPath, legacyEntry.id);
      return this.hydrateProjectRecord(legacyEntry);
    }

    this.archiveLegacyProjectRegistry(
      legacyRegistryPath,
      legacyEntry.id === globalEntry.id ? "deduplicated" : "conflict",
    );
    this.normalizeProjectState(normalizedPath, globalEntry.id);
    return this.hydrateProjectRecord(globalEntry);
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

  deleteProject(projectId: string) {
    const project = this.getProject(projectId);
    const registry = this.readRegistry();
    this.writeRegistry({
      ...registry,
      projects: registry.projects.filter((entry) => entry.id !== projectId),
    });

    const projectDataDir = path.join(project.path, PROJECT_DATA_DIR_NAME);
    if (fs.existsSync(projectDataDir)) {
      fs.rmSync(projectDataDir, { recursive: true, force: true });
    }
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

  insertTask(record: TaskRecord) {
    this.updateProjectState(record.projectId, (state) => ({
      ...state,
      tasks: uniqueById([...state.tasks, record]),
    }));
  }

  deleteTask(taskId: string) {
    const { project } = this.findTaskProject(taskId);
    this.updateProjectState(project.id, (state) => {
      return {
        ...state,
        tasks: state.tasks.filter((task) => task.id !== taskId),
        taskAgents: state.taskAgents.filter((agent) => agent.taskId !== taskId),
        taskPanels: state.taskPanels.filter((panel) => panel.taskId !== taskId),
        messages: state.messages.filter((message) => message.taskId !== taskId),
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
      .sort((left, right) => left.order - right.order || left.agentName.localeCompare(right.agentName));
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
    return this.readRegistryFile(this.registryPath);
  }

  private readRegistryFile(registryPath: string): ProjectRegistryFile {
    if (!fs.existsSync(registryPath)) {
      return {
        version: 1,
        projects: [],
      };
    }

    const raw = fs.readFileSync(registryPath, "utf8").trim();
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

  private getLegacyProjectRegistryPath(projectPath: string) {
    return path.join(projectPath, PROJECT_DATA_DIR_NAME, REGISTRY_FILE_NAME);
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
    const tasks: TaskRecord[] = Array.isArray(parsed.tasks)
      ? parsed.tasks
          .filter((task): task is Partial<TaskRecord> => Boolean(task) && typeof task === "object")
          .map((task) => ({
            id: typeof task.id === "string" ? task.id : "",
            projectId,
            title: typeof task.title === "string" ? task.title : "未命名任务",
            status:
              task.status === "running" ||
              task.status === "waiting" ||
              task.status === "finished" ||
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
              agent.status === "running" ||
              agent.status === "completed" ||
              agent.status === "failed" ||
              agent.status === "needs_revision"
                ? agent.status
                : "idle";

            return {
              id: typeof agent.id === "string" ? agent.id : "",
              taskId,
              projectId,
              name: typeof agent.name === "string" ? agent.name : "",
              opencodeSessionId: typeof agent.opencodeSessionId === "string" ? agent.opencodeSessionId : null,
              status: finishedTaskIds.has(taskId) ? "completed" : normalizedStatus,
              runCount: typeof agent.runCount === "number" && Number.isFinite(agent.runCount) ? agent.runCount : 0,
            };
          })
          .filter((agent) => agent.id && agent.taskId && agent.name)
      : [];
    const state: ProjectStateFile = {
      version: 1,
      topology:
        parsed.topology && typeof parsed.topology === "object"
          ? {
              projectId,
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
                      (edge): edge is ProjectStateFile["topology"]["edges"][number] =>
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
                    }))
                    .filter((node) => node.id && node.templateName)
                : undefined,
              spawnRules: Array.isArray(parsed.topology.spawnRules)
                ? parsed.topology.spawnRules
                    .filter((rule): rule is Record<string, unknown> => Boolean(rule) && typeof rule === "object")
                    .map((rule) => ({
                      id: typeof rule.id === "string" ? rule.id : "",
                      name: typeof rule.name === "string" ? rule.name : "",
                      sourceTemplateName:
                        typeof rule.sourceTemplateName === "string" ? rule.sourceTemplateName : "",
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
                      reportToTemplateName:
                        typeof rule.reportToTemplateName === "string" ? rule.reportToTemplateName : "",
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
          : createDefaultProjectState(projectId).topology,
      tasks,
      taskAgents,
      taskPanels: Array.isArray(parsed.taskPanels)
        ? parsed.taskPanels
            .filter((panel): panel is Partial<TaskPanelRecord> => Boolean(panel) && typeof panel === "object")
            .map((panel, index) => ({
              id: typeof panel.id === "string" ? panel.id : "",
              taskId: typeof panel.taskId === "string" ? panel.taskId : "",
              projectId,
              sessionName: typeof panel.sessionName === "string" ? panel.sessionName : "",
              paneId: typeof panel.paneId === "string" ? panel.paneId : "",
              agentName: typeof panel.agentName === "string" ? panel.agentName : "",
              cwd: typeof panel.cwd === "string" ? panel.cwd : projectPath,
              order: typeof panel.order === "number" && Number.isFinite(panel.order) ? panel.order : index,
            }))
            .filter((panel) => panel.id && panel.taskId && panel.agentName)
        : [],
      messages: Array.isArray(parsed.messages)
        ? parsed.messages
            .filter((message): message is Partial<MessageRecord> => Boolean(message) && typeof message === "object")
            .map((message) => {
              const meta = normalizeMessageMeta(message.meta);
              const content =
                typeof message.content === "string" ? normalizeMessageContent(message.content, meta) : "";
              return {
                id: typeof message.id === "string" ? message.id : "",
                projectId,
                taskId: typeof message.taskId === "string" ? message.taskId : null,
                content,
                sender: typeof message.sender === "string" ? message.sender : "system",
                timestamp:
                  typeof message.timestamp === "string" ? message.timestamp : new Date(0).toISOString(),
                meta,
              } satisfies MessageRecord;
            })
            .filter((message) => message.id)
        : [],
    };

    return state;
  }

  private writeProjectState(projectPath: string, state: ProjectStateFile) {
    const statePath = this.getProjectStatePath(projectPath);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private normalizeProjectState(projectPath: string, projectId: string) {
    const state = this.readProjectState(projectPath, projectId);
    this.writeProjectState(projectPath, state);
  }

  private archiveLegacyProjectRegistry(legacyRegistryPath: string, reason: string) {
    if (!fs.existsSync(legacyRegistryPath)) {
      return;
    }

    const parsed = path.parse(legacyRegistryPath);
    const archivedPath = path.join(
      parsed.dir,
      `${parsed.name}.legacy-${reason}-${Date.now()}${parsed.ext}`,
    );
    fs.renameSync(legacyRegistryPath, archivedPath);
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
