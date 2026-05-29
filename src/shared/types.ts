import { z } from "zod";

export type AgentStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed";

export type TaskStatus =
  | "pending"
  | "running"
  | "finished"
  | "failed";

export type PermissionMode = "allow" | "ask" | "deny";
export type AgentIdResolution =
  | {
      kind: "found";
      agentId: string;
    }
  | {
      kind: "missing";
    };

const BUILD_AGENT_ID = "Build";
declare const UTC_ISO_TIMESTAMP_BRAND: unique symbol;
const UTC_ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export type UtcIsoTimestamp = string & {
  readonly [UTC_ISO_TIMESTAMP_BRAND]: "UtcIsoTimestamp";
};

export function toUtcIsoTimestamp(value: string): UtcIsoTimestamp {
  if (!UTC_ISO_TIMESTAMP_PATTERN.test(value)) {
    throw new Error(`非法 UTC ISO 时间戳：${value}`);
  }
  if (new Date(value).toISOString() !== value) {
    throw new Error(`非法 UTC ISO 时间戳：${value}`);
  }
  return value as UtcIsoTimestamp;
}

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
  // Task ownership still needs the workspace fact even though runtime isolation no longer indexes by cwd.
  cwd: string;
  agentCount: number;
  createdAt: string;
  completedAt: string;
  initializedAt: string;
}

export interface AgentRecord {
  id: string;
  prompt: string;
  isWritable: boolean;
}

type GroupMemberRole = "pro" | "con" | "summary" | string;
export type InitialMessageRouting =
  | {
      mode: "inherit";
    }
  | {
      mode: "none";
    }
  | {
      mode: "list";
      agentIds: string[];
    };

function buildTopologyTrigger(name: string): TopologyTrigger {
  return `<${name}>`;
}

export const DEFAULT_TOPOLOGY_TRIGGER = buildTopologyTrigger("default");

interface GroupMemberTemplate {
  role: GroupMemberRole;
  templateName: string;
}

interface GroupRuleBase {
  id: string;
  groupNodeName?: string;
  sourceTemplateName?: string;
  entryRole: GroupMemberRole;
  members: GroupMemberTemplate[];
  edges: Array<{
    sourceRole: GroupMemberRole;
    targetRole: GroupMemberRole;
    trigger: TopologyTrigger;
    messageMode: TopologyEdgeMessageMode;
    maxTriggerRounds: number;
  }>;
}

export type GroupRuleWithReport = GroupRuleBase & {
  report: {
    templateName: string;
    sourceRole: GroupMemberRole;
    trigger: TopologyTrigger;
    messageMode: TopologyEdgeMessageMode;
    maxTriggerRounds: number;
  };
};

export type GroupRuleWithoutReport = GroupRuleBase & {
  report: false;
};

export type GroupRule = GroupRuleWithReport | GroupRuleWithoutReport;

export interface TopologyAgentNodeRecord {
  id: string;
  kind: "agent";
  templateName: string;
  initialMessageRouting: InitialMessageRouting;
  prompt: string;
  writable: boolean;
}

export interface TopologyGroupNodeRecord {
  id: string;
  kind: "group";
  templateName: string;
  initialMessageRouting: InitialMessageRouting;
  groupRuleId: string;
}

export type TopologyNodeRecord =
  | TopologyAgentNodeRecord
  | TopologyGroupNodeRecord;

export interface TaskAgentRecord {
  id: string;
  opencodeSessionId: string;
  opencodeAttachBaseUrl: string;
  status: AgentStatus;
  runCount: number;
}

export type TopologyTrigger = string;
export type TopologyEdgeTrigger = TopologyTrigger;
export type TopologyEdgeMessageMode = "none" | "last";
// 2026-05-29: 用户要求路由结果只保留单一联合表达，禁止回退为 routingKind + trigger 两个顶层字段并行描述同一语义。
export type AgentRouting =
  | {
      kind: "default";
    }
  | {
      kind: "invalid";
    }
  | {
      kind: "triggered";
      trigger: TopologyTrigger;
    };

const DEFAULT_MAX_TRIGGER_ROUNDS = 4;
const DEFAULT_TOPOLOGY_EDGE_MESSAGE_MODE: TopologyEdgeMessageMode =
  "last";
export const FLOW_START_NODE_ID = "__start__";
export const FLOW_END_NODE_ID = "__end__";

export interface TopologyEdge {
  source: string;
  target: string;
  trigger: TopologyTrigger;
  messageMode: TopologyEdgeMessageMode;
  maxTriggerRounds: number;
}

interface TopologyTriggerRouteInput {
  edges: ReadonlyArray<
    Pick<TopologyEdge, "source" | "trigger" | "maxTriggerRounds">
  >;
  endIncoming: ReadonlyArray<TopologyFlowEndIncoming>;
}

type TopologyTriggerRouteResolution =
  | {
      kind: "triggered";
    }
  | {
      kind: "invalid";
    };

export interface TopologyFlowStartNode {
  id: typeof FLOW_START_NODE_ID;
  targets: string[];
}

export interface TopologyFlowEndIncoming {
  source: string;
  trigger: TopologyTrigger;
}

export interface TopologyFlowEndNode {
  id: typeof FLOW_END_NODE_ID;
  sources: string[];
  incoming: TopologyFlowEndIncoming[];
}

export interface TopologyFlowRecord {
  start: TopologyFlowStartNode;
  end: TopologyFlowEndNode;
}

export interface TopologyRecord {
  nodes: string[];
  edges: TopologyEdge[];
  flow: TopologyFlowRecord;
  nodeRecords: TopologyNodeRecord[];
  groupRules?: GroupRule[];
}

interface GroupBundleRuntimeNodeBase {
  id: string;
  templateName: string;
  displayName: string;
  sourceNodeId: string;
  groupId: string;
  role: GroupMemberRole;
}

export type GroupBundleRuntimeNode =
  | (GroupBundleRuntimeNodeBase & {
      kind: "agent";
    })
  | (GroupBundleRuntimeNodeBase & {
      kind: "group";
      groupRuleId: string;
    });

export type RuntimeTopologyNode = GroupBundleRuntimeNode;

export interface RuntimeTopologyEdge {
  source: string;
  target: string;
  trigger: TopologyTrigger;
  messageMode: TopologyEdgeMessageMode;
  maxTriggerRounds: number;
}

export interface GroupItemPayload {
  id: string;
  title: string;
}

export interface GroupBundleInstantiation {
  groupId: string;
  activationId: string;
  groupNodeName: string;
  item: GroupItemPayload;
  nodes: GroupBundleRuntimeNode[];
  edges: RuntimeTopologyEdge[];
}

export interface GroupActivationRecord {
  id: string;
  groupNodeName: string;
  groupRuleId: string;
  sourceContent: string;
  bundleGroupIds: string[];
  completedBundleGroupIds: string[];
  dispatched: boolean;
}

const MaxTriggerRoundsSchema = z
  .number({
    invalid_type_error: "maxTriggerRounds 必须是 -1 或大于等于 1 的整数",
    required_error: "maxTriggerRounds 必须是 -1 或大于等于 1 的整数",
  })
  .int("maxTriggerRounds 必须是 -1 或大于等于 1 的整数")
  .refine(
    (value) => value === -1 || value >= 1,
    "maxTriggerRounds 必须是 -1 或大于等于 1 的整数",
  );

export function normalizeMaxTriggerRounds(value: unknown): number {
  return MaxTriggerRoundsSchema.parse(value);
}

export function normalizeInitialMessageAgentIds(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  const rawValues = typeof value === "string" ? [value] : value;
  if (!Array.isArray(rawValues)) {
    throw new Error("initialMessage 必须是字符串或字符串数组");
  }

  const normalizedValues: string[] = [];
  for (const item of rawValues) {
    if (typeof item !== "string") {
      throw new Error("initialMessage 只允许包含 Agent ID 字符串");
    }
    const normalizedItem = item.trim();
    if (!normalizedItem) {
      throw new Error("initialMessage 不允许包含空白 Agent ID");
    }
    if (!normalizedValues.includes(normalizedItem)) {
      normalizedValues.push(normalizedItem);
    }
  }

  return normalizedValues;
}

function assertInitialMessageAgentIds(value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) {
    throw new Error("initialMessageRouting.mode=list 时必须显式提供 agentIds 数组");
  }
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error("initialMessageRouting.agentIds 只允许包含非空 Agent ID 字符串");
    }
  }
}

export function parseInitialMessageRoutingFromDslInput(
  value: unknown,
): InitialMessageRouting {
  if (value === undefined) {
    return { mode: "inherit" };
  }

  const agentIds = normalizeInitialMessageAgentIds(value);
  if (agentIds.length === 0) {
    return { mode: "none" };
  }
  return {
    mode: "list",
    agentIds,
  };
}

function assertInitialMessageRouting(
  value: unknown,
): asserts value is InitialMessageRouting {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "mode" in value
  ) {
    const record = value as Record<string, unknown>;
    if (record["mode"] === "inherit") {
      return;
    }
    if (record["mode"] === "none") {
      return;
    }
    if (record["mode"] === "list") {
      assertInitialMessageAgentIds(record["agentIds"]);
      return;
    }
    throw new Error("非法 initialMessageRouting.mode");
  }

  throw new Error("非法 initialMessageRouting");
}

export function getTriggerEdgeLoopLimit(
  topology: Pick<TopologyRecord, "edges" | "flow">,
  sourceAgentId: string,
  targetAgentId: string,
  trigger: string,
): number {
  const candidateEdges = topology.edges.filter(
    (item) =>
      item.source === sourceAgentId &&
      item.target === targetAgentId &&
      resolveTriggerRoutingKindForSource(
        topology,
        item.source,
        item.trigger,
      ).kind === "triggered",
  );
  if (candidateEdges.length === 0) {
    throw new Error(
      `未找到 trigger 边：${sourceAgentId} -> ${targetAgentId}`,
    );
  }

  const edge = candidateEdges.find(
    (item) => normalizeTopologyEdgeTrigger(item.trigger) === trigger,
  );
  if (!edge) {
    throw new Error(
      `未找到匹配 trigger 的边：${sourceAgentId} -> ${targetAgentId} (${trigger})`,
    );
  }

  return normalizeMaxTriggerRounds(edge.maxTriggerRounds);
}

interface BaseMessageRecord {
  id: string;
  content: string;
  sender: string;
  timestamp: UtcIsoTimestamp;
}

export interface UserMessageRecord extends BaseMessageRecord {
  kind: "user";
  sender: "user";
  scope: "task";
  taskTitle: string;
  targetAgentIds: string[];
  targetRunCounts: number[];
}

export interface SystemMessageRecord extends BaseMessageRecord {
  kind: "system-message";
  sender: "system";
}

export interface TaskCreatedMessageRecord extends BaseMessageRecord {
  kind: "task-created";
  sender: "system";
}

export type AgentProgressActivityKind =
  | "thinking"
  | "tool"
  | "step"
  | "message";

export interface AgentProgressMessageRecord extends BaseMessageRecord {
  kind: "agent-progress";
  activityKind: AgentProgressActivityKind;
  label: string;
  detail: string;
  detailState: "complete" | "missing" | "not_applicable";
  sessionId: string;
  runCount: number;
}

type AgentFinalMessageRecordBase = BaseMessageRecord & {
  kind: "agent-final";
  runCount: number;
  rawResponse: string;
  status: "completed" | "error";
  senderDisplayName: string;
};

export type AgentFinalMessageRecord = AgentFinalMessageRecordBase & {
  routing: AgentRouting;
};

export interface AgentDispatchMessageRecord extends BaseMessageRecord {
  kind: "agent-dispatch";
  targetAgentIds: string[];
  targetRunCounts: number[];
  dispatchDisplayContent: string;
  senderDisplayName: string;
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
  | AgentProgressMessageRecord
  | AgentFinalMessageRecord
  | AgentDispatchMessageRecord
  | TaskCompletedMessageRecord
  | TaskRoundFinishedMessageRecord;

export function isUserMessageRecord(
  message: MessageRecord,
): message is UserMessageRecord {
  return message.kind === "user";
}

export function isAgentFinalMessageRecord(
  message: MessageRecord,
): message is AgentFinalMessageRecord {
  return message.kind === "agent-final";
}

export function isTriggeredAgentRouting(
  routing: AgentRouting,
): routing is Extract<AgentRouting, { kind: "triggered" }> {
  return routing.kind === "triggered";
}

export function isAgentProgressMessageRecord(
  message: MessageRecord,
): message is AgentProgressMessageRecord {
  return message.kind === "agent-progress";
}

export function isAgentDispatchMessageRecord(
  message: MessageRecord,
): message is AgentDispatchMessageRecord {
  return message.kind === "agent-dispatch";
}

export function isTaskCompletedMessageRecord(
  message: MessageRecord,
): message is TaskCompletedMessageRecord {
  return message.kind === "task-completed";
}

export function isTaskRoundFinishedMessageRecord(
  message: MessageRecord,
): message is TaskRoundFinishedMessageRecord {
  return message.kind === "task-round-finished";
}

export function getMessageTargetAgentIds(message: MessageRecord): string[] {
  switch (message.kind) {
    case "user":
    case "agent-dispatch":
      return message.targetAgentIds;
    default:
      return [];
  }
}

export function getMessageSenderDisplayName(
  message: MessageRecord,
): string | undefined {
  switch (message.kind) {
    case "agent-final":
    case "agent-dispatch":
      return message.senderDisplayName;
    default:
      return undefined;
  }
}

export interface TaskSnapshot {
  task: TaskRecord;
  agents: TaskAgentRecord[];
  messages: MessageRecord[];
  topology: TopologyRecord;
}

export interface WorkspaceSnapshot {
  // UI snapshot keeps the current workspace fact for display only.
  cwd: string;
  name: string;
  agents: AgentRecord[];
  topology: TopologyRecord;
}

interface UiSnapshotPayloadBase {
  // Browser bootstrap only uses this to show where the current UI session was launched from.
  launchCwd: string;
  taskUrl: string;
}

export type UiSnapshotPayload =
  | (UiSnapshotPayloadBase & {
      kind: "workspace";
      workspace: WorkspaceSnapshot;
    })
  | (UiSnapshotPayloadBase & {
      kind: "task";
      workspace: WorkspaceSnapshot;
      task: TaskSnapshot;
      taskLogFilePath: string;
    });

export type SubmitTaskPayload = string;

export function normalizeTopologyEdgeTrigger(value: unknown): TopologyTrigger {
  if (typeof value !== "string") {
    throw new Error(`非法拓扑 trigger：${String(value)}`);
  }
  const normalized = value.trim();
  if (!/^<([^\s<>/]+)>$/u.test(normalized)) {
    throw new Error(`非法拓扑 trigger：${String(value)}`);
  }
  return normalized;
}

export function isDefaultTopologyTrigger(trigger: string): boolean {
  return trigger === DEFAULT_TOPOLOGY_TRIGGER;
}

export function collectTopologyTriggerShapes(
  input: TopologyTriggerRouteInput,
): Array<{ source: string; trigger: TopologyTrigger }> {
  const routesBySourceAndTrigger = new Map<string, { source: string; trigger: TopologyTrigger }>();
  const register = (source: string, trigger: string) => {
    if (isDefaultTopologyTrigger(trigger)) {
      return;
    }
    const normalizedTrigger = normalizeTopologyEdgeTrigger(trigger);
    const key = `${source}__${normalizedTrigger}`;
    routesBySourceAndTrigger.set(key, {
      source,
      trigger: normalizedTrigger,
    });
  };

  for (const edge of input.edges) {
    const normalizedTrigger = normalizeTopologyEdgeTrigger(edge.trigger);
    if (isDefaultTopologyTrigger(normalizedTrigger)) {
      continue;
    }
    register(edge.source, normalizedTrigger);
  }
  for (const edge of input.endIncoming) {
    register(edge.source, edge.trigger);
  }

  return [...routesBySourceAndTrigger.values()];
}

export function resolveTriggerRoutingKindForSource(
  topology: Pick<TopologyRecord, "edges" | "flow">,
  source: string,
  trigger: string,
): TopologyTriggerRouteResolution {
  const normalizedTrigger = normalizeTopologyEdgeTrigger(trigger);
  if (isDefaultTopologyTrigger(normalizedTrigger)) {
    return { kind: "invalid" };
  }
  const matched = collectTopologyTriggerShapes({
    edges: topology.edges,
    endIncoming: getTopologyEndIncoming(topology),
  }).some(
    (item) => item.source === source && item.trigger === normalizedTrigger,
  );
  return matched ? { kind: "triggered" } : { kind: "invalid" };
}

function getTopologyEndIncoming(
  topology: Pick<TopologyRecord, "flow">,
): TopologyFlowEndIncoming[] {
  return topology.flow.end.incoming;
}

export function getTopologyEdgeId(
  edge: Pick<TopologyEdge, "source" | "target" | "trigger">,
): string {
  return `${edge.source}__${edge.target}__${normalizeTopologyEdgeTrigger(edge.trigger)}`;
}

export function isDecisionAgentInTopology(
  topology: Pick<TopologyRecord, "edges" | "flow">,
  agentId: string,
): boolean {
  const hasDecisionEdge = topology.edges.some(
    (edge) =>
      edge.source === agentId &&
      !isDefaultTopologyTrigger(normalizeTopologyEdgeTrigger(edge.trigger)),
  );
  if (hasDecisionEdge) {
    return true;
  }

  return getTopologyEndIncoming(topology).some(
    (edge) =>
      edge.source === agentId &&
      !isDefaultTopologyTrigger(normalizeTopologyEdgeTrigger(edge.trigger)),
  );
}

export function resolveBuildAgentId(
  agentIds: readonly string[],
): AgentIdResolution {
  const agentId = agentIds.find((candidate) => usesOpenCodeBuiltinPrompt(candidate));
  return typeof agentId === "string"
    ? { kind: "found", agentId }
    : { kind: "missing" };
}

export function resolvePrimaryTopologyStartTarget(
  topology: Pick<TopologyRecord, "flow" | "nodes">,
): AgentIdResolution {
  const agentId = topology.flow.start.targets.find(
    (target) => target.trim().length > 0,
  ) ?? topology.nodes[0];
  return typeof agentId === "string"
    ? { kind: "found", agentId }
    : { kind: "missing" };
}

export function resolveTopologyAgentOrder(
  agentIds: readonly string[],
  preferredOrderIds: ReadonlyArray<string> = [],
): string[] {
  const availableAgentSet = new Set(agentIds);
  const order: string[] = [];
  const push = (name: string) => {
    if (!availableAgentSet.has(name) || order.includes(name)) {
      return;
    }
    order.push(name);
  };

  for (const name of preferredOrderIds) {
    push(name);
  }

  if (order.length === agentIds.length) {
    return order;
  }

  const startAgent = resolveBuildAgentId(agentIds);
  if (startAgent.kind === "found") {
    push(startAgent.agentId);
  }
  for (const agentId of agentIds) {
    push(agentId);
  }

  return order;
}

export function createDefaultTopology(
  agentIds: readonly string[],
): TopologyRecord {
  const nodes = resolveTopologyAgentOrder(agentIds);
  const names = new Set(nodes);
  const edges: TopologyEdge[] = [];

  const startAgent = resolveBuildAgentId(agentIds);

  const push = (
    source: string,
    target: string,
    trigger: TopologyEdge["trigger"],
  ) => {
    if (!names.has(source) || !names.has(target)) {
      return;
    }
    edges.push({
      source,
      target,
      trigger,
      messageMode: DEFAULT_TOPOLOGY_EDGE_MESSAGE_MODE,
      maxTriggerRounds: DEFAULT_MAX_TRIGGER_ROUNDS,
    });
  };

  if (startAgent.kind === "found") {
    const nextAgentIds = agentIds.filter((agentId) => agentId !== startAgent.agentId);
    const nextAgentId = nextAgentIds.find((agentId) => names.has(agentId));
    if (typeof nextAgentId === "string") {
      push(startAgent.agentId, nextAgentId, DEFAULT_TOPOLOGY_TRIGGER);
    }
  }

  const startTargets =
    startAgent.kind === "found"
      ? [startAgent.agentId]
      : nodes.slice(0, 1);

  return {
    nodes,
    edges,
    flow: createTopologyFlowRecord({
      nodes,
      edges,
      startTargets,
    }),
    nodeRecords: buildTopologyNodeRecords({
      nodes,
      groupNodeIds: new Set(),
      templateNameByNodeId: new Map(),
      initialMessageRoutingByNodeId: new Map(),
      groupRuleIdByNodeId: new Map(),
      promptByNodeId: new Map(),
      writableNodeIds: new Set(),
    }),
    groupRules: [],
  };
}

export function buildTopologyNodeRecords(input: {
  nodes: string[];
  groupNodeIds: ReadonlySet<string>;
  templateNameByNodeId: ReadonlyMap<string, string>;
  initialMessageRoutingByNodeId: ReadonlyMap<string, InitialMessageRouting>;
  groupRuleIdByNodeId: ReadonlyMap<string, string>;
  promptByNodeId: ReadonlyMap<string, string>;
  writableNodeIds: ReadonlySet<string>;
}): TopologyNodeRecord[] {
  return input.nodes.map((nodeId) => {
    const templateName = input.templateNameByNodeId.get(nodeId) ?? nodeId;
    const initialMessageRouting =
      input.initialMessageRoutingByNodeId.get(nodeId) ?? { mode: "inherit" };
    const isGroupNode = input.groupNodeIds.has(nodeId);
    if (isGroupNode) {
      const groupRuleId = input.groupRuleIdByNodeId.get(nodeId);
      if (typeof groupRuleId !== "string" || groupRuleId.length === 0) {
        throw new Error(`group 节点缺少 groupRuleId：${nodeId}`);
      }
      return {
        id: nodeId,
        kind: "group",
        templateName,
        initialMessageRouting,
        groupRuleId,
      };
    }
    return {
      id: nodeId,
      kind: "agent",
      templateName,
      initialMessageRouting,
      prompt: input.promptByNodeId.get(nodeId) ?? "",
      writable: input.writableNodeIds.has(nodeId),
    };
  });
}

export function getTopologyNodeRecords(
  topology: TopologyRecord,
): TopologyNodeRecord[] {
  if (topology.nodeRecords.length === 0) {
    throw new Error("拓扑缺少 nodeRecords。");
  }
  for (const node of topology.nodeRecords) {
    if (
      typeof node?.id !== "string" ||
      node.id.length === 0 ||
      typeof node.templateName !== "string" ||
      node.templateName.length === 0 ||
      (node.kind !== "agent" && node.kind !== "group")
    ) {
      throw new Error("拓扑 nodeRecords 存在非法节点记录。");
    }
    assertInitialMessageRouting(node.initialMessageRouting);
    if (node.kind === "agent") {
      if (typeof node.prompt !== "string" || typeof node.writable !== "boolean") {
        throw new Error(`agent 节点记录不完整：${node.id}`);
      }
      continue;
    }
    if (
      typeof node.groupRuleId !== "string"
      || node.groupRuleId.length === 0
    ) {
      throw new Error(`group 节点记录不完整：${node.id}`);
    }
  }
  return topology.nodeRecords;
}

export function normalizeGroupRule(
  rule: GroupRule,
  groupNodeNameFallback: string,
): GroupRule {
  const normalizedBase = {
    id: rule.id,
    groupNodeName: rule.groupNodeName ?? groupNodeNameFallback ?? rule.id,
    ...(rule.sourceTemplateName
      ? { sourceTemplateName: rule.sourceTemplateName }
      : {}),
    entryRole: rule.entryRole,
    members: rule.members.map((agent) => ({ ...agent })),
    edges: rule.edges.map((edge) => {
      const trigger = normalizeTopologyEdgeTrigger(edge.trigger);
      return {
        ...edge,
        trigger,
        maxTriggerRounds: normalizeMaxTriggerRounds(
          edge.maxTriggerRounds,
        ),
      };
    }),
  } satisfies GroupRuleBase;

  if (rule.report === false) {
    return {
      ...normalizedBase,
      report: false,
    };
  }
  const { templateName, trigger, messageMode, maxTriggerRounds } = rule.report;
  if (!templateName) {
    throw new Error(`group rule ${rule.id} 存在 report target 时，必须显式声明目标模板。`);
  }
  if (!rule.report.sourceRole) {
    throw new Error(`group rule ${rule.id} 存在 report target 时，必须显式声明来源 role。`);
  }
  if (!trigger) {
    throw new Error(`group rule ${rule.id} 存在 report target 时，必须显式声明 report trigger。`);
  }
  const normalizedTrigger = normalizeTopologyEdgeTrigger(trigger);
  return {
    ...normalizedBase,
    report: {
      templateName,
      sourceRole: rule.report.sourceRole,
      trigger: normalizedTrigger,
      messageMode,
      maxTriggerRounds: normalizeMaxTriggerRounds(maxTriggerRounds),
    },
  };
}

export function getGroupRules(topology: TopologyRecord): GroupRule[] {
  const groupNodeNameByRuleId = new Map(
    topology.nodeRecords
      .filter((node) => node.kind === "group")
      .map((node) => [node.groupRuleId, node.id] as const),
  );
  return (topology.groupRules ?? []).map((rule) =>
    normalizeGroupRule(
      rule,
      groupNodeNameByRuleId.get(rule.id) ?? rule.id,
    ),
  );
}

export function createTopologyFlowRecord(input: {
  nodes: string[];
  edges: TopologyEdge[];
  startTargets?: ReadonlyArray<string>;
  endSources?: ReadonlyArray<string>;
  endIncoming?: ReadonlyArray<TopologyFlowEndIncoming>;
}): TopologyFlowRecord {
  const knownNodes = new Set(input.nodes);
  const normalizeRefs = (values: ReadonlyArray<string> | undefined) =>
    (values ?? [])
      .filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      )
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
    .map((value) => {
      return {
        source: value.source.trim(),
        trigger: normalizeTopologyEdgeTrigger(value.trigger),
      };
    })
    .filter((value) => value.source.length > 0)
    .filter((value) => knownNodes.has(value.source))
    .filter(
      (value, index, list) =>
        list.findIndex(
          (item) =>
            item.source === value.source && item.trigger === value.trigger,
        ) === index,
    );
  const endSources = normalizeRefs([
    ...(input.endSources ?? []),
    ...endIncoming.map((item) => item.source),
  ]);

  return {
    start: {
      id: FLOW_START_NODE_ID,
      targets: startTargets,
    },
    end: {
      id: FLOW_END_NODE_ID,
      sources: endSources,
      incoming: endIncoming,
    },
  };
}
