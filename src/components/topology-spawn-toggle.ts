import type { SpawnRule, TopologyEdge, TopologyNodeRecord, TopologyRecord } from "@shared/types";

export type DownstreamMode = "spawn" | "association" | "review_pass" | "review_fail";

function getNodeRecords(topology: TopologyRecord): TopologyNodeRecord[] {
  if (topology.nodeRecords && topology.nodeRecords.length > 0) {
    return topology.nodeRecords.map((node) => ({ ...node }));
  }
  return topology.nodes.map((name) => ({
    id: name,
    kind: "agent" as const,
    templateName: name,
  }));
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

function buildSpawnRuleFromReachable(topology: TopologyRecord, sourceNodeId: string, targetNodeId: string): SpawnRule {
  const reachable = buildReachableTargets(topology, targetNodeId);
  const nodeRecords = getNodeRecords(topology);
  const targetTemplates = reachable.map((nodeId) => {
    const matched = nodeRecords.find((node) => node.id === nodeId);
    return {
      nodeId,
      templateName: matched?.templateName ?? nodeId,
    };
  });
  const reportTarget = targetTemplates.at(-1)?.templateName ?? targetNodeId;

  return {
    id: `spawn-rule:${targetNodeId}`,
    name: targetNodeId,
    sourceTemplateName: sourceNodeId,
    itemKey: "spawn_items",
    entryRole: "entry",
    spawnedAgents: targetTemplates.map((item, index) => ({
      role: index === 0 ? "entry" : item.nodeId,
      templateName: item.templateName,
    })),
    edges: targetTemplates.slice(0, -1).map((item, index) => ({
      sourceRole: index === 0 ? "entry" : item.nodeId,
      targetRole: targetTemplates[index + 1]?.nodeId ?? "entry",
      triggerOn: "association" as const,
    })),
    exitWhen: "one_side_agrees",
    reportToTemplateName: reportTarget,
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

function setSpawnNodeState(
  topology: TopologyRecord,
  targetNodeId: string,
  enabled: boolean,
): Pick<TopologyRecord, "nodeRecords" | "spawnRules"> {
  const nodeRecords = getNodeRecords(topology);
  const spawnRuleId = `spawn-rule:${targetNodeId}`;
  const nextNodeRecords = nodeRecords.map((node) =>
    node.id === targetNodeId
      ? {
          ...node,
          kind: enabled ? "spawn" : "agent",
          spawnRuleId: enabled ? spawnRuleId : undefined,
          spawnEnabled: enabled,
        }
      : node,
  );
  const nextSpawnRules = (topology.spawnRules ?? []).filter((rule) => rule.id !== spawnRuleId);

  return {
    nodeRecords: nextNodeRecords,
    spawnRules: nextSpawnRules,
  };
}

export function getDownstreamMode(input: {
  topology: Pick<TopologyRecord, "edges" | "nodeRecords">;
  sourceNodeId: string;
  targetNodeId: string;
}): DownstreamMode | null {
  const targetNode = input.topology.nodeRecords?.find((node) => node.id === input.targetNodeId);
  if (targetNode?.spawnEnabled) {
    return "spawn";
  }

  const trigger = input.topology.edges.find(
    (edge) =>
      edge.source === input.sourceNodeId &&
      edge.target === input.targetNodeId,
  )?.triggerOn;

  return trigger ?? null;
}

export function setSpawnEnabledForDownstream(input: {
  topology: TopologyRecord;
  sourceNodeId: string;
  targetNodeId: string;
  enabled: boolean;
}): TopologyRecord {
  const spawnRuleId = `spawn-rule:${input.targetNodeId}`;
  const nextEdges = input.enabled
    ? clearEdgesForPair(input.topology.edges, input.sourceNodeId, input.targetNodeId)
        .concat({
          source: input.sourceNodeId,
          target: input.targetNodeId,
          triggerOn: "association" as const,
        })
        .map((edge) => ({ ...edge }))
    : input.topology.edges.map((edge) => ({ ...edge }));
  const spawnState = setSpawnNodeState(input.topology, input.targetNodeId, input.enabled);
  const nextSpawnRules = input.enabled
    ? (spawnState.spawnRules ?? []).concat(
        buildSpawnRuleFromReachable(input.topology, input.sourceNodeId, input.targetNodeId),
      )
    : spawnState.spawnRules ?? [];

  return {
    ...input.topology,
    nodeRecords: spawnState.nodeRecords,
    spawnRules: nextSpawnRules,
    edges: nextEdges,
  };
}

export function setDownstreamMode(input: {
  topology: TopologyRecord;
  sourceNodeId: string;
  targetNodeId: string;
  mode: DownstreamMode | null;
}): TopologyRecord {
  if (input.mode === "spawn") {
    return setSpawnEnabledForDownstream({
      topology: input.topology,
      sourceNodeId: input.sourceNodeId,
      targetNodeId: input.targetNodeId,
      enabled: true,
    });
  }

  const clearedEdges = clearEdgesForPair(
    input.topology.edges,
    input.sourceNodeId,
    input.targetNodeId,
  );
  const spawnState = setSpawnNodeState(input.topology, input.targetNodeId, false);
  const nextEdges =
    input.mode === null
      ? clearedEdges
      : clearedEdges.concat({
          source: input.sourceNodeId,
          target: input.targetNodeId,
          triggerOn: input.mode,
        });

  return {
    ...input.topology,
    nodeRecords: spawnState.nodeRecords,
    spawnRules: spawnState.spawnRules ?? [],
    edges: nextEdges,
  };
}
