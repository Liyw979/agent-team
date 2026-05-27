import {
  getTopologyNodeRecords,
  type RuntimeTopologyEdge,
  type GroupBundleRuntimeNode,
  type GroupBundleInstantiation,
  type GroupItemPayload,
  type GroupRule,
  type TopologyRecord,
} from "@shared/types";

type ReportEdgeConfig =
  | {
      kind: "topology_edge";
      edge: TopologyRecord["edges"][number];
    }
  | {
      kind: "rule_report";
      report: Exclude<GroupRule["report"], false>;
    };

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

export function instantiateGroupBundle(input: {
  topology: TopologyRecord;
  groupRuleId: string;
  activationId: string;
  item: GroupItemPayload;
  instanceIndex?: number;
  sourceRuntimeNodeId?: string;
  sourceRuntimeTemplateName?: string;
  reportRuntimeNodeId?: string;
}): GroupBundleInstantiation {
  const rule = input.topology.groupRules?.find((candidate) => candidate.id === input.groupRuleId);
  if (!rule) {
    throw new Error(`group rule 不存在：${input.groupRuleId}`);
  }

  const topologyNodes = getTopologyNodeRecords(input.topology);
  const effectiveGroupNodeName = rule.groupNodeName
    || topologyNodes.find((node) => node.kind === "group" && node.groupRuleId === rule.id)?.id
    || "";
  const groupNode = (
    input.sourceRuntimeNodeId
      ? topologyNodes.find((node) =>
        node.kind === "group"
        && node.groupRuleId === rule.id
        && input.topology.edges.some((edge) =>
          edge.source === input.sourceRuntimeNodeId
          && edge.target === node.id,
        ))
      : undefined
  ) ?? topologyNodes.find((node) =>
    node.id === effectiveGroupNodeName || node.templateName === effectiveGroupNodeName,
  );
  if (!groupNode) {
    throw new Error(`group rule 缺少 group 节点：${effectiveGroupNodeName || rule.id}`);
  }
  const sourceLookupName = input.sourceRuntimeNodeId ?? rule.sourceTemplateName ?? groupNode.id;
  const sourceNode = (
    input.sourceRuntimeNodeId
      ? topologyNodes.find((node) => node.id === input.sourceRuntimeNodeId)
      : undefined
  ) ?? topologyNodes.find((node) =>
    node.id === sourceLookupName
    || node.templateName === sourceLookupName
    || (
      input.sourceRuntimeTemplateName
      && node.id === input.sourceRuntimeTemplateName
      && node.templateName === input.sourceRuntimeTemplateName
    ),
  );
  if (!sourceNode) {
    throw new Error(`group rule 缺少 source template：${sourceLookupName}`);
  }

  const groupId = `${sanitizeInstanceSegment(rule.id)}:${sanitizeInstanceSegment(input.item.id)}`;
  const effectiveSourceNodeId = input.sourceRuntimeNodeId ?? sourceNode.id;
  const nodes: GroupBundleRuntimeNode[] = rule.members.map((agent) => {
    const templateNode = topologyNodes.find(
      (node) => node.id === agent.templateName || node.templateName === agent.templateName,
    );
    const sharedNode = {
      id: buildRuntimeNodeId(agent.templateName, input.item.id, input.instanceIndex),
      templateName: agent.templateName,
      displayName: buildRuntimeNodeId(agent.templateName, input.item.id, input.instanceIndex),
      sourceNodeId: effectiveSourceNodeId,
      groupId,
      role: agent.role,
    };
    if (templateNode?.kind === "group") {
      if (!templateNode.groupRuleId) {
        throw new Error(`group template 缺少 groupRuleId：${agent.templateName}`);
      }
      return {
        ...sharedNode,
        kind: "group",
        groupRuleId: templateNode.groupRuleId,
      };
    }
    return {
      ...sharedNode,
      kind: "agent",
    };
  });

  const edges: RuntimeTopologyEdge[] = rule.edges.map((edge) => {
    const sourceNodeInstance = nodes.find((node) => node.role === edge.sourceRole);
    const targetNodeInstance = nodes.find((node) => node.role === edge.targetRole);
    if (!sourceNodeInstance || !targetNodeInstance) {
      throw new Error(`group rule ${rule.id} 的 role 连线不完整：${edge.sourceRole} -> ${edge.targetRole}`);
    }
    return {
      source: sourceNodeInstance.id,
      target: targetNodeInstance.id,
      trigger: edge.trigger,
      messageMode: edge.messageMode,
      maxTriggerRounds: edge.maxTriggerRounds,
    };
  });

  const sourceToGroupEdge = input.topology.edges.find((edge) =>
    edge.source === sourceNode.id
    && edge.target === groupNode.id,
  ) ?? (
    input.sourceRuntimeTemplateName
      ? input.topology.edges.find((edge) =>
        edge.source === input.sourceRuntimeTemplateName
        && edge.target === groupNode.id)
      : undefined
  );
  const entryNode = nodes.find((node) => node.role === rule.entryRole);
  if (sourceToGroupEdge && entryNode) {
    edges.unshift({
      source: effectiveSourceNodeId,
      target: entryNode.id,
      trigger: sourceToGroupEdge.trigger,
      messageMode: sourceToGroupEdge.messageMode,
      maxTriggerRounds: sourceToGroupEdge.maxTriggerRounds,
    });
  }

  const reportNode = rule.report !== false
    ? (
      (input.reportRuntimeNodeId
        ? topologyNodes.find((node) => node.id === input.reportRuntimeNodeId)
        : undefined)
      ?? topologyNodes.find(
        (node) => node.templateName === rule.report.templateName || node.id === rule.report.templateName,
      )
    )
    : null;
  if (rule.report !== false && !reportNode) {
    throw new Error(`group rule 缺少 report target template：${rule.report.templateName}`);
  }

  const reportSourceNode = rule.report !== false
    ? nodes.find((node) => node.role === rule.report.sourceRole)
    : undefined;
  const groupToReportEdge = reportNode
    ? input.topology.edges.find((edge) =>
      edge.source === groupNode.id
      && edge.target === reportNode.id)
    : undefined;
  if (reportSourceNode && reportNode && rule.report !== false) {
    const reportEdgeConfig: ReportEdgeConfig = groupToReportEdge
      ? { kind: "topology_edge", edge: groupToReportEdge }
      : { kind: "rule_report", report: rule.report };
    edges.push({
      source: reportSourceNode.id,
      target: reportNode.id,
      trigger: resolveReportEdgeTrigger(reportEdgeConfig),
      messageMode: resolveReportEdgeMessageMode(reportEdgeConfig),
      maxTriggerRounds: resolveReportEdgeMaxTriggerRounds(reportEdgeConfig),
    });
  }

  return {
    groupId,
    activationId: input.activationId,
    groupNodeName: effectiveGroupNodeName,
    item: input.item,
    nodes,
    edges,
  };
}

function resolveReportEdgeTrigger(config: ReportEdgeConfig): string {
  return config.kind === "topology_edge" ? config.edge.trigger : config.report.trigger;
}

function resolveReportEdgeMessageMode(config: ReportEdgeConfig): RuntimeTopologyEdge["messageMode"] {
  return config.kind === "topology_edge" ? config.edge.messageMode : config.report.messageMode;
}

function resolveReportEdgeMaxTriggerRounds(config: ReportEdgeConfig): number {
  return config.kind === "topology_edge" ? config.edge.maxTriggerRounds : config.report.maxTriggerRounds;
}

export function instantiateGroupBundles(input: {
  topology: TopologyRecord;
  groupRuleId: string;
  activationId: string;
  items: GroupItemPayload[];
  sourceRuntimeNodeId?: string;
  sourceRuntimeTemplateName?: string;
  reportRuntimeNodeId?: string;
}): GroupBundleInstantiation[] {
  const useExplicitIndex = input.items.length > 1;
  return input.items.map((item, index) =>
    instantiateGroupBundle({
      topology: input.topology,
      groupRuleId: input.groupRuleId,
      activationId: input.activationId,
      item,
      ...(input.sourceRuntimeNodeId ? { sourceRuntimeNodeId: input.sourceRuntimeNodeId } : {}),
      ...(input.sourceRuntimeTemplateName ? { sourceRuntimeTemplateName: input.sourceRuntimeTemplateName } : {}),
      ...(input.reportRuntimeNodeId ? { reportRuntimeNodeId: input.reportRuntimeNodeId } : {}),
      ...(useExplicitIndex ? { instanceIndex: index + 1 } : {}),
    }),
  );
}

export function validateGroupRule(topology: TopologyRecord, rule: GroupRule): void {
  const topologyNodes = getTopologyNodeRecords(topology);
  const knownTemplateNames = new Set(topologyNodes.map((node) => node.templateName));
  const knownNodeIds = new Set(topologyNodes.map((node) => node.id));
  const effectiveGroupNodeName = rule.groupNodeName
    || topologyNodes.find((node) => node.kind === "group" && node.groupRuleId === rule.id)?.id
    || "";
  if (!knownNodeIds.has(effectiveGroupNodeName) && !knownTemplateNames.has(effectiveGroupNodeName)) {
    throw new Error(`group rule 对应的 group 节点不存在：${effectiveGroupNodeName || rule.id}`);
  }
  if (
    rule.report !== false
    && !knownTemplateNames.has(rule.report.templateName)
    && !knownNodeIds.has(rule.report.templateName)
  ) {
    throw new Error(`group rule report target 不存在：${rule.report.templateName}`);
  }
  const knownRoles = new Set(rule.members.map((agent) => agent.role));
  if (!knownRoles.has(rule.entryRole)) {
    throw new Error(`group rule entry role 不存在：${rule.entryRole}`);
  }
  if (rule.report !== false && !knownRoles.has(rule.report.sourceRole)) {
    throw new Error(`group rule report source role 不存在：${rule.report.sourceRole}`);
  }
  for (const edge of rule.edges) {
    if (!knownRoles.has(edge.sourceRole) || !knownRoles.has(edge.targetRole)) {
      throw new Error(`group rule 含有未知 role 连线：${edge.sourceRole} -> ${edge.targetRole}`);
    }
  }
}
