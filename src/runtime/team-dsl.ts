import {
  type AgentRecord,
  createTopologyLangGraphRecord,
  normalizeNeedsRevisionMaxRounds,
  type TopologyEdgeMessageMode,
  type TopologyEdgeTrigger,
  type TopologyLangGraphRecord,
  type TopologyNodeRecord,
  type TopologyRecord,
  type SpawnRule,
  usesOpenCodeBuiltinPrompt,
} from "@shared/types";
import { z } from "zod";

export interface TeamDslAgentRecord {
  name: string;
  prompt: string;
  writable: boolean;
}

interface GraphDslAgentNode {
  type: "agent";
  name: string;
  prompt: string;
  writable: boolean;
}

interface GraphDslSpawnNode {
  type: "spawn";
  name: string;
  graph: GraphDslGraph;
}

type GraphDslNode = GraphDslAgentNode | GraphDslSpawnNode;

interface GraphDslLink {
  from: string;
  to: string;
  trigger_type: TopologyEdgeTrigger;
  message_type: TopologyEdgeMessageMode;
}

export interface GraphDslGraph {
  entry: string;
  nodes: GraphDslNode[];
  links: GraphDslLink[];
}

export type TeamDslDefinition = GraphDslGraph;

export interface CompiledTeamDslAgent {
  name: string;
  prompt: string | null;
  templateName: string | null;
  isWritable: boolean;
}

export interface CompiledTeamDsl {
  agents: CompiledTeamDslAgent[];
  topology: TopologyRecord;
}

const GraphDslLinkSchema: z.ZodType<GraphDslLink> = z.object({
  from: z.string(),
  to: z.string(),
  trigger_type: z.enum(["association", "approved", "needs_revision"]),
  message_type: z.enum(["none", "last", "all"]),
}).strict();

const GraphDslAgentNodeSchema: z.ZodType<GraphDslAgentNode> = z.object({
  type: z.literal("agent"),
  name: z.string(),
  prompt: z.string(),
  writable: z.boolean(),
}).strict();

const GraphDslNodeSchema: z.ZodType<GraphDslNode> = z.lazy(() =>
  z.union([
    GraphDslAgentNodeSchema,
    z.object({
      type: z.literal("spawn"),
      name: z.string(),
      graph: GraphDslGraphSchema,
    }).strict(),
  ]),
);

const GraphDslGraphSchema: z.ZodType<GraphDslGraph> = z.lazy(() =>
  z.object({
    entry: z.string(),
    nodes: z.array(GraphDslNodeSchema),
    links: z.array(GraphDslLinkSchema),
  }).strict(),
);

function normalizeComparableAgents(agents: Array<{
  name: string;
  prompt: string | null | undefined;
  isWritable?: boolean;
}>) {
  return [...agents]
    .map((agent) => ({
      name: agent.name,
      prompt: agent.prompt ?? "",
      isWritable: agent.isWritable === true,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeComparableTopology(topology: TopologyRecord): TopologyRecord {
  return {
    nodes: [...topology.nodes],
    edges: topology.edges
      .map((edge) => ({
        source: edge.source,
        target: edge.target,
        triggerOn: edge.triggerOn,
        messageMode: edge.messageMode,
        ...(edge.triggerOn === "needs_revision"
          ? {
              maxRevisionRounds: normalizeNeedsRevisionMaxRounds(edge.maxRevisionRounds),
            }
          : {}),
      }))
      .sort((left, right) => {
        const leftKey = `${left.source}__${left.target}__${left.triggerOn}__${left.messageMode ?? ""}__${left.maxRevisionRounds ?? ""}`;
        const rightKey = `${right.source}__${right.target}__${right.triggerOn}__${right.messageMode ?? ""}__${right.maxRevisionRounds ?? ""}`;
        return leftKey.localeCompare(rightKey);
      }),
    ...(topology.langgraph
      ? { langgraph: normalizeComparableLangGraph(topology.langgraph) }
      : {}),
    ...(topology.nodeRecords
      ? {
          nodeRecords: [...topology.nodeRecords].sort((left, right) => left.id.localeCompare(right.id)),
        }
      : {}),
    ...(topology.spawnRules
      ? {
          spawnRules: [...topology.spawnRules].sort((left, right) => left.id.localeCompare(right.id)),
        }
      : {}),
  };
}

function normalizeComparableLangGraph(langgraph: TopologyLangGraphRecord): TopologyLangGraphRecord {
  return {
    start: {
      id: langgraph.start.id,
      targets: [...langgraph.start.targets].sort((left, right) => left.localeCompare(right)),
    },
    end: langgraph.end
      ? {
          id: langgraph.end.id,
          sources: [...langgraph.end.sources].sort((left, right) => left.localeCompare(right)),
        }
      : null,
  };
}

export function matchesAppliedTeamDslAgents(
  currentAgents: AgentRecord[],
  compiled: CompiledTeamDsl,
): boolean {
  const comparableCurrentAgents = normalizeComparableAgents(currentAgents);
  const comparableCompiledAgents = normalizeComparableAgents(
    compiled.agents.map((agent) => ({
      name: agent.name,
      prompt: agent.prompt,
      isWritable: agent.isWritable,
    })),
  );

  return JSON.stringify(comparableCurrentAgents) === JSON.stringify(comparableCompiledAgents);
}

export function matchesAppliedTeamDslTopology(
  currentTopology: TopologyRecord,
  compiled: CompiledTeamDsl,
): boolean {
  const comparableCurrentTopology = normalizeComparableTopology(currentTopology);
  const comparableCompiledTopology = normalizeComparableTopology(compiled.topology);

  return JSON.stringify(comparableCurrentTopology) === JSON.stringify(comparableCompiledTopology);
}

function isBuiltinTemplateName(name: string): boolean {
  return usesOpenCodeBuiltinPrompt(name);
}

function compileAgentDefinition(agent: TeamDslAgentRecord): CompiledTeamDslAgent {
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
    throw new Error("DSL agent 定义必须使用对象格式，例如 { name: \"Build\" }。");
  }

  const name = agent.name.trim();
  if (!name) {
    throw new Error("DSL Agent 名称不能为空。");
  }

  const templateName = isBuiltinTemplateName(name) ? name : null;
  const prompt = agent.prompt.trim();
  if (!templateName && !prompt) {
    throw new Error(`DSL Agent ${name} 不是内置模板，必须提供 prompt。`);
  }

  if (usesOpenCodeBuiltinPrompt(name) && prompt) {
    throw new Error(`${name} 使用 OpenCode 内置 prompt，DSL 中不允许覆盖 prompt。`);
  }

  return {
    name,
    prompt: prompt || null,
    templateName: templateName || null,
    isWritable: agent.writable,
  };
}

function normalizeCompiledWritableAgents(agents: CompiledTeamDslAgent[]): CompiledTeamDslAgent[] {
  return agents.map((agent) => ({
    ...agent,
    isWritable: agent.isWritable === true,
  }));
}

function assertTopologyAgentsDeclared(
  compiledAgents: CompiledTeamDslAgent[],
  topology: TopologyRecord,
): void {
  const known = new Set([
    ...compiledAgents.map((agent) => agent.name),
    ...(topology.nodeRecords?.filter((node) => node.kind === "spawn").map((node) => node.id) ?? []),
  ]);
  const allNodes = new Set<string>([
    ...topology.nodes,
    ...(topology.langgraph?.start.targets ?? []),
    ...(topology.langgraph?.end?.sources ?? []),
    ...(topology.nodeRecords?.map((node) => node.id) ?? []),
    ...(topology.spawnRules?.flatMap((rule) => [
      rule.spawnNodeName,
      rule.sourceTemplateName,
      rule.reportToTemplateName,
      ...rule.spawnedAgents.map((agent) => agent.templateName),
    ].filter((value): value is string => typeof value === "string" && value.length > 0)) ?? []),
  ]);

  for (const nodeName of allNodes) {
    if (!known.has(nodeName)) {
      throw new Error(`DSL topology 引用了未声明的 Agent：${nodeName}`);
    }
  }
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
    return "团队拓扑 JSON 只支持递归式 entry + nodes + links DSL。";
  }

  const issue = error.issues[0];
  if (!issue) {
    return "团队拓扑 JSON 校验失败。";
  }
  const path = formatZodIssuePath(issue.path);
  if (
    issue.path.at(-1) === "type"
    && (
      issue.code === z.ZodIssueCode.invalid_union_discriminator
      || issue.message === "Invalid input"
    )
  ) {
    return `${path} 是节点判别字段，只允许 agent 或 spawn。`;
  }
  if (issue.code === z.ZodIssueCode.invalid_enum_value) {
    return `${path} 只允许 ${issue.options.join(" / ")}。`;
  }
  if (
    issue.code === z.ZodIssueCode.invalid_type
    && issue.path[0] === "links"
    && issue.expected === "object"
  ) {
    return `${formatZodIssuePath(issue.path)} 必须使用对象格式，并显式写出 from、to、trigger_type、message_type。`;
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

function resolveSpawnReportTo(
  graph: GraphDslGraph,
  spawnNodeName: string,
): { target: string; triggerOn: TopologyEdgeTrigger } | undefined {
  const outgoingLinks = graph.links.filter((link) => link.from === spawnNodeName);
  return outgoingLinks.length === 1
    ? {
        target: outgoingLinks[0]!.to,
        triggerOn: outgoingLinks[0]!.trigger_type,
      }
    : undefined;
}

function resolveSpawnSourceTemplateName(
  graph: GraphDslGraph,
  spawnNodeName: string,
): string | undefined {
  const incomingLinks = graph.links.filter((link) => link.to === spawnNodeName);
  return incomingLinks.length === 1 ? incomingLinks[0]!.from : undefined;
}

function collectGraphDslNodeDefinitions(
  graph: GraphDslGraph,
  context: {
    agentDefinitions: Map<string, TeamDslAgentRecord>;
    nodeRecords: Map<string, TopologyNodeRecord>;
    spawnRules: Map<string, SpawnRule>;
  },
): void {
  const localNames = new Set<string>();
  for (const node of graph.nodes) {
    if (localNames.has(node.name)) {
      throw new Error(`同一层 graph 中存在重复节点名：${node.name}`);
    }
    localNames.add(node.name);
  }
  if (!localNames.has(graph.entry)) {
    throw new Error(`graph.entry 指向了不存在的节点：${graph.entry}`);
  }
  for (const link of graph.links) {
    if (!localNames.has(link.from) || !localNames.has(link.to)) {
      throw new Error(`graph.links 引用了不存在的节点：${link.from} -> ${link.to}`);
    }
  }

  for (const node of graph.nodes) {
    if (context.nodeRecords.has(node.name)) {
      throw new Error(`DSL 节点名必须全局唯一：${node.name}`);
    }

    if (node.type === "agent") {
      context.agentDefinitions.set(node.name, {
        name: node.name,
        prompt: node.prompt,
        writable: node.writable,
      });
      context.nodeRecords.set(node.name, {
        id: node.name,
        kind: "agent",
        templateName: node.name,
      });
      continue;
    }

    const spawnRuleId = `spawn-rule:${node.name}`;
    const reportTarget = resolveSpawnReportTo(graph, node.name);
    const sourceTemplateName = resolveSpawnSourceTemplateName(graph, node.name);
    context.nodeRecords.set(node.name, {
      id: node.name,
      kind: "spawn",
      templateName: node.name,
      spawnEnabled: true,
      spawnRuleId,
    });
    context.spawnRules.set(spawnRuleId, {
      id: spawnRuleId,
      name: node.name,
      spawnNodeName: node.name,
      ...(sourceTemplateName ? { sourceTemplateName } : {}),
      entryRole: node.graph.entry,
      spawnedAgents: node.graph.nodes.map((childNode) => ({
        role: childNode.name,
        templateName: childNode.name,
      })),
      edges: node.graph.links.map((link) => ({
        sourceRole: link.from,
        targetRole: link.to,
        triggerOn: link.trigger_type,
        messageMode: link.message_type,
      })),
      exitWhen: "all_completed",
      ...(reportTarget?.target ? { reportToTemplateName: reportTarget.target } : {}),
      ...(reportTarget?.triggerOn ? { reportToTriggerOn: reportTarget.triggerOn } : {}),
    });
    collectGraphDslNodeDefinitions(node.graph, context);
  }
}

function compileGraphDsl(input: GraphDslGraph): CompiledTeamDsl {
  const agentDefinitions = new Map<string, TeamDslAgentRecord>();
  const nodeRecords = new Map<string, TopologyNodeRecord>();
  const spawnRules = new Map<string, SpawnRule>();
  collectGraphDslNodeDefinitions(input, {
    agentDefinitions,
    nodeRecords,
    spawnRules,
  });

  const compiledAgents = normalizeCompiledWritableAgents(
    [...agentDefinitions.values()].map((agent) => compileAgentDefinition(agent)),
  );
  const compiledAgentsByName = new Map(compiledAgents.map((agent) => [agent.name, agent]));
  const compiledNodeRecords = [...nodeRecords.values()].map((node) => {
    if (node.kind !== "agent") {
      return { ...node };
    }
    const compiledAgent = compiledAgentsByName.get(node.id);
    return {
      ...node,
      ...(compiledAgent?.prompt !== null && compiledAgent?.prompt !== undefined
        ? { prompt: compiledAgent.prompt }
        : {}),
      ...(compiledAgent?.isWritable === true ? { writable: true } : {}),
    };
  });

  const topology: TopologyRecord = {
    nodes: input.nodes.map((node) => node.name),
    edges: input.links.map((link) => ({
      source: link.from,
      target: link.to,
      triggerOn: link.trigger_type,
      messageMode: link.message_type,
    })),
    langgraph: createTopologyLangGraphRecord({
      nodes: input.nodes.map((node) => node.name),
      edges: input.links.map((link) => ({
        source: link.from,
        target: link.to,
        triggerOn: link.trigger_type,
        messageMode: link.message_type,
      })),
      startTargets: [input.entry],
      endSources: null,
    }),
    nodeRecords: compiledNodeRecords,
    spawnRules: [...spawnRules.values()],
  };
  assertTopologyAgentsDeclared(compiledAgents, topology);

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

export function toAgentRecord(agent: CompiledTeamDslAgent): AgentRecord {
  return {
    name: agent.name,
    prompt: agent.prompt ?? "",
    isWritable: agent.isWritable,
  };
}
