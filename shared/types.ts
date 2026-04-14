export type AgentStatus = "idle" | "running" | "success" | "failed" | "needs_revision";

export type TaskStatus = "pending" | "running" | "waiting" | "success" | "failed" | "needs_revision";

export type PermissionMode = "allow" | "ask" | "deny";

export type AgentMode = "primary" | "subagent";

export type AgentRole =
  | "business_analyst"
  | "implementation"
  | "code_review"
  | "docs_review"
  | "unit_test"
  | "integration_test"
  | string;

export interface ToolPermission {
  name: string;
  mode: PermissionMode;
}

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export function getProjectNameFromPath(projectPath: string): string {
  const normalized = projectPath.trim().replace(/[\\/]+$/, "");
  if (!normalized) {
    return "";
  }
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

export interface TaskRecord {
  id: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  cwd: string;
  zellijSessionId: string | null;
  opencodeSessionId: string | null;
  agentCount: number;
  createdAt: string;
  completedAt: string | null;
  initializedAt: string | null;
}

export interface AgentFileRecord {
  id: string;
  projectId: string;
  name: string;
  relativePath: string;
  absolutePath: string;
  mode: AgentMode;
  role: AgentRole | null;
  tools: ToolPermission[];
  prompt: string;
  content: string;
}

export interface TopologyAgentSeed {
  name: string;
  relativePath: string;
  mode: AgentMode;
  role: AgentRole | null;
  tools: ToolPermission[];
}

export interface TaskAgentRecord {
  id: string;
  taskId: string;
  projectId: string;
  name: string;
  opencodeSessionId: string | null;
  status: AgentStatus;
  runCount: number;
}

export interface TaskPanelRecord {
  id: string;
  taskId: string;
  projectId: string;
  sessionName: string;
  paneId: string;
  agentName: string;
  cwd: string;
  order: number;
}

export interface TopologyNode {
  id: string;
  label: string;
  kind: "agent" | "checkpoint";
}

export interface TopologyEdge {
  id: string;
  source: string;
  target: string;
  triggerOn: "success";
}

export interface TopologyRecord {
  projectId: string;
  startAgentId: string | null;
  agentOrderIds: string[];
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}

export interface MessageRecord {
  id: string;
  projectId: string;
  taskId: string | null;
  content: string;
  sender: string;
  timestamp: string;
  meta?: Record<string, string>;
}

export interface AgentRuntimeActivity {
  id: string;
  kind: "tool" | "message" | "thinking" | "step";
  label: string;
  detail: string;
  timestamp: string;
}

export interface AgentRuntimeSnapshot {
  projectId: string;
  taskId: string;
  agentId: string;
  sessionId: string | null;
  status: AgentStatus;
  messageCount: number;
  updatedAt: string | null;
  headline: string | null;
  activeToolNames: string[];
  activities: AgentRuntimeActivity[];
}

export interface TaskSnapshot {
  task: TaskRecord;
  agents: TaskAgentRecord[];
  panels: TaskPanelRecord[];
  messages: MessageRecord[];
  topology: TopologyRecord;
}

export interface ProjectSnapshot {
  project: ProjectRecord;
  agentFiles: AgentFileRecord[];
  topology: TopologyRecord;
  messages: MessageRecord[];
  tasks: TaskSnapshot[];
}

export interface SubmitTaskPayload {
  projectId: string;
  taskId?: string | null;
  content: string;
  mentionAgent?: string;
}

export interface InitializeTaskPayload {
  projectId: string;
  title?: string;
}

export interface CreateProjectPayload {
  path: string;
}

export interface ReadAgentFilePayload {
  projectId: string;
  relativePath: string;
}

export interface UpdateTopologyPayload {
  projectId: string;
  topology: TopologyRecord;
}

export interface GetTaskRuntimePayload {
  projectId: string;
  taskId: string;
}

export interface OpenTaskSessionPayload {
  projectId: string;
  taskId: string;
}

export interface OpenAgentPanePayload {
  projectId: string;
  taskId: string;
  agentName: string;
}

export interface DeleteTaskPayload {
  projectId: string;
  taskId: string;
}

export interface AgentFlowEvent {
  type:
    | "project-created"
    | "project-updated"
    | "task-created"
    | "task-updated"
    | "message-created"
    | "agent-status-changed";
  projectId: string;
  payload: unknown;
}

export const DEFAULT_TOOL_PERMISSIONS: ToolPermission[] = [
  { name: "read", mode: "allow" },
  { name: "write", mode: "ask" },
  { name: "edit", mode: "ask" },
  { name: "bash", mode: "ask" },
  { name: "grep", mode: "allow" },
  { name: "glob", mode: "allow" },
  { name: "list", mode: "allow" },
  { name: "patch", mode: "ask" },
  { name: "task", mode: "ask" },
  { name: "lsp", mode: "allow" },
  { name: "todowrite", mode: "allow" },
  { name: "webfetch", mode: "allow" },
  { name: "skill", mode: "allow" },
];

export const BUILD_AGENT_NAME = "Build";

function createNode(name: string): TopologyNode {
  return {
    id: name,
    label: name,
    kind: "agent",
  };
}

export function isBuiltinAgentPath(relativePath: string): boolean {
  return relativePath.startsWith("builtin://");
}

export function isBuildAgentName(agentName: string): boolean {
  return agentName === BUILD_AGENT_NAME;
}

export function isReviewAgentName(agentName: string): boolean {
  return !isBuildAgentName(agentName);
}

function findAgentByRole(agents: TopologyAgentSeed[], role: AgentRole): TopologyAgentSeed | null {
  return agents.find((agent) => agent.role === role) ?? null;
}

export function resolveTopologyStartAgent(
  agents: Array<Pick<TopologyAgentSeed, "name" | "mode" | "role" | "relativePath">>,
  preferredStartAgentId?: string | null,
): string | null {
  if (preferredStartAgentId && agents.some((agent) => agent.name === preferredStartAgentId)) {
    return preferredStartAgentId;
  }

  const primaryAgents = agents.filter((agent) => agent.mode === "primary");
  const builtinPrimaryAgents = primaryAgents.filter((agent) => isBuiltinAgentPath(agent.relativePath));
  const localPrimaryAgents = primaryAgents.filter((agent) => !isBuiltinAgentPath(agent.relativePath));

  return (
    findAgentByRole(agents as TopologyAgentSeed[], "business_analyst")?.name ??
    localPrimaryAgents[0]?.name ??
    primaryAgents[0]?.name ??
    builtinPrimaryAgents[0]?.name ??
    agents[0]?.name ??
    null
  );
}

export function resolveTopologyAgentOrder(
  agents: Array<Pick<TopologyAgentSeed, "name" | "mode" | "role" | "relativePath">>,
  preferredOrderIds?: string[] | null,
): string[] {
  const availableAgentNames = agents.map((agent) => agent.name);
  const availableAgentSet = new Set(availableAgentNames);
  const order: string[] = [];
  const push = (name: string | null | undefined) => {
    if (!name || !availableAgentSet.has(name) || order.includes(name)) {
      return;
    }
    order.push(name);
  };

  for (const name of preferredOrderIds ?? []) {
    push(name);
  }

  if (order.length === availableAgentNames.length) {
    return order;
  }

  const startAgentName = resolveTopologyStartAgent(agents);
  const primaryAgents = agents.filter((agent) => agent.mode === "primary");
  const builtinPrimaryAgents = primaryAgents.filter((agent) => isBuiltinAgentPath(agent.relativePath));
  const implementationAgent =
    findAgentByRole(agents as TopologyAgentSeed[], "implementation") ??
    builtinPrimaryAgents[0] ??
    primaryAgents.find((agent) => agent.name !== startAgentName) ??
    null;

  push(startAgentName);
  push(implementationAgent?.name);
  push(findAgentByRole(agents as TopologyAgentSeed[], "docs_review")?.name);
  push(findAgentByRole(agents as TopologyAgentSeed[], "unit_test")?.name);
  push(findAgentByRole(agents as TopologyAgentSeed[], "integration_test")?.name);
  push(findAgentByRole(agents as TopologyAgentSeed[], "code_review")?.name);

  for (const agent of primaryAgents) {
    push(agent.name);
  }
  for (const agentName of availableAgentNames) {
    push(agentName);
  }

  return order;
}

export function createDefaultTopology(projectId: string, agents: TopologyAgentSeed[]): TopologyRecord {
  const agentOrderIds = resolveTopologyAgentOrder(agents);
  const names = new Set(agentOrderIds);
  const nodes = agentOrderIds.map(createNode);
  const edges: TopologyEdge[] = [];

  const startAgentName = resolveTopologyStartAgent(agents);
  const startAgent = agents.find((agent) => agent.name === startAgentName) ?? null;
  const primaryAgents = agents.filter((agent) => agent.mode === "primary");
  const builtinPrimaryAgents = primaryAgents.filter((agent) => isBuiltinAgentPath(agent.relativePath));
  const implementationAgent =
    findAgentByRole(agents, "implementation") ??
    builtinPrimaryAgents[0] ??
    primaryAgents.find((agent) => agent.name !== startAgent?.name) ??
    null;
  const docsReviewAgent = findAgentByRole(agents, "docs_review");
  const unitTestAgent = findAgentByRole(agents, "unit_test");
  const integrationTestAgent = findAgentByRole(agents, "integration_test");

  const push = (source: string | null | undefined, target: string | null | undefined, triggerOn: TopologyEdge["triggerOn"]) => {
    if (!source || !target) {
      return;
    }
    if (!names.has(source) || !names.has(target)) {
      return;
    }
    edges.push({ id: `${source}__${target}__${triggerOn}`, source, target, triggerOn });
  };

  if (startAgent && implementationAgent && startAgent.name !== implementationAgent.name) {
    push(startAgent.name, implementationAgent.name, "success");
  }
  push(implementationAgent?.name, docsReviewAgent?.name, "success");
  push(implementationAgent?.name, unitTestAgent?.name, "success");
  push(implementationAgent?.name, integrationTestAgent?.name, "success");
  push(integrationTestAgent?.name, startAgent?.name, "success");

  return {
    projectId,
    startAgentId: startAgent?.name ?? null,
    agentOrderIds,
    nodes,
    edges,
  };
}
