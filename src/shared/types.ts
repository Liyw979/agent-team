export type AgentStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "continue";

export type TaskStatus =
  | "pending"
  | "running"
  | "finished"
  | "failed"
  | "continue";

export type PermissionMode = "allow" | "ask" | "deny";

export const BUILD_AGENT_ID = "Build";

export function usesOpenCodeBuiltinPrompt(agentId: string): boolean {
  return agentId.trim().toLowerCase() === BUILD_AGENT_ID.toLowerCase();
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
  id: string;
  prompt: string;
  isWritable?: boolean;
}

export interface TopologyAgentSeed {
  id: string;
}

export type TopologyNodeKind = "agent" | "spawn";

export type SpawnedAgentRole = "pro" | "con" | "summary" | string;

export interface SpawnedAgentTemplate {
  role: SpawnedAgentRole;
  templateName: string;
}

export interface SpawnRule {
  id: string;
  spawnNodeName?: string;
  sourceTemplateName?: string;
  entryRole: SpawnedAgentRole;
  spawnedAgents: SpawnedAgentTemplate[];
  edges: Array<{
    sourceRole: SpawnedAgentRole;
    targetRole: SpawnedAgentRole;
    triggerOn: TopologyEdgeTrigger;
    messageMode: TopologyEdgeMessageMode;
    maxRevisionRounds?: number;
  }>;
  exitWhen: "one_side_agrees" | "all_completed";
  reportToTemplateName?: string;
  reportToTriggerOn?: TopologyEdgeTrigger;
  reportToMessageMode?: TopologyEdgeMessageMode;
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
  opencodeSessionId: string | null;
  opencodeAttachBaseUrl: string | null;
  status: AgentStatus;
  runCount: number;
}

export type TopologyEdgeTrigger = | "transfer" | "complete" | "continue";
export type TopologyEdgeMessageMode = "none" | "last" | "last-all";

export const DEFAULT_ACTION_REQUIRED_MAX_ROUNDS = 4;
export const DEFAULT_TOPOLOGY_EDGE_MESSAGE_MODE: TopologyEdgeMessageMode = "last";
export const LANGGRAPH_START_NODE_ID = "__start__";
export const LANGGRAPH_END_NODE_ID = "__end__";

export interface TopologyEdge {
  source: string;
  target: string;
  triggerOn: TopologyEdgeTrigger;
  messageMode: TopologyEdgeMessageMode;
  maxRevisionRounds?: number;
}

export interface TopologyLangGraphStartNode {
  id: typeof LANGGRAPH_START_NODE_ID;
  targets: string[];
}

export interface TopologyLangGraphEndIncoming {
  source: string;
  triggerOn?: TopologyEdgeTrigger;
}

export interface TopologyLangGraphEndNode {
  id: typeof LANGGRAPH_END_NODE_ID;
  sources: string[];
  incoming?: TopologyLangGraphEndIncoming[];
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
  messageMode: TopologyEdgeMessageMode;
  maxRevisionRounds?: number;
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

export function normalizeActionRequiredMaxRounds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_ACTION_REQUIRED_MAX_ROUNDS;
  }

  return Math.max(1, Math.floor(value));
}

export function getActionRequiredEdgeLoopLimit(
  topology: Pick<TopologyRecord, "edges">,
  sourceAgentId: string,
  targetAgentId: string,
): number {
  const edge = topology.edges.find(
    (item) =>
      item.source === sourceAgentId
      && item.target === targetAgentId
      && normalizeTopologyEdgeTrigger(item.triggerOn) === "continue",
  );
  return normalizeActionRequiredMaxRounds(edge?.maxRevisionRounds);
}

interface BaseMessageRecord {
  id: string;
  taskId: string;
  content: string;
  sender: string;
  timestamp: string;
}

export interface UserMessageRecord extends BaseMessageRecord {
  kind: "user";
  sender: "user";
  scope: "task";
  taskTitle: string;
  targetAgentIds: string[];
}

export interface SystemMessageRecord extends BaseMessageRecord {
  kind: "system-message";
  sender: "system";
}

export interface TaskCreatedMessageRecord extends BaseMessageRecord {
  kind: "task-created";
  sender: "system";
}

export interface AgentFinalMessageRecord extends BaseMessageRecord {
  kind: "agent-final";
  reviewDecision: "complete" | "continue" | "invalid";
  reviewOpinion: string;
  rawResponse: string;
  status: "completed" | "error";
  senderDisplayName?: string;
}

export interface AgentDispatchMessageRecord extends BaseMessageRecord {
  kind: "agent-dispatch";
  targetAgentIds: string[];
  dispatchDisplayContent: string;
  senderDisplayName?: string;
}

export interface ActionRequiredRequestMessageRecord extends BaseMessageRecord {
  kind: "continue-request";
  targetAgentIds: string[];
  senderDisplayName?: string;
}

export interface TaskCompletedMessageRecord extends BaseMessageRecord {
  kind: "task-completed";
  sender: "system";
  status: "failed";
}

export interface TaskRoundFinishedMessageRecord extends BaseMessageRecord {
  kind: "task-round-finished";
  sender: "system";
  finishReason: string;
}

export type MessageRecord =
  | UserMessageRecord
  | SystemMessageRecord
  | TaskCreatedMessageRecord
  | AgentFinalMessageRecord
  | AgentDispatchMessageRecord
  | ActionRequiredRequestMessageRecord
  | TaskCompletedMessageRecord
  | TaskRoundFinishedMessageRecord;

export function isUserMessageRecord(message: MessageRecord): message is UserMessageRecord {
  return message.kind === "user";
}

export function isAgentFinalMessageRecord(message: MessageRecord): message is AgentFinalMessageRecord {
  return message.kind === "agent-final";
}

export function isAgentDispatchMessageRecord(message: MessageRecord): message is AgentDispatchMessageRecord {
  return message.kind === "agent-dispatch";
}

export function isActionRequiredRequestMessageRecord(message: MessageRecord): message is ActionRequiredRequestMessageRecord {
  return message.kind === "continue-request";
}

export function isTaskCompletedMessageRecord(message: MessageRecord): message is TaskCompletedMessageRecord {
  return message.kind === "task-completed";
}

export function isTaskRoundFinishedMessageRecord(message: MessageRecord): message is TaskRoundFinishedMessageRecord {
  return message.kind === "task-round-finished";
}

export function getMessageTargetAgentIds(message: MessageRecord): string[] {
  switch (message.kind) {
    case "user":
    case "agent-dispatch":
    case "continue-request":
      return message.targetAgentIds;
    default:
      return [];
  }
}

export function getMessageSenderDisplayName(message: MessageRecord): string | undefined {
  switch (message.kind) {
    case "agent-final":
    case "agent-dispatch":
    case "continue-request":
      return message.senderDisplayName;
    default:
      return undefined;
  }
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
  runtimeStatus: AgentStatus;
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
  taskId?: string;
  newTaskId?: string;
  content: string;
  mentionAgentId?: string;
}

export interface CopyToClipboardPayload {
  text: string;
}

export interface InitializeTaskPayload {
  cwd: string;
  title?: string;
  taskId?: string;
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
  agentId: string;
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

export function normalizeTopologyEdgeTrigger(value: unknown): "transfer" | "complete" | "continue" {
  if (value === "complete" || value === "continue") {
    return value;
  }
  return "transfer";
}

export function getTopologyEdgeId(edge: Pick<TopologyEdge, "source" | "target" | "triggerOn">): string {
  return `${edge.source}__${edge.target}__${normalizeTopologyEdgeTrigger(edge.triggerOn)}`;
}

export function isReviewAgentInTopology(
  topology: Pick<TopologyRecord, "edges"> & Partial<Pick<TopologyRecord, "langgraph">>,
  agentId: string,
): boolean {
  const hasReviewEdge = topology.edges.some(
    (edge) =>
      edge.source === agentId &&
      (() => {
        const triggerOn = normalizeTopologyEdgeTrigger(edge.triggerOn);
        return triggerOn === "complete" || triggerOn === "continue";
      })(),
  );
  if (hasReviewEdge) {
    return true;
  }

  return topology.langgraph?.end?.incoming?.some(
    (edge) =>
      edge.source === agentId &&
      edge.triggerOn &&
      (() => {
        const triggerOn = normalizeTopologyEdgeTrigger(edge.triggerOn);
        return triggerOn === "complete" || triggerOn === "continue";
      })(),
  ) === true;
}

export function resolveBuildAgentId(
  agents: ReadonlyArray<Pick<TopologyAgentSeed, "id"> | string>,
): string | null {
  for (const agent of agents) {
    const agentId = typeof agent === "string" ? agent : agent.id;
    if (usesOpenCodeBuiltinPrompt(agentId)) {
      return agentId;
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
  agents: Array<Pick<TopologyAgentSeed, "id">>,
): string | null {
  return resolveBuildAgentId(agents);
}

export function resolveTopologyAgentOrder(
  agents: Array<Pick<TopologyAgentSeed, "id">>,
  preferredOrderIds?: string[] | null,
): string[] {
  const availableAgentIds = agents.map((agent) => agent.id);
  const availableAgentSet = new Set(availableAgentIds);
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

  if (order.length === availableAgentIds.length) {
    return order;
  }

  push(resolveTopologyStartAgent(agents));
  for (const agentId of availableAgentIds) {
    push(agentId);
  }

  return order;
}

export function createDefaultTopology(
  agents: TopologyAgentSeed[],
): TopologyRecord {
  const nodes = resolveTopologyAgentOrder(agents);
  const names = new Set(nodes);
  const edges: TopologyEdge[] = [];

  const startAgentId = resolveTopologyStartAgent(agents);
  const startAgent =
    agents.find((agent) => agent.id === startAgentId) ?? null;
  const nextAgent =
    agents.find((agent) => agent.id !== startAgent?.id) ?? null;

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
      messageMode: DEFAULT_TOPOLOGY_EDGE_MESSAGE_MODE,
      ...(triggerOn === "continue"
        ? {
            maxRevisionRounds: DEFAULT_ACTION_REQUIRED_MAX_ROUNDS,
          }
        : {}),
    });
  };

  push(startAgent?.id, nextAgent?.id, "transfer");

  return {
    nodes,
    edges,
    langgraph: createTopologyLangGraphRecord({
      nodes,
      edges,
      startTargets: [startAgent?.id ?? nodes[0] ?? ""],
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
  const spawnNodeNameByRuleId = new Map(
    getTopologyNodeRecords(topology)
      .filter((node) => node.kind === "spawn")
      .map((node) => [node.spawnRuleId!, node.id]),
  );
  return (topology.spawnRules ?? []).map((rule) => ({
    ...rule,
    spawnNodeName: rule.spawnNodeName ?? spawnNodeNameByRuleId.get(rule.id) ?? rule.id,
    spawnedAgents: rule.spawnedAgents.map((agent) => ({ ...agent })),
    edges: rule.edges.map((edge) => ({
      ...edge,
      triggerOn: normalizeTopologyEdgeTrigger(edge.triggerOn),
    })),
    ...(rule.reportToTriggerOn
      ? { reportToTriggerOn: normalizeTopologyEdgeTrigger(rule.reportToTriggerOn) }
      : {}),
    ...(rule.reportToMessageMode
      ? { reportToMessageMode: rule.reportToMessageMode }
      : {}),
  }));
}

export function createTopologyLangGraphRecord(input: {
  nodes: string[];
  edges: TopologyEdge[];
  startTargets?: ReadonlyArray<string | null | undefined>;
  endSources?: ReadonlyArray<string | null | undefined> | null;
  endIncoming?: ReadonlyArray<{
    source: string | null | undefined;
    triggerOn?: TopologyEdgeTrigger | null | undefined;
  }> | null;
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

  const endIncoming = (input.endIncoming ?? [])
    .filter((value): value is { source: string; triggerOn?: TopologyEdgeTrigger | null | undefined } =>
      Boolean(value?.source) && typeof value.source === "string" && value.source.trim().length > 0)
    .map((value) => ({
      source: value.source.trim(),
      ...(value.triggerOn ? { triggerOn: normalizeTopologyEdgeTrigger(value.triggerOn) } : {}),
    }))
    .filter((value) => knownNodes.has(value.source))
    .filter((value, index, list) =>
      list.findIndex((item) => item.source === value.source && item.triggerOn === value.triggerOn) === index,
    );
  const endSources = normalizeRefs([
    ...((input.endSources ?? []) as ReadonlyArray<string | null | undefined>),
    ...endIncoming.map((item) => item.source),
  ]);

  return {
    start: {
      id: LANGGRAPH_START_NODE_ID,
      targets: startTargets,
    },
    end: endSources.length > 0
      ? {
          id: LANGGRAPH_END_NODE_ID,
          sources: endSources,
          ...(endIncoming.length > 0 ? { incoming: endIncoming } : {}),
        }
      : null,
  };
}
