import {
  DEFAULT_TOPOLOGY_TRIGGER,
  createTopologyFlowRecord,
  getTopologyNodeRecords,
  normalizeTopologyEdgeTrigger,
  type GroupRule,
  type TopologyAgentNodeRecord,
  type TopologyEdge,
  type TopologyGroupNodeRecord,
  type TopologyRecord,
} from "@shared/types";

const REQUIRED_MAX_TRIGGER_ROUNDS = 4;

type DownstreamMode =
  | "group"
  | typeof DEFAULT_TOPOLOGY_TRIGGER
  | TopologyEdge["trigger"];

interface AgentNodeMetadata {
  templateName: string;
  prompt: string;
  writable: boolean;
}

function buildReachableTargets(topology: TopologyRecord, startNodeId: string): string[] {
  const queue = [startNodeId];
  const visited = new Set<string>();
  const ordered: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    ordered.push(current);
    for (const edge of topology.edges) {
      if (edge.source === current && !visited.has(edge.target)) {
        queue.push(edge.target);
      }
    }
  }

  return ordered;
}

function buildGroupRuleFromReachable(topology: TopologyRecord, sourceNodeId: string, targetNodeId: string): GroupRule {
  const reachable = buildReachableTargets(topology, targetNodeId);
  const nodeRecords = getTopologyNodeRecords(topology);
  const targetTemplates = reachable.map((nodeId) => {
    const matched = nodeRecords.find((node) => node.id === nodeId);
    return {
      nodeId,
      templateName: matched?.templateName ?? nodeId,
    };
  });
  const reportTarget = targetTemplates.at(-1)?.templateName ?? targetNodeId;

  return {
    id: `group-rule:${targetNodeId}`,
    groupNodeName: targetNodeId,
    sourceTemplateName: sourceNodeId,
    entryRole: "entry",
    members: targetTemplates.map((item, index) => ({
      role: index === 0 ? "entry" : item.nodeId,
      templateName: item.templateName,
    })),
    edges: targetTemplates.slice(0, -1).map((item, index) => ({
      sourceRole: index === 0 ? "entry" : item.nodeId,
      targetRole: targetTemplates[index + 1]?.nodeId ?? "entry",
      trigger: "<default>" as const,
      messageMode: "last" as const,
      maxTriggerRounds: REQUIRED_MAX_TRIGGER_ROUNDS,
    })),
    report: {
      sourceRole: "summary",
      templateName: reportTarget,
      trigger: DEFAULT_TOPOLOGY_TRIGGER,
      messageMode: "last",
      maxTriggerRounds: REQUIRED_MAX_TRIGGER_ROUNDS,
    },
  };
}

function clearEdgesForPair(
  edges: TopologyEdge[],
  sourceNodeId: string,
  targetNodeId: string,
): TopologyEdge[] {
  return edges.filter(
    (edge) =>
      !(
        edge.source === sourceNodeId &&
        edge.target === targetNodeId
      ),
  );
}

function setGroupNodeState(
  topology: TopologyRecord,
  targetNodeId: string,
  enabled: boolean,
  agentNodeMetadataById: ReadonlyMap<string, AgentNodeMetadata>,
): Pick<TopologyRecord, "nodeRecords" | "groupRules"> {
  // 要求记录：
  // 1. agent 与 group 是不同类型，切换时必须重建完整节点对象。
  // 2. 节点记录禁止可空字段，默认值必须在这里一次性写实。
  const nodeRecords = getTopologyNodeRecords(topology);
  const groupRuleId = `group-rule:${targetNodeId}`;
  const nextNodeRecords = nodeRecords.map((node) =>
    node.id === targetNodeId
      ? (() => {
          if (enabled) {
            const nextGroupNode: TopologyGroupNodeRecord = {
              id: node.id,
              kind: "group",
              templateName: node.templateName,
              initialMessageRouting: node.initialMessageRouting,
              groupRuleId,
            };
            return nextGroupNode;
          }
          const nextAgentMetadata = agentNodeMetadataById.get(node.id);
          if (!nextAgentMetadata) {
            throw new Error(`缺少 agent 节点元数据：${node.id}`);
          }
          const nextAgentNode: TopologyAgentNodeRecord = {
            id: node.id,
            kind: "agent",
            templateName: nextAgentMetadata.templateName,
            initialMessageRouting: node.initialMessageRouting,
            prompt: nextAgentMetadata.prompt,
            writable: nextAgentMetadata.writable,
          };
          return nextAgentNode;
        })()
      : node,
  );
  const nextGroupRules = (topology.groupRules ?? []).filter((rule) => rule.id !== groupRuleId);

  return {
    nodeRecords: nextNodeRecords,
    groupRules: nextGroupRules,
  };
}

export function getDownstreamMode(input: {
  topology: Pick<TopologyRecord, "nodes" | "edges" | "nodeRecords">;
  sourceNodeId: string;
  targetNodeId: string;
}): DownstreamMode | null {
  const topology: TopologyRecord = {
    ...input.topology,
    flow: createTopologyFlowRecord({
      nodes: input.topology.nodes,
      edges: input.topology.edges,
    }),
  };
  const targetNode = getTopologyNodeRecords(topology).find((node) => node.id === input.targetNodeId);
  if (targetNode?.kind === "group") {
    return "group";
  }

  const trigger = topology.edges.find(
    (edge) =>
      edge.source === input.sourceNodeId &&
      edge.target === input.targetNodeId,
  )?.trigger;

  const normalizedTrigger = trigger ? normalizeTopologyEdgeTrigger(trigger) : null;
  if (normalizedTrigger) {
    return normalizedTrigger;
  }
  return null;
}

export function setGroupEnabledForDownstream(input: {
  topology: TopologyRecord;
  sourceNodeId: string;
  targetNodeId: string;
  enabled: boolean;
  agentNodeMetadataById: ReadonlyMap<string, AgentNodeMetadata>;
}): TopologyRecord {
  const nextEdges = input.enabled
    ? clearEdgesForPair(input.topology.edges, input.sourceNodeId, input.targetNodeId)
        .concat({
          source: input.sourceNodeId,
          target: input.targetNodeId,
          trigger: "<default>" as const,
          messageMode: "last" as const,
          maxTriggerRounds: REQUIRED_MAX_TRIGGER_ROUNDS,
        })
        .map((edge) => ({ ...edge }))
    : input.topology.edges.map((edge) => ({ ...edge }));
  const groupState = setGroupNodeState(
    input.topology,
    input.targetNodeId,
    input.enabled,
    input.agentNodeMetadataById,
  );
  const nextGroupRules = input.enabled
    ? (groupState.groupRules ?? []).concat(
        buildGroupRuleFromReachable(input.topology, input.sourceNodeId, input.targetNodeId),
      )
    : groupState.groupRules ?? [];

  return {
    ...input.topology,
    nodeRecords: groupState.nodeRecords,
    groupRules: nextGroupRules,
    edges: nextEdges,
  };
}

export function setDownstreamMode(input: {
  topology: TopologyRecord;
  sourceNodeId: string;
  targetNodeId: string;
  mode: DownstreamMode | null;
  agentNodeMetadataById: ReadonlyMap<string, AgentNodeMetadata>;
}): TopologyRecord {
  if (input.mode === "group") {
    return setGroupEnabledForDownstream({
      topology: input.topology,
      sourceNodeId: input.sourceNodeId,
      targetNodeId: input.targetNodeId,
      enabled: true,
      agentNodeMetadataById: input.agentNodeMetadataById,
    });
  }

  const clearedEdges = clearEdgesForPair(
    input.topology.edges,
    input.sourceNodeId,
    input.targetNodeId,
  );
  const groupState = setGroupNodeState(
    input.topology,
    input.targetNodeId,
    false,
    input.agentNodeMetadataById,
  );
  const nextEdges =
    input.mode === null
      ? clearedEdges
      : clearedEdges.concat({
          source: input.sourceNodeId,
          target: input.targetNodeId,
          trigger: normalizeTopologyEdgeTrigger(input.mode),
          messageMode: "last" as const,
          maxTriggerRounds: REQUIRED_MAX_TRIGGER_ROUNDS,
        });

  return {
    ...input.topology,
    nodeRecords: groupState.nodeRecords,
    groupRules: groupState.groupRules ?? [],
    edges: nextEdges,
  };
}
