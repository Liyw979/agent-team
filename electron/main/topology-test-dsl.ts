import type {
  SpawnRule,
  SpawnedAgentTemplate,
  TopologyEdge,
  TopologyEdgeTrigger,
  TopologyNodeRecord,
  TopologyRecord,
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
  projectId: string;
  nodes?: string[];
  downstream: DownstreamMap;
  spawn?: Record<string, SpawnTemplateInput>;
}

interface CreateTopologyLegacyInput {
  projectId: string;
  nodes: string[];
  edges: TopologyRecord["edges"];
  nodeRecords?: TopologyRecord["nodeRecords"];
  spawnRules?: TopologyRecord["spawnRules"];
}

function isLegacyInput(
  input: CreateTopologyDslInput | CreateTopologyLegacyInput,
): input is CreateTopologyLegacyInput {
  return "edges" in input;
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

function buildNodeRecords(
  nodes: string[],
  input: CreateTopologyDslInput,
): TopologyNodeRecord[] {
  const spawnTargets = new Set<string>();

  for (const targets of Object.values(input.downstream)) {
    for (const [target, mode] of Object.entries(targets)) {
      if (mode === "spawn") {
        spawnTargets.add(target);
      }
    }
  }

  return nodes.map((node) => {
    if (!spawnTargets.has(node)) {
      return {
        id: node,
        kind: "agent" as const,
        templateName: node,
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

function findSpawnSource(
  downstream: DownstreamMap,
  targetNodeId: string,
): string {
  const matches: string[] = [];

  for (const [source, targets] of Object.entries(downstream)) {
    if (targets[targetNodeId] === "spawn") {
      matches.push(source);
    }
  }

  if (matches.length !== 1) {
    throw new Error(`测试 DSL 要求 spawn 节点 ${targetNodeId} 只能有且仅有一个上游来源。`);
  }

  return matches[0]!;
}

function normalizeSpawnedAgents(
  targetNodeId: string,
  config: SpawnTemplateInput | undefined,
): SpawnedAgentTemplate[] {
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

export function createTopology(input: CreateTopologyLegacyInput): TopologyRecord;
export function createTopology(input: CreateTopologyDslInput): TopologyRecord;
export function createTopology(
  input: CreateTopologyDslInput | CreateTopologyLegacyInput,
): TopologyRecord {
  if (isLegacyInput(input)) {
    return {
      projectId: input.projectId,
      nodes: [...input.nodes],
      edges: input.edges.map((edge) => ({ ...edge })),
      nodeRecords: input.nodeRecords?.map((node) => ({ ...node })),
      spawnRules: input.spawnRules?.map((rule) => ({
        ...rule,
        spawnedAgents: rule.spawnedAgents.map((agent) => ({ ...agent })),
        edges: rule.edges.map((edge) => ({ ...edge })),
      })),
    };
  }

  const nodes = collectNodes(input);

  return {
    projectId: input.projectId,
    nodes,
    edges: buildEdges(input),
    nodeRecords: buildNodeRecords(nodes, input),
    spawnRules: buildSpawnRules(input),
  };
}
