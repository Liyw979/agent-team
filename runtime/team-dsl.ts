import {
  type AgentRecord,
  createTopologyLangGraphRecord,
  normalizeNeedsRevisionMaxRounds,
  type TopologyEdge,
  type TopologyEdgeTrigger,
  type TopologyLangGraphRecord,
  type TopologyNodeRecord,
  type TopologyRecord,
  type SpawnRule,
  usesOpenCodeBuiltinPrompt,
} from "@shared/types";

type DownstreamMode = TopologyEdgeTrigger | "spawn";
type DownstreamMap = Record<string, Record<string, DownstreamMode>>;

type SpawnAgentInput =
  | string
  | {
      role: string;
      templateName: string;
    };

type SpawnLinkInput =
  | readonly [string, string, TopologyEdgeTrigger]
  | {
      sourceRole: string;
      targetRole: string;
      triggerOn: TopologyEdgeTrigger;
    };

interface SpawnTemplateInput {
  name?: string;
  itemKey?: string;
  entryRole?: string;
  agents?: SpawnAgentInput[];
  links?: SpawnLinkInput[];
  reportTo?: string;
}

interface CreateTopologyDslInput {
  nodes?: string[];
  downstream: DownstreamMap;
  spawn?: Record<string, SpawnTemplateInput>;
  langgraph?: {
    start?: string | string[];
    end?: string | string[] | null;
  };
}

export interface TeamDslAgentRecord {
  name: string;
  prompt?: string;
  fromTemplate?: string;
  writable?: boolean;
}

export interface TeamDslDefinition {
  agents: TeamDslAgentRecord[];
  topology: CreateTopologyDslInput;
}

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

function normalizeComparableAgents(agents: Array<{
  name: string;
  prompt: string | null | undefined;
  isWritable?: boolean;
}>) {
  return [...agents]
    .map((agent) => ({
      name: agent.name,
      prompt: agent.prompt ?? "",
      isWritable: usesOpenCodeBuiltinPrompt(agent.name) ? true : agent.isWritable === true,
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
        ...(edge.triggerOn === "needs_revision"
          ? {
              maxRevisionRounds: normalizeNeedsRevisionMaxRounds(edge.maxRevisionRounds),
            }
          : {}),
      }))
      .sort((left, right) => {
      const leftKey = `${left.source}__${left.target}__${left.triggerOn}__${left.maxRevisionRounds ?? ""}`;
      const rightKey = `${right.source}__${right.target}__${right.triggerOn}__${right.maxRevisionRounds ?? ""}`;
      return leftKey.localeCompare(rightKey);
      }),
    langgraph: topology.langgraph
      ? normalizeComparableLangGraph(topology.langgraph)
      : undefined,
    nodeRecords: topology.nodeRecords
      ? [...topology.nodeRecords].sort((left, right) => left.id.localeCompare(right.id))
      : undefined,
    spawnRules: topology.spawnRules
      ? [...topology.spawnRules].sort((left, right) => left.id.localeCompare(right.id))
      : undefined,
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

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function collectNodes(input: CreateTopologyDslInput): string[] {
  const nodes = [...(input.nodes ?? [])];
  const spawn = input.spawn ?? {};

  for (const [source, targets] of Object.entries(input.downstream)) {
    pushUnique(nodes, source);
    for (const target of Object.keys(targets)) {
      pushUnique(nodes, target);
    }
  }

  for (const [target, config] of Object.entries(spawn)) {
    pushUnique(nodes, target);
    if (config.reportTo) {
      pushUnique(nodes, config.reportTo);
    }
    for (const agent of config.agents ?? []) {
      pushUnique(nodes, typeof agent === "string" ? agent : agent.templateName);
    }
  }

  return nodes;
}

function buildEdges(input: CreateTopologyDslInput): TopologyEdge[] {
  const edges: TopologyEdge[] = [];

  for (const [source, targets] of Object.entries(input.downstream)) {
    for (const [target, mode] of Object.entries(targets)) {
      edges.push({
        source,
        target,
        triggerOn: mode === "spawn" ? "association" : mode,
      });
    }
  }

  return edges;
}

function normalizeBoundaryTargets(value: string | string[] | null | undefined): string[] | null {
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value;
  }
  return typeof value === "string" ? [value] : undefined;
}

function buildNodeRecords(
  nodes: string[],
  input: CreateTopologyDslInput,
  compiledAgents?: CompiledTeamDslAgent[],
): TopologyNodeRecord[] {
  const spawnTargets = new Set<string>();
  const compiledAgentByName = new Map((compiledAgents ?? []).map((agent) => [agent.name, agent]));

  for (const targets of Object.values(input.downstream)) {
    for (const [target, mode] of Object.entries(targets)) {
      if (mode === "spawn") {
        spawnTargets.add(target);
      }
    }
  }

  return nodes.map((node) => {
    if (!spawnTargets.has(node)) {
      const compiledAgent = compiledAgentByName.get(node);
      return {
        id: node,
        kind: "agent" as const,
        templateName: node,
        ...(compiledAgent
          ? {
              ...(compiledAgent.prompt !== null
                ? {
                    prompt: compiledAgent.prompt,
                  }
                : {}),
              ...(compiledAgent.isWritable
                ? {
                    writable: true,
                  }
                : {}),
            }
          : {}),
      };
    }

    return {
      id: node,
      kind: "spawn" as const,
      templateName: node,
      spawnEnabled: true,
      spawnRuleId: `spawn-rule:${node}`,
    };
  });
}

function findSpawnSource(downstream: DownstreamMap, targetNodeId: string): string {
  const matches: string[] = [];

  for (const [source, targets] of Object.entries(downstream)) {
    if (targets[targetNodeId] === "spawn") {
      matches.push(source);
    }
  }

  if (matches.length !== 1) {
    throw new Error(`DSL 要求 spawn 节点 ${targetNodeId} 只能有且仅有一个上游来源。`);
  }

  return matches[0]!;
}

function normalizeSpawnedAgents(
  targetNodeId: string,
  config: SpawnTemplateInput | undefined,
): SpawnRule["spawnedAgents"] {
  const entryRole = config?.entryRole ?? "entry";
  const rawAgents = config?.agents ?? [targetNodeId];

  return rawAgents.map((agent, index) => {
    if (typeof agent !== "string") {
      return {
        role: agent.role,
        templateName: agent.templateName,
      };
    }

    return {
      role: index === 0 ? entryRole : agent,
      templateName: agent,
    };
  });
}

function normalizeSpawnLinks(config: SpawnTemplateInput | undefined): SpawnRule["edges"] {
  return (config?.links ?? []).map((link) => {
    if (Array.isArray(link)) {
      const [sourceRole, targetRole, triggerOn] = link;
      return {
        sourceRole,
        targetRole,
        triggerOn,
      };
    }

    return {
      sourceRole: link.sourceRole,
      targetRole: link.targetRole,
      triggerOn: link.triggerOn,
    };
  });
}

function buildSpawnRules(input: CreateTopologyDslInput): SpawnRule[] {
  const spawnTargets: string[] = [];

  for (const targets of Object.values(input.downstream)) {
    for (const [target, mode] of Object.entries(targets)) {
      if (mode === "spawn") {
        spawnTargets.push(target);
      }
    }
  }

  return spawnTargets.map((target) => {
    const config = input.spawn?.[target];
    const sourceTemplateName = findSpawnSource(input.downstream, target);

    return {
      id: `spawn-rule:${target}`,
      name: config?.name ?? target,
      sourceTemplateName,
      itemKey: config?.itemKey ?? "spawn_items",
      entryRole: config?.entryRole ?? "entry",
      spawnedAgents: normalizeSpawnedAgents(target, config),
      edges: normalizeSpawnLinks(config),
      exitWhen: "one_side_agrees",
      reportToTemplateName: config?.reportTo ?? sourceTemplateName,
    };
  });
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

  const templateName = agent.fromTemplate?.trim() || (isBuiltinTemplateName(name) ? name : null);
  const prompt = agent.prompt?.trim();
  if (!templateName && !prompt) {
    throw new Error(`DSL Agent ${name} 不是内置模板，必须提供 prompt。`);
  }

  if (usesOpenCodeBuiltinPrompt(name) && prompt) {
    throw new Error("Build 使用 OpenCode 内置 prompt，DSL 中不允许覆盖 prompt。");
  }

  return {
    name,
    prompt: prompt || null,
    templateName,
    isWritable: agent.writable === true,
  };
}

function normalizeCompiledWritableAgents(agents: CompiledTeamDslAgent[]): CompiledTeamDslAgent[] {
  return agents.map((agent) => ({
    ...agent,
    isWritable: usesOpenCodeBuiltinPrompt(agent.name) || agent.isWritable === true,
  }));
}

function assertTopologyAgentsDeclared(
  compiledAgents: CompiledTeamDslAgent[],
  topology: TopologyRecord,
): void {
  const known = new Set(compiledAgents.map((agent) => agent.name));
  const allNodes = new Set<string>([
    ...topology.nodes,
    ...(topology.langgraph?.start.targets ?? []),
    ...(topology.langgraph?.end?.sources ?? []),
    ...(topology.nodeRecords?.map((node) => node.id) ?? []),
    ...(topology.spawnRules?.flatMap((rule) => [
      rule.sourceTemplateName,
      rule.reportToTemplateName,
      ...rule.spawnedAgents.map((agent) => agent.templateName),
    ]) ?? []),
  ]);

  for (const nodeName of allNodes) {
    if (!known.has(nodeName)) {
      throw new Error(`DSL topology 引用了未声明的 Agent：${nodeName}`);
    }
  }
}

export function createTopology(input: CreateTopologyDslInput): TopologyRecord {
  const nodes = collectNodes(input);
  const edges = buildEdges(input);

  return {
    nodes,
    edges,
    langgraph: createTopologyLangGraphRecord({
      nodes,
      edges,
      startTargets: normalizeBoundaryTargets(input.langgraph?.start) ?? undefined,
      endSources: normalizeBoundaryTargets(input.langgraph?.end),
    }),
    nodeRecords: buildNodeRecords(nodes, input),
    spawnRules: buildSpawnRules(input),
  };
}

export function compileTeamDsl(input: TeamDslDefinition): CompiledTeamDsl {
  const agents = normalizeCompiledWritableAgents(input.agents.map((agent) => compileAgentDefinition(agent)));
  const createInput = {
    ...input.topology,
    nodes: [
      ...(input.topology.nodes ?? []),
      ...agents.map((agent) => agent.name),
    ].filter((value, index, list) => list.indexOf(value) === index),
  };
  const topology = {
    ...createTopology(createInput),
    nodeRecords: buildNodeRecords(collectNodes(createInput), createInput, agents),
  };
  assertTopologyAgentsDeclared(agents, topology);

  return {
    agents,
    topology,
  };
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
