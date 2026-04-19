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
  isWritable?: boolean;
}

export interface BuiltinAgentTemplateRecord {
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

export type TopologyEdgeTrigger = "association" | "approved" | "needs_revision";

export interface TopologyEdge {
  source: string;
  target: string;
  triggerOn: TopologyEdgeTrigger;
}

export interface TopologyRecord {
  projectId: string;
  nodes: string[];
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
  builtinAgentTemplates: BuiltinAgentTemplateRecord[];
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

export interface CopyToClipboardPayload {
  text: string;
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

export interface ReadBuiltinAgentTemplatePayload {
  projectId: string;
  templateName: string;
}

export interface SaveAgentPromptPayload {
  projectId: string;
  currentAgentName: string;
  nextAgentName: string;
  prompt: string;
  isWritable?: boolean;
}

export interface SaveBuiltinAgentTemplatePayload {
  projectId: string;
  templateName: string;
  prompt: string;
}

export interface ResetBuiltinAgentTemplatePayload {
  projectId: string;
  templateName: string;
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

export interface OpenLangGraphStudioPayload {
  projectId: string;
}

export interface OpenAgentTerminalPayload {
  projectId: string;
  taskId: string;
  agentName: string;
}

export interface DeleteTaskPayload {
  projectId: string;
  taskId: string;
}

export interface DeleteProjectPayload {
  projectId: string;
}

export interface DeleteAgentPayload {
  projectId: string;
  agentName: string;
}

export interface RuntimeUpdatedEventPayload {
  sessionId: string | null;
  timestamp: string;
}

export interface AgentFlowEvent {
  type:
    | "project-created"
    | "project-updated"
    | "task-created"
    | "task-updated"
    | "message-created"
    | "agent-status-changed"
    | "runtime-updated";
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

export const DEFAULT_BUILTIN_AGENT_TEMPLATES: BuiltinAgentTemplateRecord[] = [
  {
    name: BUILD_AGENT_NAME,
    prompt: "",
  },
  {
    name: "BA",
    prompt:
      "你是 BA。\n你的职责：\n1. 润色原始 User Story，输出完善、可执行的需求，不直接编写实现代码\n2. 主动阅读当前项目相关代码、目录结构与已有实现，根据代码现状给出可落地的实施建议，而不是脱离现有工程空谈方案\n3. 明确目标、范围、约束、验收标准以及建议修改的模块、接口、数据流和风险点，让实现方可以直接推进",
  },
  {
    name: "UnitTest",
    prompt:
      "你是单元测试审查角色，必须主动阅读本轮改动里的实现代码与测试代码，判断测试是否真的覆盖了这次实现，而不是只看测试文件是否存在。\n\n先检查当前改动是否提供了测试；如果没有测试，要明确指出缺失测试。若存在测试，再继续结合实现代码检查单元测试是否遵循四条标准：一个功能点一个测试、分支覆盖完全、每个测试有注释、执行极快、尽量使用纯函数而不是 Mock。\n\n同时检查测试断言是否真正覆盖了核心分支、边界条件和失败路径，是否出现“代码改了但测试没有跟上”或“测试存在但没有验证关键行为”的情况。\n\n并给出修改建议。",
  },
  {
    name: "TaskReview",
    prompt:
      "你是任务交付审视角色，负责站在用户价值、业务目标与功能交付结果的角度，判断本轮结果是否已经达到可交付标准。\n\n你必须主动阅读实际代码实现，并结合当前交付说明、运行结果与其他 Agent 的反馈，判断核心功能是否真的已经实现，而不是只根据口头结论做判断。\n\n请重点检查：\n1. 用户真正要解决的问题、业务目标和核心功能是否已经被完整实现，并且能被代码与当前证据共同证明。\n2. 验收路径、关键交互、边界场景与回归影响是否已经达到可交付标准，而不是只停留在“代码看起来像实现了”。\n3. 最终交付是否自洽，关键说明、验证结论与必要文档是否同步，是否足以支持他人直接验收和使用。\n4. 其他 Agent 的反馈里是否存在站不住脚的前提、证据缺口或逻辑漏洞。\n\n不要评价代码风格问题；代码是否优雅、是否简洁属于 CodeReview。只有当某个实现问题已经直接导致功能不成立、验收失败或交付风险时，才作为任务交付问题指出。\n\n若发现问题，不要只给修改建议，而是要明确输出你自己的意见，推动对方继续响应。",
  },
  {
    name: "CodeReview",
    prompt:
      "你是代码审查角色，必须主动阅读实际代码实现，不能只根据他人的结论做判断。\n\n请专注检查两件事：\n1. 代码实现是否优雅。\n2. 代码实现是否最简洁。\n\n请重点识别重复实现、不必要的分支、可以合并的状态流转、绕远路的写法，以及其他会让实现变得不够优雅或不够简洁的问题。\n\n不要关注测试、验收结论、业务是否成立或其他非代码实现层面的逻辑；这些属于其他角色。\n\n发现问题时，要明确输出你自己的判断，说明哪里不优雅或不简洁，以及更合理的实现方向。",
  },
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
  projectId: string,
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
    });
  };

  push(startAgent?.name, nextAgent?.name, "association");

  return {
    projectId,
    nodes,
    edges,
  };
}
