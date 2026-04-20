import {
  getSpawnRules,
  getTopologyNodeRecords,
  type RuntimeTopologyEdge,
  type RuntimeTopologyNode,
  type SpawnBundleInstantiation,
  type SpawnItemPayload,
  type SpawnRule,
  type TopologyRecord,
} from "@shared/types";

function sanitizeInstanceSegment(value: string): string {
  return value.trim().replace(/\s+/g, "-");
}

function buildRuntimeNodeId(role: string, groupId: string): string {
  return `${role}#${groupId}`;
}

function buildRuntimeNodeDisplayName(templateName: string, itemId: string): string {
  const match = itemId.match(/(\d+)(?!.*\d)/u);
  const index = match ? String(Number.parseInt(match[1] ?? "0", 10)) : itemId;
  return `${templateName}-${index}`;
}

export function instantiateSpawnBundle(input: {
  topology: TopologyRecord;
  spawnRuleId: string;
  item: SpawnItemPayload;
}): SpawnBundleInstantiation {
  const rule = getSpawnRules(input.topology).find((candidate) => candidate.id === input.spawnRuleId);
  if (!rule) {
    throw new Error(`spawn rule 不存在：${input.spawnRuleId}`);
  }

  const topologyNodes = getTopologyNodeRecords(input.topology);
  const sourceNode = topologyNodes.find(
    (node) => node.templateName === rule.sourceTemplateName || node.id === rule.sourceTemplateName,
  );
  if (!sourceNode) {
    throw new Error(`spawn rule 缺少 source template：${rule.sourceTemplateName}`);
  }

  const reportNode = topologyNodes.find(
    (node) => node.templateName === rule.reportToTemplateName || node.id === rule.reportToTemplateName,
  );
  if (!reportNode) {
    throw new Error(`spawn rule 缺少 report target template：${rule.reportToTemplateName}`);
  }

  const groupId = `${sanitizeInstanceSegment(rule.id)}:${sanitizeInstanceSegment(input.item.id)}`;
  const nodes: RuntimeTopologyNode[] = rule.spawnedAgents.map((agent) => ({
    id: buildRuntimeNodeId(agent.role, groupId),
    templateName: agent.templateName,
    displayName: buildRuntimeNodeDisplayName(agent.templateName, input.item.id),
    sourceNodeId: sourceNode.id,
    groupId,
    role: agent.role,
  }));

  const edges: RuntimeTopologyEdge[] = rule.edges.map((edge) => {
    const sourceNodeInstance = nodes.find((node) => node.role === edge.sourceRole);
    const targetNodeInstance = nodes.find((node) => node.role === edge.targetRole);
    if (!sourceNodeInstance || !targetNodeInstance) {
      throw new Error(`spawn rule ${rule.id} 的 role 连线不完整：${edge.sourceRole} -> ${edge.targetRole}`);
    }
    return {
      source: sourceNodeInstance.id,
      target: targetNodeInstance.id,
      triggerOn: edge.triggerOn,
    };
  });

  const summaryNode = nodes.find((node) => node.role === "summary");
  if (summaryNode) {
    edges.push({
      source: summaryNode.id,
      target: reportNode.id,
      triggerOn: "review_pass",
    });
  }

  return {
    groupId,
    sourceTemplateName: rule.sourceTemplateName,
    reportToTemplateName: rule.reportToTemplateName,
    item: input.item,
    nodes,
    edges,
  };
}

export function instantiateSpawnBundles(input: {
  topology: TopologyRecord;
  spawnRuleId: string;
  items: SpawnItemPayload[];
}): SpawnBundleInstantiation[] {
  return input.items.map((item) =>
    instantiateSpawnBundle({
      topology: input.topology,
      spawnRuleId: input.spawnRuleId,
      item,
    }),
  );
}

export function validateSpawnRule(topology: TopologyRecord, rule: SpawnRule): void {
  const topologyNodes = getTopologyNodeRecords(topology);
  const knownTemplateNames = new Set(topologyNodes.map((node) => node.templateName));
  if (!knownTemplateNames.has(rule.sourceTemplateName)) {
    throw new Error(`spawn rule source template 不存在：${rule.sourceTemplateName}`);
  }
  if (!knownTemplateNames.has(rule.reportToTemplateName)) {
    throw new Error(`spawn rule report target 不存在：${rule.reportToTemplateName}`);
  }

  const knownRoles = new Set(rule.spawnedAgents.map((agent) => agent.role));
  if (!knownRoles.has(rule.entryRole)) {
    throw new Error(`spawn rule entry role 不存在：${rule.entryRole}`);
  }
  for (const edge of rule.edges) {
    if (!knownRoles.has(edge.sourceRole) || !knownRoles.has(edge.targetRole)) {
      throw new Error(`spawn rule 含有未知 role 连线：${edge.sourceRole} -> ${edge.targetRole}`);
    }
  }
}
