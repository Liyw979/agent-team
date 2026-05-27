import {
  collectTopologyTriggerShapes,
  isDefaultTopologyTrigger,
  FLOW_END_NODE_ID,
  type AgentRecord,
  createTopologyFlowRecord,
  normalizeMaxTriggerRounds,
  normalizeInitialMessageAgentIds,
  normalizeTopologyEdgeTrigger,
  parseInitialMessageRoutingFromDslInput,
  type TopologyEdge,
  type TopologyEdgeMessageMode,
  type TopologyFlowRecord,
  type TopologyNodeRecord,
  type TopologyRecord,
  type GroupRule,
  usesOpenCodeBuiltinPrompt,
} from "@shared/types";
import { z } from "zod";

const ROOT_SCOPE_ID = "__root__";

interface TeamDslAgentRecord {
  id: string;
  prompt: string;
  writable: boolean;
  initialMessageRouting: TopologyNodeRecord["initialMessageRouting"];
}

interface GraphDslAgentNode {
  type: "agent";
  id: string;
  system_prompt: string;
  writable: boolean;
  initialMessage?: string | string[] | undefined;
}

interface GraphDslGroupNode {
  type: "group";
  id: string;
  nodes: GraphDslNode[];
}

type GraphDslNode = GraphDslAgentNode | GraphDslGroupNode;

interface GraphDslLink {
  from: string;
  to: string;
  trigger: string;
  message_type: TopologyEdgeMessageMode;
  maxTriggerRounds: number;
}

export interface GraphDslGraph {
  entry: string;
  nodes: GraphDslNode[];
  links: GraphDslLink[];
}

export type TeamDslDefinition = GraphDslGraph;

export interface CompiledTeamDslAgent {
  id: string;
  prompt: string;
  templateName: string;
  isWritable: boolean;
}

export interface CompiledTeamDsl {
  agents: CompiledTeamDslAgent[];
  topology: TopologyRecord;
}

interface FlatAgentNode {
  kind: "agent";
  id: string;
  ancestors: string[];
  systemPrompt: string;
  writable: boolean;
  initialMessageRouting: TopologyNodeRecord["initialMessageRouting"];
}

interface FlatGroupNode {
  kind: "group";
  id: string;
  ancestors: string[];
  childIds: string[];
}

type FlatNode = FlatAgentNode | FlatGroupNode;

interface FlatGraph {
  nodesInOrder: FlatNode[];
  agentsInOrder: FlatAgentNode[];
  groupsInOrder: FlatGroupNode[];
  nodeById: Record<string, FlatNode>;
}

const GraphDslLinkSchema = z.object({
  from: z.string(),
  to: z.string(),
  trigger: z.string(),
  message_type: z.enum(["none", "last"]),
  maxTriggerRounds: z.number().int().refine(
    (value) => value === -1 || value >= 1,
    "maxTriggerRounds 必须是 -1 或大于等于 1 的整数",
  ),
}).strict().superRefine((value, ctx) => {
  try {
    normalizeTopologyEdgeTrigger(value.trigger);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["trigger"],
      message: error instanceof Error ? error.message : "非法 trigger。",
    });
  }
});

const GraphDslAgentNodeSchema = z.object({
  type: z.literal("agent"),
  id: z.string(),
  system_prompt: z.string(),
  writable: z.boolean(),
  initialMessage: z.union([z.string(), z.array(z.string())]).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.initialMessage === undefined) {
    return;
  }
  try {
    normalizeInitialMessageAgentIds(value.initialMessage);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["initialMessage"],
      message: error instanceof Error ? error.message : "非法 initialMessage。",
    });
  }
});

const GraphDslNodeSchema: z.ZodType<GraphDslNode> = z.lazy(() =>
  z.union([
    GraphDslAgentNodeSchema,
    z.object({
      type: z.literal("group"),
      id: z.string(),
      nodes: z.array(GraphDslNodeSchema),
    }).strict(),
  ]),
);

const GraphDslGraphSchema = z.object({
  entry: z.string(),
  nodes: z.array(GraphDslNodeSchema),
  links: z.array(GraphDslLinkSchema),
}).strict() as z.ZodType<GraphDslGraph>;

function sortInitialMessageRoutingByAgentDefinitionOrder(
  routing: TopologyNodeRecord["initialMessageRouting"],
  agentDefinitionOrderById: Readonly<Record<string, number>>,
): TopologyNodeRecord["initialMessageRouting"] {
  if (routing.mode !== "list") {
    return routing;
  }
  return {
    mode: "list",
    agentIds: [...routing.agentIds].sort((left, right) => {
      const leftOrder = agentDefinitionOrderById[left];
      const rightOrder = agentDefinitionOrderById[right];
      if (leftOrder === undefined || rightOrder === undefined) {
        throw new Error(`initialMessage 顺序重排失败：${leftOrder === undefined ? left : right}`);
      }
      return leftOrder - rightOrder;
    }),
  };
}

function normalizeComparableAgents(agents: Array<{
  id: string;
  prompt: string;
  isWritable?: boolean;
}>) {
  return [...agents]
    .map((agent) => ({
      id: agent.id,
      prompt: agent.prompt,
      isWritable: agent.isWritable === true,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeComparableTopology(topology: TopologyRecord): TopologyRecord {
  return {
    nodes: [...topology.nodes],
    edges: topology.edges
      .map((edge) => ({
        source: edge.source,
        target: edge.target,
        trigger: edge.trigger,
        messageMode: edge.messageMode,
        maxTriggerRounds: normalizeMaxTriggerRounds(edge.maxTriggerRounds),
      }))
      .sort((left, right) => {
        const leftKey = `${left.source}__${left.target}__${left.trigger}__${left.messageMode}__${String(left.maxTriggerRounds)}`;
        const rightKey = `${right.source}__${right.target}__${right.trigger}__${right.messageMode}__${String(right.maxTriggerRounds)}`;
        return leftKey.localeCompare(rightKey);
      }),
    flow: normalizeComparableFlow(topology.flow),
    nodeRecords: [...topology.nodeRecords].sort((left, right) => left.id.localeCompare(right.id)),
    ...(topology.groupRules
      ? {
          groupRules: [...topology.groupRules].sort((left, right) => left.id.localeCompare(right.id)),
        }
      : {}),
  };
}

function normalizeComparableFlow(flow: TopologyFlowRecord): TopologyFlowRecord {
  return {
    start: {
      id: flow.start.id,
      targets: [...flow.start.targets].sort((left, right) => left.localeCompare(right)),
    },
    end: {
      id: flow.end.id,
      sources: [...flow.end.sources].sort((left, right) => left.localeCompare(right)),
      incoming: [...flow.end.incoming].sort((left, right) => {
        const leftKey = `${left.source}__${left.trigger}`;
        const rightKey = `${right.source}__${right.trigger}`;
        return leftKey.localeCompare(rightKey);
      }),
    },
  };
}

export function matchesAppliedTeamDslAgents(
  currentAgents: AgentRecord[],
  compiled: CompiledTeamDsl,
): boolean {
  return JSON.stringify(normalizeComparableAgents(currentAgents))
    === JSON.stringify(normalizeComparableAgents(
      compiled.agents.map((agent) => ({
        id: agent.id,
        prompt: agent.prompt,
        isWritable: agent.isWritable,
      })),
    ));
}

export function matchesAppliedTeamDslTopology(
  currentTopology: TopologyRecord,
  compiled: CompiledTeamDsl,
): boolean {
  return JSON.stringify(normalizeComparableTopology(currentTopology))
    === JSON.stringify(normalizeComparableTopology(compiled.topology));
}

function formatZodIssuePath(path: (string | number)[]): string {
  if (path.length === 0) {
    return "团队拓扑 DSL";
  }
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === "number") {
      return `${acc}[${segment}]`;
    }
    return acc ? `${acc}.${segment}` : segment;
  }, "");
}

function translateZodExpectedType(expected: string): string {
  switch (expected) {
    case "string":
      return "字符串";
    case "array":
      return "数组";
    case "object":
      return "对象";
    case "boolean":
      return "布尔值";
    default:
      return expected;
  }
}

function isRootGraphShapeIssue(issue: z.ZodIssue): boolean {
  if (issue.path.length === 0) {
    return true;
  }
  if (issue.path.length !== 1) {
    return false;
  }
  const [head] = issue.path;
  return head === "entry" || head === "nodes" || head === "links";
}

function formatGraphDslParseError(error: z.ZodError): string {
  if (error.issues.some((issue) => isRootGraphShapeIssue(issue))) {
    return "团队拓扑 YAML 只支持递归式 entry + nodes + links DSL。";
  }

  const issue = error.issues[0];
  if (!issue) {
    return "团队拓扑 YAML 校验失败。";
  }
  const path = formatZodIssuePath(issue.path);
  if (
    issue.path.at(-1) === "type"
    && (
      issue.code === z.ZodIssueCode.invalid_union_discriminator
      || issue.message === "Invalid input"
    )
  ) {
    return `${path} 是节点判别字段，只允许 agent 或 group。`;
  }
  if (issue.code === z.ZodIssueCode.invalid_enum_value) {
    return `${path} 只允许 ${issue.options.join(" / ")}。`;
  }
  if (
    issue.code === z.ZodIssueCode.invalid_type
    && issue.path[0] === "links"
    && issue.expected === "object"
  ) {
    return `${formatZodIssuePath(issue.path)} 必须使用对象格式，并显式写出 from、to、trigger、message_type。`;
  }
  if (issue.code === z.ZodIssueCode.unrecognized_keys && issue.path[0] === "links") {
    return `${formatZodIssuePath(issue.path)} 只允许显式写出 from、to、trigger、message_type、maxTriggerRounds。`;
  }
  if (issue.code === z.ZodIssueCode.invalid_type) {
    if (issue.received === "undefined") {
      return `${path} 必须显式写出，不能省略。`;
    }
    return `${path} 类型错误，期望 ${translateZodExpectedType(issue.expected)}。`;
  }
  return `${path} 校验失败：${issue.message}`;
}

function parseGraphDsl(input: unknown): GraphDslGraph {
  const parsed = GraphDslGraphSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(formatGraphDslParseError(parsed.error));
  }
  return parsed.data;
}

function createFlatGraph(graph: GraphDslGraph): FlatGraph {
  const nodeById: Record<string, FlatNode> = {};
  const nodesInOrder: FlatNode[] = [];
  const agentsInOrder: FlatAgentNode[] = [];
  const groupsInOrder: FlatGroupNode[] = [];

  function visitScope(
    nodes: GraphDslNode[],
    ancestors: string[],
    inheritedVisibleAgentIds: string[],
  ): void {
    const localAgentIds = nodes
      .filter((node): node is GraphDslAgentNode => node.type === "agent")
      .map((node) => node.id);
    const visibleAgentIds = [...new Set([...inheritedVisibleAgentIds, ...localAgentIds])];

    for (const node of nodes) {
      if (nodeById[node.id]) {
        throw new Error(`DSL 节点名必须全局唯一：${node.id}`);
      }
      if (node.type === "agent") {
        const initialMessageRouting = parseInitialMessageRoutingFromDslInput(node.initialMessage);
        if (initialMessageRouting.mode === "list") {
          for (const agentId of initialMessageRouting.agentIds) {
            if (!visibleAgentIds.includes(agentId)) {
              throw new Error(`DSL Agent ${node.id} 的 initialMessage 引用了不存在的来源 Agent：${agentId}`);
            }
          }
        }
        const flatNode: FlatAgentNode = {
          kind: "agent",
          id: node.id,
          ancestors,
          systemPrompt: node.system_prompt,
          writable: node.writable,
          initialMessageRouting,
        };
        nodeById[node.id] = flatNode;
        nodesInOrder.push(flatNode);
        agentsInOrder.push(flatNode);
        continue;
      }

      const flatGroup: FlatGroupNode = {
        kind: "group",
        id: node.id,
        ancestors,
        childIds: node.nodes.map((child) => child.id),
      };
      nodeById[node.id] = flatGroup;
      nodesInOrder.push(flatGroup);
      groupsInOrder.push(flatGroup);
      visitScope(node.nodes, [...ancestors, node.id], visibleAgentIds);
    }
  }

  visitScope(graph.nodes, [], []);
  return {
    nodesInOrder,
    agentsInOrder,
    groupsInOrder,
    nodeById,
  };
}

function isNodeInsideGroup(flat: FlatGraph, groupId: string, nodeId: string): boolean {
  const node = flat.nodeById[nodeId];
  if (!node) {
    throw new Error(`未知节点：${nodeId}`);
  }
  return node.ancestors.includes(groupId);
}

function resolveRoleWithinScope(flat: FlatGraph, scopeId: string, nodeId: string): string {
  const node = flat.nodeById[nodeId];
  if (!node) {
    throw new Error(`未知节点：${nodeId}`);
  }
  if (scopeId === ROOT_SCOPE_ID) {
    return node.ancestors[0] ?? node.id;
  }
  const scopeIndex = node.ancestors.indexOf(scopeId);
  if (scopeIndex < 0) {
    throw new Error(`节点 ${nodeId} 不在 group ${scopeId} 内。`);
  }
  return node.ancestors[scopeIndex + 1] ?? node.id;
}

function resolveParentScopeId(node: FlatNode): string {
  return node.ancestors[node.ancestors.length - 1] ?? ROOT_SCOPE_ID;
}

function mapGraphDslLinkToTopologyEdge(link: GraphDslLink): TopologyEdge {
  const trigger = normalizeTopologyEdgeTrigger(link.trigger);
  return {
    source: link.from,
    target: link.to,
    trigger,
    messageMode: link.message_type,
    maxTriggerRounds: normalizeMaxTriggerRounds(link.maxTriggerRounds),
  };
}

function dedupeTopologyEdges(edges: TopologyEdge[]): TopologyEdge[] {
  const seen = new Set<string>();
  const deduped: TopologyEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.source}__${edge.target}__${edge.trigger}__${edge.messageMode}__${String(edge.maxTriggerRounds)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(edge);
  }
  return deduped;
}

function collectScopeEdges(
  graph: GraphDslGraph,
  flat: FlatGraph,
  scopeId: string,
): TopologyEdge[] {
  return dedupeTopologyEdges(
    graph.links.flatMap((link) => {
      if (link.to === FLOW_END_NODE_ID) {
        return [];
      }
      const sourceInScope = scopeId === ROOT_SCOPE_ID || isNodeInsideGroup(flat, scopeId, link.from);
      const targetInScope = scopeId === ROOT_SCOPE_ID || isNodeInsideGroup(flat, scopeId, link.to);
      if (!sourceInScope || !targetInScope) {
        return [];
      }
      const sourceRole = resolveRoleWithinScope(flat, scopeId, link.from);
      const targetRole = resolveRoleWithinScope(flat, scopeId, link.to);
      if (
        scopeId !== ROOT_SCOPE_ID
        && targetRole === link.to
        && resolveParentScopeId(flat.nodeById[link.to]!) !== scopeId
      ) {
        return [];
      }
      if (sourceRole === targetRole) {
        return [];
      }
      const mapped = mapGraphDslLinkToTopologyEdge(link);
      return [{
        source: sourceRole,
        target: targetRole,
        trigger: mapped.trigger,
        messageMode: mapped.messageMode,
        maxTriggerRounds: mapped.maxTriggerRounds,
      }];
    }),
  );
}

function collectRootEndLinks(graph: GraphDslGraph): GraphDslLink[] {
  return graph.links
    .filter((link) => link.to === FLOW_END_NODE_ID)
    .filter((value, index, list) =>
      list.findIndex((item) =>
        item.from === value.from
        && normalizeTopologyEdgeTrigger(item.trigger) === normalizeTopologyEdgeTrigger(value.trigger)
        && item.message_type === value.message_type,
      ) === index);
}

function assertLinkEndpoints(graph: GraphDslGraph, flat: FlatGraph): void {
  const entryNode = flat.nodeById[graph.entry];
  if (!entryNode) {
    throw new Error(`entry 指向了不存在的节点：${graph.entry}`);
  }
  if (entryNode.kind !== "agent") {
    throw new Error(`entry 必须指向可执行 agent，不能直接指向 group：${graph.entry}`);
  }

  for (const [index, link] of graph.links.entries()) {
    const sourceNode = flat.nodeById[link.from];
    if (!sourceNode) {
      throw new Error(`links[${index}] 引用了不存在的节点：${link.from} -> ${link.to}`);
    }
    if (sourceNode.kind !== "agent") {
      throw new Error(`links[${index}].from 必须指向 agent，不能直接指向 group：${link.from}`);
    }
    if (link.to === FLOW_END_NODE_ID) {
      if (sourceNode.ancestors.length > 0) {
        throw new Error(`group 内 agent 不能直接连接 __end__：${link.from} -> ${link.to}`);
      }
      continue;
    }
    const targetNode = flat.nodeById[link.to];
    if (!targetNode) {
      throw new Error(`links[${index}] 引用了不存在的节点：${link.from} -> ${link.to}`);
    }
    if (targetNode.kind !== "agent") {
      throw new Error(`links[${index}].to 必须指向 agent，不能直接指向 group：${link.to}`);
    }
  }
}

function assertAgentPromptsDeclareOutgoingTriggers(graph: GraphDslGraph, flat: FlatGraph): void {
  const triggerSetBySource: Record<string, Set<string>> = {};
  for (const link of graph.links) {
    const sourceNode = flat.nodeById[link.from];
    if (!sourceNode || sourceNode.kind !== "agent") {
      continue;
    }
    const trigger = normalizeTopologyEdgeTrigger(link.trigger);
    if (isDefaultTopologyTrigger(trigger)) {
      continue;
    }
    triggerSetBySource[link.from] ??= new Set<string>();
    triggerSetBySource[link.from]!.add(trigger);
  }

  for (const sourceId of Object.keys(triggerSetBySource)) {
    const sourceNode = flat.nodeById[sourceId];
    if (!sourceNode || sourceNode.kind !== "agent") {
      continue;
    }
    const missingTriggers = [...triggerSetBySource[sourceId]!].filter((trigger) =>
      !sourceNode.systemPrompt.includes(trigger),
    );
    if (missingTriggers.length > 0) {
      throw new Error(`DSL Agent ${sourceId} 的 system_prompt 必须显式包含以下 trigger：${missingTriggers.join("、")}`);
    }
  }
}

function compileAgentDefinition(agent: TeamDslAgentRecord): CompiledTeamDslAgent {
  const name = agent.id.trim();
  if (!name) {
    throw new Error("DSL Agent 名称不能为空。");
  }
  const prompt = agent.prompt.trim();
  if (!usesOpenCodeBuiltinPrompt(name) && !prompt) {
    throw new Error(`DSL Agent ${name} 不是内置模板，必须提供 system_prompt。`);
  }
  if (usesOpenCodeBuiltinPrompt(name) && prompt) {
    throw new Error(`${name} 使用 OpenCode 内置 prompt，DSL 中不允许覆盖 system_prompt。`);
  }
  return {
    id: name,
    prompt,
    templateName: name,
    isWritable: agent.writable === true,
  };
}

function collectGroupRule(
  graph: GraphDslGraph,
  flat: FlatGraph,
  groupNode: FlatGroupNode,
): GroupRule {
  const groupId = groupNode.id;
  const parentScopeId = resolveParentScopeId(groupNode);
  const incomingLinks = graph.links.filter((link) =>
    link.to !== FLOW_END_NODE_ID
    && isNodeInsideGroup(flat, groupId, link.to)
    && !isNodeInsideGroup(flat, groupId, link.from),
  );
  const entryRoleCandidates = new Set(
    incomingLinks.map((link) => resolveRoleWithinScope(flat, groupId, link.to)),
  );
  if (isNodeInsideGroup(flat, groupId, graph.entry)) {
    entryRoleCandidates.add(resolveRoleWithinScope(flat, groupId, graph.entry));
  }
  if (entryRoleCandidates.size === 0) {
    throw new Error(`group ${groupId} 缺少入口角色；请让 entry 或某条 link 指向组内 agent。`);
  }
  if (entryRoleCandidates.size > 1) {
    throw new Error(`group ${groupId} 存在多个入口角色：${[...entryRoleCandidates].join("、")}`);
  }
  const entryRole = [...entryRoleCandidates][0]!;

  const sourceTemplateCandidates = [...new Set(
    incomingLinks.map((link) => resolveRoleWithinScope(flat, parentScopeId, link.from)),
  )];
  if (sourceTemplateCandidates.length > 1) {
    throw new Error(`group ${groupId} 存在多个外部来源：${sourceTemplateCandidates.join("、")}`);
  }

  const outgoingEdges = dedupeTopologyEdges(
    graph.links.flatMap((link) => {
      if (
        link.to === FLOW_END_NODE_ID
        || !isNodeInsideGroup(flat, groupId, link.from)
        || isNodeInsideGroup(flat, groupId, link.to)
      ) {
        return [];
      }
      const mapped = mapGraphDslLinkToTopologyEdge(link);
      return [{
        source: resolveRoleWithinScope(flat, groupId, link.from),
        target: resolveRoleWithinScope(flat, parentScopeId, link.to),
        trigger: mapped.trigger,
        messageMode: mapped.messageMode,
        maxTriggerRounds: mapped.maxTriggerRounds,
      }];
    }),
  );
  if (outgoingEdges.length > 1) {
    throw new Error(`group ${groupId} 最多只能声明一条回到外层的出口。`);
  }

  const onlyOutgoingEdge = outgoingEdges[0];
  const baseRule = {
    id: `group-rule:${groupId}`,
    groupNodeName: groupId,
    ...(sourceTemplateCandidates[0] ? { sourceTemplateName: sourceTemplateCandidates[0] } : {}),
    entryRole,
    members: groupNode.childIds.map((childId) => ({
      role: childId,
      templateName: childId,
    })),
    edges: collectScopeEdges(graph, flat, groupId).map((edge) => ({
      sourceRole: edge.source,
      targetRole: edge.target,
      trigger: edge.trigger,
      messageMode: edge.messageMode,
      maxTriggerRounds: edge.maxTriggerRounds,
    })),
  } satisfies Omit<GroupRule, "report">;
  if (!onlyOutgoingEdge) {
    return {
      ...baseRule,
      report: false,
    } satisfies GroupRule;
  }
  return {
    ...baseRule,
    report: {
      templateName: onlyOutgoingEdge.target,
      sourceRole: onlyOutgoingEdge.source,
      trigger: onlyOutgoingEdge.trigger,
      messageMode: onlyOutgoingEdge.messageMode,
      maxTriggerRounds: onlyOutgoingEdge.maxTriggerRounds,
    },
  } satisfies GroupRule;
}

function assertTopologyAgentsDeclared(
  compiledAgents: CompiledTeamDslAgent[],
  topology: TopologyRecord,
): void {
  const known = new Set([
    ...compiledAgents.map((agent) => agent.id),
    ...topology.nodeRecords.filter((node) => node.kind === "group").map((node) => node.id),
  ]);
  const allNodes = new Set<string>([
    ...topology.nodes,
    ...topology.flow.start.targets,
    ...topology.flow.end.sources,
    ...topology.nodeRecords.map((node) => node.id),
    ...(topology.groupRules?.flatMap((rule) => [
      rule.groupNodeName,
      rule.sourceTemplateName,
      ...((rule.report !== false) ? [rule.report.templateName] : []),
      ...rule.members.map((agent) => agent.templateName),
    ].filter((value): value is string => typeof value === "string" && value.length > 0)) ?? []),
  ]);
  for (const nodeName of allNodes) {
    if (!known.has(nodeName)) {
      throw new Error(`DSL topology 引用了未声明的 Agent：${nodeName}`);
    }
  }
}

function compileGraphDsl(graph: GraphDslGraph): CompiledTeamDsl {
  const flat = createFlatGraph(graph);
  assertLinkEndpoints(graph, flat);
  assertAgentPromptsDeclareOutgoingTriggers(graph, flat);

  const agentDefinitionOrderById = Object.fromEntries(
    flat.agentsInOrder.map((agent, index) => [agent.id, index]),
  ) as Record<string, number>;

  const compiledAgents = flat.agentsInOrder.map((agent) =>
    compileAgentDefinition({
      id: agent.id,
      prompt: agent.systemPrompt,
      writable: agent.writable,
      initialMessageRouting: agent.initialMessageRouting,
    }),
  );
  const compiledAgentById = Object.fromEntries(compiledAgents.map((agent) => [agent.id, agent])) as Record<string, CompiledTeamDslAgent>;

  const nodeRecords: TopologyNodeRecord[] = flat.nodesInOrder.map((node) => {
    if (node.kind === "group") {
      return {
        id: node.id,
        kind: "group",
        templateName: node.id,
        initialMessageRouting: { mode: "inherit" },
        groupRuleId: `group-rule:${node.id}`,
      };
    }
    const compiledAgent = compiledAgentById[node.id];
    if (!compiledAgent) {
      throw new Error(`缺少已编译 Agent：${node.id}`);
    }
    return {
      id: node.id,
      kind: "agent",
      templateName: node.id,
      prompt: compiledAgent.prompt,
      initialMessageRouting: sortInitialMessageRoutingByAgentDefinitionOrder(
        node.initialMessageRouting,
        agentDefinitionOrderById,
      ),
      writable: compiledAgent.isWritable,
    };
  });

  const topologyEdges = collectScopeEdges(graph, flat, ROOT_SCOPE_ID);
  const endLinks = collectRootEndLinks(graph);
  const startTarget = resolveRoleWithinScope(flat, ROOT_SCOPE_ID, graph.entry);
  const topology: TopologyRecord = {
    nodes: graph.nodes.map((node) => node.id),
    edges: topologyEdges,
    flow: createTopologyFlowRecord({
      nodes: graph.nodes.map((node) => node.id),
      edges: topologyEdges,
      startTargets: [startTarget],
      endIncoming: endLinks.map((link) => ({
        source: link.from,
        trigger: normalizeTopologyEdgeTrigger(link.trigger),
      })),
    }),
    nodeRecords,
    groupRules: flat.groupsInOrder.map((groupNode) => collectGroupRule(graph, flat, groupNode)),
  };

  assertTopologyAgentsDeclared(compiledAgents, topology);
  collectTopologyTriggerShapes({
    edges: topology.edges,
    endIncoming: topology.flow.end.incoming,
  });

  return {
    agents: compiledAgents,
    topology,
  };
}

export function compileTeamDsl(input: unknown): CompiledTeamDsl {
  return compileGraphDsl(parseGraphDsl(input));
}

export function matchesAppliedTeamDsl(
  currentAgents: AgentRecord[],
  currentTopology: TopologyRecord,
  compiled: CompiledTeamDsl,
): boolean {
  if (!matchesAppliedTeamDslAgents(currentAgents, compiled)) {
    return false;
  }
  return matchesAppliedTeamDslTopology(currentTopology, compiled);
}
