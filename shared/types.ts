export type AgentStatus = "idle" | "running" | "completed" | "failed" | "needs_revision";

export type TaskStatus = "pending" | "running" | "waiting" | "finished" | "failed" | "needs_revision";

export type PermissionMode = "allow" | "ask" | "deny";

export const BUILD_AGENT_NAME = "Build";

export type AgentRole =
  | "business_analyst"
  | "implementation"
  | "task_review"
  | "code_review"
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
  name: string;
  prompt: string;
}

export interface TopologyAgentSeed {
  name: string;
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

export type TopologyEdgeTrigger = "association" | "review_pass" | "review_fail";

export interface TopologyEdge {
  id: string;
  source: string;
  target: string;
  triggerOn: TopologyEdgeTrigger;
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
  agentName: string;
}

export interface SaveAgentPromptPayload {
  projectId: string;
  currentAgentName: string;
  nextAgentName: string;
  prompt: string;
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

export interface DeleteAgentPayload {
  projectId: string;
  agentName: string;
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

function createNode(name: string): TopologyNode {
  return {
    id: name,
    label: name,
    kind: "agent",
  };
}

export function isReviewAgentInTopology(
  topology: Pick<TopologyRecord, "edges">,
  agentName: string,
): boolean {
  return topology.edges.some(
    (edge) =>
      edge.source === agentName &&
      (edge.triggerOn === "review_pass" || edge.triggerOn === "review_fail"),
  );
}

export function resolveTopologyStartAgent(
  agents: Array<Pick<TopologyAgentSeed, "name">>,
  preferredStartAgentId?: string | null,
): string | null {
  if (preferredStartAgentId && agents.some((agent) => agent.name === preferredStartAgentId)) {
    return preferredStartAgentId;
  }

  return agents[0]?.name ?? null;
}

export function resolveTopologyAgentOrder(
  agents: Array<Pick<TopologyAgentSeed, "name">>,
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

  push(resolveTopologyStartAgent(agents));
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
  const nextAgent = agents.find((agent) => agent.name !== startAgent?.name) ?? null;

  const push = (
    source: string | null | undefined,
    target: string | null | undefined,
    triggerOn: TopologyEdge["triggerOn"],
  ) => {
    if (!source || !target) {
      return;
    }
    if (!names.has(source) || !names.has(target)) {
      return;
    }
    edges.push({ id: `${source}__${target}__${triggerOn}`, source, target, triggerOn });
  };

  push(startAgent?.name, nextAgent?.name, "association");

  return {
    projectId,
    startAgentId: startAgent?.name ?? null,
    agentOrderIds,
    nodes,
    edges,
  };
}
