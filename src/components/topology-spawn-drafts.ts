import type { SpawnRule, TopologyNodeRecord, TopologyRecord } from "@shared/types";

interface DebateSpawnDraftInput {
  teamName: string;
  sourceTemplateName: string;
  proTemplateName: string;
  conTemplateName: string;
  summaryTemplateName: string;
  reportToTemplateName: string;
}

function sanitizeRuleId(value: string): string {
  const normalized = value.trim().replace(/\s+/g, "-");
  return normalized.length > 0 ? normalized : "dynamic-team";
}

function buildSpawnRuleId(teamName: string): string {
  return `spawn-rule:${sanitizeRuleId(teamName)}`;
}

function ensureNodeRecord(records: TopologyNodeRecord[], node: TopologyNodeRecord): TopologyNodeRecord[] {
  const existingIndex = records.findIndex((item) => item.id === node.id);
  if (existingIndex < 0) {
    return [...records, node];
  }
  const next = [...records];
  next[existingIndex] = node;
  return next;
}

function getFallbackNodeRecords(topology: TopologyRecord): TopologyNodeRecord[] {
  if (topology.nodeRecords && topology.nodeRecords.length > 0) {
    return topology.nodeRecords.map((node) => ({ ...node }));
  }

  return topology.nodes.map((name) => ({
    id: name,
    kind: "agent" as const,
    templateName: name,
  }));
}

export function getTopologyDisplayNodeIds(
  topology: Pick<TopologyRecord, "nodes" | "nodeRecords" | "spawnRules">,
  candidateNodeIds: string[],
): string[] {
  if (topology.nodeRecords && topology.nodeRecords.length > 0) {
    const visibleNodeIds = new Set(
      topology.nodeRecords
        .filter((node) => node.kind !== "spawn")
        .map((node) => node.id),
    );

    const orderedVisibleNodeIds = topology.nodes.length > 0
      ? topology.nodes.filter((nodeId) => visibleNodeIds.has(nodeId))
      : topology.nodeRecords
        .map((node) => node.id)
        .filter((nodeId) => visibleNodeIds.has(nodeId));

    const spawnAgentTemplateNames = new Set(
      topology.spawnRules?.flatMap((rule) => rule.spawnedAgents.map((agent) => agent.templateName)) ?? [],
    );
    if (spawnAgentTemplateNames.size === 0) {
      return orderedVisibleNodeIds;
    }

    const staticNodeIds = new Set(orderedVisibleNodeIds);
    const runtimeNodeIdsByTemplate = new Map<string, string[]>();
    const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const resolveRuntimeNodeIndex = (templateName: string, runtimeNodeId: string) => {
      const match = new RegExp(`^${escapeRegExp(templateName)}-(\\d+)$`).exec(runtimeNodeId);
      return match ? Number.parseInt(match[1] ?? "0", 10) : Number.MAX_SAFE_INTEGER;
    };

    for (const templateName of spawnAgentTemplateNames) {
      const runtimeNodeIds = candidateNodeIds
        .filter((nodeId) => !staticNodeIds.has(nodeId))
        .filter((nodeId) => new RegExp(`^${escapeRegExp(templateName)}-(\\d+)$`).test(nodeId))
        .sort((left, right) =>
          resolveRuntimeNodeIndex(templateName, left) - resolveRuntimeNodeIndex(templateName, right));
      if (runtimeNodeIds.length > 0) {
        runtimeNodeIdsByTemplate.set(templateName, runtimeNodeIds);
      }
    }

    if (topology.nodes.length > 0) {
      return orderedVisibleNodeIds.flatMap((nodeId) => runtimeNodeIdsByTemplate.get(nodeId) ?? [nodeId]);
    }

    return orderedVisibleNodeIds.flatMap((nodeId) => runtimeNodeIdsByTemplate.get(nodeId) ?? [nodeId]);
  }
  return topology.nodes.length > 0 ? topology.nodes : candidateNodeIds;
}

export function upsertDebateSpawnDraft(
  topology: TopologyRecord,
  input: DebateSpawnDraftInput,
): TopologyRecord {
  const teamName = input.teamName.trim();
  if (!teamName) {
    throw new Error("动态团队名称不能为空。");
  }

  const spawnRuleId = buildSpawnRuleId(teamName);
  const spawnNodeId = teamName;
  let nodeRecords = getFallbackNodeRecords(topology);
  for (const templateName of [
    input.sourceTemplateName,
    input.proTemplateName,
    input.conTemplateName,
    input.summaryTemplateName,
    input.reportToTemplateName,
  ]) {
    if (!nodeRecords.some((node) => node.id === templateName)) {
      nodeRecords.push({
        id: templateName,
        kind: "agent",
        templateName,
      });
    }
  }
  nodeRecords = ensureNodeRecord(nodeRecords, {
    id: spawnNodeId,
    kind: "spawn",
    templateName: input.proTemplateName,
    spawnRuleId,
  });

  const nodeIds = topology.nodes.length > 0 ? [...topology.nodes] : nodeRecords
    .filter((node) => node.kind === "agent")
    .map((node) => node.id);
  for (const templateName of [
    input.sourceTemplateName,
    input.proTemplateName,
    input.conTemplateName,
    input.summaryTemplateName,
    input.reportToTemplateName,
  ]) {
    if (!nodeIds.includes(templateName)) {
      nodeIds.push(templateName);
    }
  }

  const spawnRule: SpawnRule = {
    id: spawnRuleId,
    name: teamName,
    sourceTemplateName: input.sourceTemplateName,
    itemKey: "findings",
    entryRole: "pro",
    spawnedAgents: [
      { role: "pro", templateName: input.proTemplateName },
      { role: "con", templateName: input.conTemplateName },
      { role: "summary", templateName: input.summaryTemplateName },
    ],
    edges: [
      { sourceRole: "pro", targetRole: "con", triggerOn: "review_fail" },
      { sourceRole: "con", targetRole: "pro", triggerOn: "review_fail" },
      { sourceRole: "pro", targetRole: "summary", triggerOn: "review_pass" },
      { sourceRole: "con", targetRole: "summary", triggerOn: "review_pass" },
    ],
    exitWhen: "one_side_agrees",
    reportToTemplateName: input.reportToTemplateName,
  };

  const nextEdges = topology.edges.filter(
    (edge) => !(edge.source === input.sourceTemplateName && edge.target === spawnNodeId),
  ).concat({
    source: input.sourceTemplateName,
    target: spawnNodeId,
    triggerOn: "association" as const,
  });

  const nextSpawnRules = (topology.spawnRules ?? []).filter((rule) => rule.id !== spawnRuleId).concat(spawnRule);

  return {
    ...topology,
    nodes: nodeIds,
    edges: nextEdges,
    nodeRecords,
    spawnRules: nextSpawnRules,
  };
}
