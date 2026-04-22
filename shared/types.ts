export type AgentStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "needs_revision";

export type TaskStatus =
  | "pending"
  | "running"
  | "waiting"
  | "finished"
  | "failed"
  | "needs_revision";

export type PermissionMode = "allow" | "ask" | "deny";

export const BUILD_AGENT_NAME = "Build";
export const RESTRICTED_AGENT_PERMISSION_KEYS = [
  "write",
  "edit",
  "bash",
  "task",
  "patch",
] as const;

export type RestrictedAgentPermissionKey =
  (typeof RESTRICTED_AGENT_PERMISSION_KEYS)[number];

export function usesOpenCodeBuiltinPrompt(agentName: string): boolean {
  return agentName.trim().toLowerCase() === BUILD_AGENT_NAME.toLowerCase();
}

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

export function getWorkspaceNameFromPath(workspacePath: string): string {
  const normalized = workspacePath.trim().replace(/[\\/]+$/, "");
  if (!normalized) {
    return "";
  }
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

export interface TaskRecord {
  id: string;
  title: string;
  status: TaskStatus;
  cwd: string;
  opencodeSessionId: string | null;
  agentCount: number;
  createdAt: string;
  completedAt: string | null;
  initializedAt: string | null;
}

export interface AgentRecord {
  name: string;
  prompt: string;
  isWritable?: boolean;
}

export interface TopologyAgentSeed {
  name: string;
}

export type TopologyNodeKind = "agent" | "spawn";

export type SpawnedAgentRole = "pro" | "con" | "summary" | string;

export interface SpawnedAgentTemplate {
  role: SpawnedAgentRole;
  templateName: string;
}

export interface SpawnRule {
  id: string;
  name: string;
  spawnNodeName: string;
  sourceTemplateName?: string;
  itemsFrom?: string;
  itemKey?: string;
  entryRole: SpawnedAgentRole;
  spawnedAgents: SpawnedAgentTemplate[];
  edges: Array<{
    sourceRole: SpawnedAgentRole;
    targetRole: SpawnedAgentRole;
    triggerOn: TopologyEdgeTrigger;
  }>;
  exitWhen: "one_side_agrees" | "all_completed";
  reportToTemplateName?: string;
  reportToTriggerOn?: TopologyEdgeTrigger;
}

export interface TopologyNodeRecord {
  id: string;
  kind: TopologyNodeKind;
  templateName: string;
  spawnRuleId?: string;
  spawnEnabled?: boolean;
  prompt?: string;
  writable?: boolean;
}

export interface TaskAgentRecord {
  id: string;
  taskId: string;
  name: string;
  opencodeSessionId: string | null;
  opencodeAttachBaseUrl: string | null;
  status: AgentStatus;
  runCount: number;
}

export type TopologyEdgeTrigger = "association" | "approved" | "needs_revision";

export const DEFAULT_NEEDS_REVISION_MAX_ROUNDS = 4;
export const LANGGRAPH_START_NODE_ID = "__start__";
export const LANGGRAPH_END_NODE_ID = "__end__";

export interface TopologyEdge {
  source: string;
  target: string;
  triggerOn: TopologyEdgeTrigger;
  maxRevisionRounds?: number;
}

export interface TopologyLangGraphStartNode {
  id: typeof LANGGRAPH_START_NODE_ID;
  targets: string[];
}

export interface TopologyLangGraphEndNode {
  id: typeof LANGGRAPH_END_NODE_ID;
  sources: string[];
}

export interface TopologyLangGraphRecord {
  start: TopologyLangGraphStartNode;
  end: TopologyLangGraphEndNode | null;
}

export interface TopologyRecord {
  nodes: string[];
  edges: TopologyEdge[];
  langgraph?: TopologyLangGraphRecord;
  nodeRecords?: TopologyNodeRecord[];
  spawnRules?: SpawnRule[];
}

export interface RuntimeTopologyNode {
  id: string;
  kind: TopologyNodeKind;
  templateName: string;
  displayName: string;
  sourceNodeId: string;
  groupId: string | null;
  role: SpawnedAgentRole | null;
  spawnRuleId?: string;
}

export interface RuntimeTopologyEdge {
  source: string;
  target: string;
  triggerOn: TopologyEdgeTrigger;
}

export interface SpawnItemPayload {
  id: string;
  title: string;
}

export interface SpawnBundleInstantiation {
  groupId: string;
  activationId: string;
  spawnNodeName: string;
  sourceTemplateName?: string;
  reportToTemplateName?: string;
  item: SpawnItemPayload;
  nodes: RuntimeTopologyNode[];
  edges: RuntimeTopologyEdge[];
}

export interface SpawnActivationRecord {
  id: string;
  spawnNodeName: string;
  spawnRuleId: string;
  sourceContent: string;
  bundleGroupIds: string[];
  completedBundleGroupIds: string[];
  dispatched: boolean;
}

export function normalizeNeedsRevisionMaxRounds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_NEEDS_REVISION_MAX_ROUNDS;
  }

  return Math.max(1, Math.floor(value));
}

export function getNeedsRevisionEdgeLoopLimit(
  topology: Pick<TopologyRecord, "edges">,
  sourceAgentId: string,
  targetAgentId: string,
): number {
  const edge = topology.edges.find(
    (item) =>
      item.source === sourceAgentId
      && item.target === targetAgentId
      && item.triggerOn === "needs_revision",
  );
  return normalizeNeedsRevisionMaxRounds(edge?.maxRevisionRounds);
}

export interface MessageRecord {
  id: string;
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
  messages: MessageRecord[];
  topology: TopologyRecord;
}

export interface WorkspaceSnapshot {
  cwd: string;
  name: string;
  agents: AgentRecord[];
  topology: TopologyRecord;
  messages: MessageRecord[];
  tasks: TaskSnapshot[];
}

export interface UiSnapshotPayload {
  workspace: WorkspaceSnapshot | null;
  task: TaskSnapshot | null;
  launchTaskId: string | null;
  launchCwd: string | null;
  taskLogFilePath: string | null;
  taskUrl: string | null;
}

export interface SubmitTaskPayload {
  cwd?: string;
  taskId?: string | null;
  newTaskId?: string | null;
  content: string;
  mentionAgent?: string;
}

export interface CopyToClipboardPayload {
  text: string;
}

export interface InitializeTaskPayload {
  cwd: string;
  title?: string;
  taskId?: string | null;
}

export interface UpdateTopologyPayload {
  cwd: string;
  topology: TopologyRecord;
}

export interface GetTaskRuntimePayload {
  cwd: string;
  taskId: string;
}

export interface OpenAgentTerminalPayload {
  cwd: string;
  taskId: string;
  agentName: string;
}

export interface DeleteTaskPayload {
  cwd: string;
  taskId: string;
}

export interface RuntimeUpdatedEventPayload {
  taskId: string;
  sessionId: string | null;
  timestamp: string;
}

export interface AgentTeamEvent {
  type:
    | "workspace-updated"
    | "task-created"
    | "task-updated"
    | "message-created"
    | "agent-status-changed"
    | "runtime-updated";
  cwd: string;
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

export function getTopologyEdgeId(edge: Pick<TopologyEdge, "source" | "target" | "triggerOn">): string {
  return `${edge.source}__${edge.target}__${edge.triggerOn}`;
}

export function isReviewAgentInTopology(
  topology: Pick<TopologyRecord, "edges">,
  agentName: string,
): boolean {
  return topology.edges.some(
    (edge) =>
      edge.source === agentName &&
      (edge.triggerOn === "approved" || edge.triggerOn === "needs_revision"),
  );
}

export function resolveBuildAgentName(
  agents: ReadonlyArray<Pick<TopologyAgentSeed, "name"> | string>,
): string | null {
  for (const agent of agents) {
    const agentName = typeof agent === "string" ? agent : agent.name;
    if (usesOpenCodeBuiltinPrompt(agentName)) {
      return agentName;
    }
  }
  return null;
}

export function resolvePrimaryTopologyStartTarget(
  topology: Pick<TopologyRecord, "langgraph" | "nodes">,
): string | null {
  const explicitStartTarget = topology.langgraph?.start.targets.find((target) => target.trim().length > 0);
  if (explicitStartTarget) {
    return explicitStartTarget;
  }
  return topology.nodes[0] ?? null;
}

export function resolveTopologyStartAgent(
  agents: Array<Pick<TopologyAgentSeed, "name">>,
): string | null {
  return resolveBuildAgentName(agents);
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

export function createDefaultTopology(
  agents: TopologyAgentSeed[],
): TopologyRecord {
  const nodes = resolveTopologyAgentOrder(agents);
  const names = new Set(nodes);
  const edges: TopologyEdge[] = [];

  const startAgentName = resolveTopologyStartAgent(agents);
  const startAgent =
    agents.find((agent) => agent.name === startAgentName) ?? null;
  const nextAgent =
    agents.find((agent) => agent.name !== startAgent?.name) ?? null;

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
    edges.push({
      source,
      target,
      triggerOn,
      ...(triggerOn === "needs_revision"
        ? {
            maxRevisionRounds: DEFAULT_NEEDS_REVISION_MAX_ROUNDS,
          }
        : {}),
    });
  };

  push(startAgent?.name, nextAgent?.name, "association");

  return {
    nodes,
    edges,
    langgraph: createTopologyLangGraphRecord({
      nodes,
      edges,
      startTargets: [startAgent?.name ?? nodes[0] ?? ""],
      endSources: null,
    }),
    nodeRecords: nodes.map((name) => ({
      id: name,
      kind: "agent",
      templateName: name,
    })),
    spawnRules: [],
  };
}

export function getTopologyNodeRecords(topology: TopologyRecord): TopologyNodeRecord[] {
  const explicit = topology.nodeRecords?.filter(
    (node): node is TopologyNodeRecord =>
      typeof node?.id === "string"
      && node.id.length > 0
      && typeof node.templateName === "string"
      && node.templateName.length > 0
      && (node.kind === "agent" || node.kind === "spawn"),
  );
  if (explicit && explicit.length > 0) {
    return explicit.map((node) => ({ ...node }));
  }

  return topology.nodes.map((name) => ({
    id: name,
    kind: "agent",
    templateName: name,
  }));
}

export function getSpawnRules(topology: TopologyRecord): SpawnRule[] {
  return (topology.spawnRules ?? []).map((rule) => ({
    ...rule,
    spawnedAgents: rule.spawnedAgents.map((agent) => ({ ...agent })),
    edges: rule.edges.map((edge) => ({ ...edge })),
  }));
}

export function resolveSpawnItemsField(rule: Pick<SpawnRule, "itemsFrom" | "itemKey">): string {
  const field = rule.itemsFrom?.trim() || rule.itemKey?.trim() || "items";
  return field.length > 0 ? field : "items";
}

export function createTopologyLangGraphRecord(input: {
  nodes: string[];
  edges: TopologyEdge[];
  startTargets?: ReadonlyArray<string | null | undefined>;
  endSources?: ReadonlyArray<string | null | undefined> | null;
}): TopologyLangGraphRecord {
  const knownNodes = new Set(input.nodes);
  const normalizeRefs = (values: ReadonlyArray<string | null | undefined> | null | undefined) =>
    (values ?? [])
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim())
      .filter((value, index, list) => list.indexOf(value) === index)
      .filter((value) => knownNodes.has(value));

  let startTargets = normalizeRefs(input.startTargets);
  if (startTargets.length === 0) {
    const incomingTargets = new Set(input.edges.map((edge) => edge.target));
    startTargets = input.nodes.filter((node) => !incomingTargets.has(node));
  }
  if (startTargets.length === 0 && input.nodes.length > 0) {
    startTargets = [input.nodes[0]!];
  }

  const endSources = normalizeRefs(input.endSources);

  return {
    start: {
      id: LANGGRAPH_START_NODE_ID,
      targets: startTargets,
    },
    end: endSources.length > 0
      ? {
          id: LANGGRAPH_END_NODE_ID,
          sources: endSources,
        }
      : null,
  };
}
