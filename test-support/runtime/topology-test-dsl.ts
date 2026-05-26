import {
  buildTopologyNodeRecords,
  DEFAULT_TOPOLOGY_TRIGGER,
  type GroupRule,
  FLOW_END_NODE_ID,
  FLOW_START_NODE_ID,
  normalizeMaxTriggerRounds,
  normalizeTopologyEdgeTrigger,
  type TopologyEdge,
  type TopologyEdgeTrigger,
  type TopologyFlowRecord,
  type TopologyNodeRecord,
  type TopologyRecord,
} from "@shared/types";

const REQUIRED_MAX_TRIGGER_ROUNDS = 4;

type TriggerConfig =
  | TopologyEdgeTrigger
  | {
      trigger: TopologyEdgeTrigger;
      maxTriggerRounds: number;
    };
type DownstreamMode = TriggerConfig | "group";

type DownstreamMap = Record<string, Record<string, DownstreamMode>>;

type CreateTopologyInput =
  | {
      extraNodes?: string[];
      downstream: DownstreamMap;
    }
  | {
      extraNodes?: string[];
      downstream: DownstreamMap;
      group: Record<string, string>;
    };

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function collectNodes(input: CreateTopologyInput): string[] {
  const nodes = [...(input.extraNodes ?? [])];
  const groups = "group" in input ? input.group : {};

  for (const [source, targets] of Object.entries(input.downstream)) {
    pushUnique(nodes, source);
    for (const target of Object.keys(targets)) {
      if (target === FLOW_END_NODE_ID) {
        continue;
      }
      pushUnique(nodes, target);
    }
  }

  for (const [target, config] of Object.entries(groups)) {
    pushUnique(nodes, target);
    if (config) {
      pushUnique(nodes, config);
    }
  }

  return nodes;
}

function buildEdges(input: CreateTopologyInput): TopologyEdge[] {
  const edges: TopologyEdge[] = [];

  for (const [source, targets] of Object.entries(input.downstream)) {
    for (const [target, mode] of Object.entries(targets)) {
      if (target === FLOW_END_NODE_ID) {
        continue;
      }
      if (mode === "group") {
        edges.push({
          source,
          target,
          trigger: DEFAULT_TOPOLOGY_TRIGGER,
          messageMode: "last",
          maxTriggerRounds: REQUIRED_MAX_TRIGGER_ROUNDS,
        });
        continue;
      }
      edges.push({
        source,
        target,
        trigger: normalizeTopologyEdgeTrigger(
          typeof mode === "string" ? mode : mode.trigger,
        ),
        messageMode: "last",
        maxTriggerRounds: normalizeMaxTriggerRounds(
          typeof mode === "object" ? mode.maxTriggerRounds : REQUIRED_MAX_TRIGGER_ROUNDS,
        ),
      });
    }
  }

  return edges;
}

function buildNodeRecords(
  nodes: string[],
  input: CreateTopologyInput,
): TopologyNodeRecord[] {
  const groupTargets = new Set<string>();

  for (const targets of Object.values(input.downstream)) {
    for (const [target, mode] of Object.entries(targets)) {
      if (mode === "group") {
        groupTargets.add(target);
      }
    }
  }
  const groupRuleIdByNodeId = new Map<string, string>();
  for (const nodeId of groupTargets) {
    groupRuleIdByNodeId.set(nodeId, `group-rule:${nodeId}`);
  }

  return buildTopologyNodeRecords({
    nodes,
    groupNodeIds: groupTargets,
    templateNameByNodeId: new Map(),
    initialMessageRoutingByNodeId: new Map(),
    groupRuleIdByNodeId,
    groupEnabledNodeIds: groupTargets,
    promptByNodeId: new Map(),
    writableNodeIds: new Set(),
  });
}

function findGroupSource(
  downstream: DownstreamMap,
  targetNodeId: string,
): string {
  const matches: string[] = [];

  for (const [source, targets] of Object.entries(downstream)) {
    if (targets[targetNodeId] === "group") {
      matches.push(source);
    }
  }

  if (matches.length !== 1) {
    throw new Error(`测试 DSL 要求 group 节点 ${targetNodeId} 只能有且仅有一个上游来源。`);
  }

  return matches[0]!;
}

function buildGroupRules(input: CreateTopologyInput): GroupRule[] {
  const groupTargets: string[] = [];

  for (const targets of Object.values(input.downstream)) {
    for (const [target, mode] of Object.entries(targets)) {
      if (mode === "group") {
        groupTargets.push(target);
      }
    }
  }

  return groupTargets.map((target) => {
    const config = "group" in input ? input.group[target] : undefined;
    const sourceTemplateName = findGroupSource(input.downstream, target);
    if (!config) {
      throw new Error(`测试 DSL 要求 group 节点 ${target} 必须显式声明 reportTo。`);
    }

    return {
      id: `group-rule:${target}`,
      groupNodeName: target,
      sourceTemplateName,
      entryRole: "entry",
      members: [{
        role: "entry",
        templateName: target,
      }],
      edges: [],
      report: {
        sourceRole: "entry",
        templateName: config,
        trigger: DEFAULT_TOPOLOGY_TRIGGER,
        messageMode: "last",
        maxTriggerRounds: REQUIRED_MAX_TRIGGER_ROUNDS,
      },
    };
  });
}

function buildFlowFromDownstream(input: CreateTopologyInput): TopologyFlowRecord {
  const incoming = Object.entries(input.downstream).flatMap(([source, targets]) => {
    const mode = targets[FLOW_END_NODE_ID];
    if (!mode || mode === "group") {
      return [];
    }
    return [{
      source,
      trigger: normalizeTopologyEdgeTrigger(
        typeof mode === "string" ? mode : mode.trigger,
      ),
    }];
  });
  if (incoming.length === 0) {
    return {
      start: {
        id: FLOW_START_NODE_ID,
        targets: [],
      },
      end: {
        id: FLOW_END_NODE_ID,
        sources: [],
        incoming: [],
      },
    };
  }
  return {
    start: {
      id: FLOW_START_NODE_ID,
      targets: [],
    },
    end: {
      id: FLOW_END_NODE_ID,
      sources: incoming.map((item) => item.source),
      incoming,
    },
  };
}

export function createTopology(
  input: CreateTopologyInput,
): TopologyRecord {
  const nodes = collectNodes(input);
  const flow = buildFlowFromDownstream(input);
  const edges = buildEdges(input);
  const nodeRecords = buildNodeRecords(nodes, input);
  const groupRules = buildGroupRules(input);

  return {
    nodes,
    edges,
    flow,
    nodeRecords,
    ...(groupRules.length > 0 ? {groupRules} : {}),
  };
}
