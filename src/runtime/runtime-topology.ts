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

function resolveRuntimeNodeIndex(itemId: string, explicitIndex?: number): number | string {
  if (typeof explicitIndex === "number" && Number.isInteger(explicitIndex) && explicitIndex > 0) {
    return explicitIndex;
  }
  const match = itemId.match(/(\d+)(?!.*\d)/u);
  if (match) {
    return Number.parseInt(match[1] ?? "0", 10);
  }
  return 1;
}

function buildRuntimeNodeId(templateName: string, itemId: string, explicitIndex?: number): string {
  return `${templateName}-${resolveRuntimeNodeIndex(itemId, explicitIndex)}`;
}

function resolveSpawnRuleTerminalRoles(rule: SpawnRule): string[] {
  const outgoingRoles = new Set(rule.edges.map((edge) => edge.sourceRole));
  return rule.spawnedAgents
    .map((agent) => agent.role)
    .filter((role) => !outgoingRoles.has(role));
}

export function instantiateSpawnBundle(input: {
  topology: TopologyRecord;
  spawnRuleId: string;
  activationId: string;
  item: SpawnItemPayload;
  instanceIndex?: number;
}): SpawnBundleInstantiation {
  const rule = getSpawnRules(input.topology).find((candidate) => candidate.id === input.spawnRuleId);
  if (!rule) {
    throw new Error(`spawn rule 不存在：${input.spawnRuleId}`);
  }

  const topologyNodes = getTopologyNodeRecords(input.topology);
  const effectiveSpawnNodeName = rule.spawnNodeName
    || topologyNodes.find((node) => node.spawnRuleId === rule.id)?.id
    || "";
  const spawnNode = topologyNodes.find((node) =>
    node.id === effectiveSpawnNodeName || node.templateName === effectiveSpawnNodeName,
  );
  if (!spawnNode) {
    throw new Error(`spawn rule 缺少 spawn 节点：${effectiveSpawnNodeName || rule.id}`);
  }
  const sourceLookupName = rule.sourceTemplateName ?? spawnNode.id;
  const sourceNode = topologyNodes.find((node) =>
    node.id === sourceLookupName || node.templateName === sourceLookupName,
  );
  if (!sourceNode) {
    throw new Error(`spawn rule 缺少 source template：${sourceLookupName}`);
  }

  const groupId = `${sanitizeInstanceSegment(rule.id)}:${sanitizeInstanceSegment(input.item.id)}`;
  const nodes: RuntimeTopologyNode[] = rule.spawnedAgents.map((agent) => {
    const templateNode = topologyNodes.find(
      (node) => node.id === agent.templateName || node.templateName === agent.templateName,
    );
    return {
      id: buildRuntimeNodeId(agent.templateName, input.item.id, input.instanceIndex),
      kind: templateNode?.kind ?? "agent",
      templateName: agent.templateName,
      displayName: buildRuntimeNodeId(agent.templateName, input.item.id, input.instanceIndex),
      sourceNodeId: sourceNode.id,
      groupId,
      role: agent.role,
      ...(templateNode?.spawnRuleId ? { spawnRuleId: templateNode.spawnRuleId } : {}),
    };
  });

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
      messageMode: edge.messageMode,
      ...(edge.triggerOn === "continue" && typeof edge.maxRevisionRounds === "number"
        ? { maxRevisionRounds: edge.maxRevisionRounds }
        : {}),
    };
  });

  const sourceToSpawnEdge = input.topology.edges.find((edge) =>
    edge.source === sourceNode.id
    && edge.target === spawnNode.id,
  );
  const entryNode = nodes.find((node) => node.role === rule.entryRole);
  if (sourceToSpawnEdge && entryNode) {
    edges.unshift({
      source: sourceNode.id,
      target: entryNode.id,
      triggerOn: sourceToSpawnEdge.triggerOn,
      messageMode: sourceToSpawnEdge.messageMode,
      ...(sourceToSpawnEdge.triggerOn === "continue" && typeof sourceToSpawnEdge.maxRevisionRounds === "number"
        ? { maxRevisionRounds: sourceToSpawnEdge.maxRevisionRounds }
        : {}),
    });
  }

  const reportNode = rule.reportToTemplateName
    ? topologyNodes.find(
        (node) => node.templateName === rule.reportToTemplateName || node.id === rule.reportToTemplateName,
      )
    : null;
  if (rule.reportToTemplateName && !reportNode) {
    throw new Error(`spawn rule 缺少 report target template：${rule.reportToTemplateName}`);
  }

  const terminalRoles = resolveSpawnRuleTerminalRoles(rule);
  const reportSourceNode = terminalRoles.length === 1
    ? nodes.find((node) => node.role === terminalRoles[0])
    : undefined;
  if (reportSourceNode && reportNode) {
    edges.push({
      source: reportSourceNode.id,
      target: reportNode.id,
      triggerOn: rule.reportToTriggerOn ?? "complete",
      messageMode: "last",
    });
  }

  return {
    groupId,
    activationId: input.activationId,
    spawnNodeName: effectiveSpawnNodeName,
    item: input.item,
    nodes,
    edges,
    ...(rule.sourceTemplateName ? { sourceTemplateName: rule.sourceTemplateName } : {}),
    ...(rule.reportToTemplateName ? { reportToTemplateName: rule.reportToTemplateName } : {}),
  };
}

export function instantiateSpawnBundles(input: {
  topology: TopologyRecord;
  spawnRuleId: string;
  activationId: string;
  items: SpawnItemPayload[];
}): SpawnBundleInstantiation[] {
  const useExplicitIndex = input.items.length > 1;
  return input.items.map((item, index) =>
    instantiateSpawnBundle({
      topology: input.topology,
      spawnRuleId: input.spawnRuleId,
      activationId: input.activationId,
      item,
      ...(useExplicitIndex ? { instanceIndex: index + 1 } : {}),
    }),
  );
}

export function validateSpawnRule(topology: TopologyRecord, rule: SpawnRule): void {
  const topologyNodes = getTopologyNodeRecords(topology);
  const knownTemplateNames = new Set(topologyNodes.map((node) => node.templateName));
  const knownNodeIds = new Set(topologyNodes.map((node) => node.id));
  const effectiveSpawnNodeName = rule.spawnNodeName
    || topologyNodes.find((node) => node.spawnRuleId === rule.id)?.id
    || "";
  if (!knownNodeIds.has(effectiveSpawnNodeName) && !knownTemplateNames.has(effectiveSpawnNodeName)) {
    throw new Error(`spawn rule 对应的 spawn 节点不存在：${effectiveSpawnNodeName || rule.id}`);
  }
  if (rule.reportToTemplateName && !knownTemplateNames.has(rule.reportToTemplateName) && !knownNodeIds.has(rule.reportToTemplateName)) {
    throw new Error(`spawn rule report target 不存在：${rule.reportToTemplateName}`);
  }
  const knownRoles = new Set(rule.spawnedAgents.map((agent) => agent.role));
  if (!knownRoles.has(rule.entryRole)) {
    throw new Error(`spawn rule entry role 不存在：${rule.entryRole}`);
  }
  if (rule.reportToTemplateName && resolveSpawnRuleTerminalRoles(rule).length !== 1) {
    throw new Error(`spawn rule ${rule.id} 存在 report target 时，子图必须有且仅有一个终局 role。`);
  }
  for (const edge of rule.edges) {
    if (!knownRoles.has(edge.sourceRole) || !knownRoles.has(edge.targetRole)) {
      throw new Error(`spawn rule 含有未知 role 连线：${edge.sourceRole} -> ${edge.targetRole}`);
    }
  }
}
