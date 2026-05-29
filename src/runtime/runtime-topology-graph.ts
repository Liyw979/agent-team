import {
  getTopologyNodeRecords,
  type TopologyAgentNodeRecord,
  type TopologyGroupNodeRecord,
  type TopologyRecord,
} from "@shared/types";

import type { GraphTaskState } from "./gating-state";

export function buildEffectiveTopology(state: GraphTaskState): TopologyRecord {
  const runtimeNodeIds = state.runtimeNodes.map((node) => node.id);
  const staticNodeIds = state.topology.nodes.filter((name) => !runtimeNodeIds.includes(name));
  const topologyNodeRecords = getTopologyNodeRecords(state.topology);
  const runtimeNodeRecords = state.runtimeNodes.map((node) => {
    const templateNode = topologyNodeRecords.find(
      (item) => item.id === node.templateName || item.templateName === node.templateName,
    );
      if (node.kind === "group") {
        const baseGroupNode =
          templateNode?.kind === "group"
          ? templateNode
          : ({
              id: node.templateName,
              kind: "group",
              templateName: node.templateName,
              initialMessageRouting: { mode: "inherit" as const },
              groupRuleId: node.groupRuleId,
            } satisfies TopologyGroupNodeRecord);
        const runtimeGroupNode: TopologyGroupNodeRecord = {
          id: node.id,
          kind: "group",
          templateName: node.templateName,
          initialMessageRouting: baseGroupNode.initialMessageRouting,
          groupRuleId: node.groupRuleId,
        };
        return runtimeGroupNode;
      }
    const baseAgentNode =
      templateNode?.kind === "agent"
        ? templateNode
        : ({
            id: node.templateName,
            kind: "agent",
            templateName: node.templateName,
            initialMessageRouting: { mode: "inherit" as const },
            prompt: "",
            writable: false,
          } satisfies TopologyAgentNodeRecord);
    const runtimeAgentNode: TopologyAgentNodeRecord = {
      id: node.id,
      kind: "agent",
      templateName: node.templateName,
      initialMessageRouting: baseAgentNode.initialMessageRouting,
      prompt: baseAgentNode.prompt,
      writable: baseAgentNode.writable,
    };
    return runtimeAgentNode;
  });

  return {
    ...state.topology,
    nodes: [...staticNodeIds, ...runtimeNodeIds],
    edges: [
      ...state.topology.edges.map((edge) => ({ ...edge })),
      ...state.runtimeEdges.map((edge) => ({ ...edge })),
    ],
    nodeRecords: [
      ...topologyNodeRecords.map((node) => ({ ...node })),
      ...runtimeNodeRecords,
    ],
  };
}

export function ensureRuntimeAgentStatuses(state: GraphTaskState): void {
  for (const nodeId of buildEffectiveTopology(state).nodes) {
    if (!state.agentStatusesByName[nodeId]) {
      state.agentStatusesByName[nodeId] = "idle";
    }
  }
}

export function isGroupNode(state: GraphTaskState, nodeId: string): boolean {
  const nodeRecords = getTopologyNodeRecords(buildEffectiveTopology(state));
  return nodeRecords.some((node) => node.id === nodeId && node.kind === "group");
}

// 2026-05-29: 用户要求拓扑查询边界直接给出确定结果；缺少 groupRuleId 属于非法状态，立即失败。
export function getGroupRuleIdForNode(state: GraphTaskState, nodeId: string): string {
  const nodeRecords = getTopologyNodeRecords(buildEffectiveTopology(state));
  const groupNode = nodeRecords.find((node): node is TopologyGroupNodeRecord => node.id === nodeId && node.kind === "group");
  if (!groupNode) {
    throw new Error(`${nodeId} 缺少 groupRuleId`);
  }
  return groupNode.groupRuleId;
}

export function getGroupRuleEntryRuntimeNodeIds(state: GraphTaskState, groupId: string, groupRuleId: string): string[] {
  const rule = state.topology.groupRules?.find((candidate) => candidate.id === groupRuleId);
  if (!rule) {
    return [];
  }
  return state.runtimeNodes
    .filter((node) => node.groupId === groupId && node.role === rule.entryRole)
    .map((node) => node.id);
}

// 2026-05-29: 用户要求运行态模板查询消灭不确定性；缺少 runtime 节点属于非法状态，立即失败。
export function getRuntimeTemplateName(state: GraphTaskState, runtimeAgentId: string): string {
  const runtimeNode = state.runtimeNodes.find((node) => node.id === runtimeAgentId);
  if (!runtimeNode) {
    throw new Error(`运行态节点不存在：${runtimeAgentId}`);
  }
  return runtimeNode.templateName;
}

// 2026-05-29: 用户要求 group 源节点模板解析消灭不确定性；源节点必须能在 runtime 或有效拓扑节点中被唯一证明。
export function resolveSourceTemplateName(state: GraphTaskState, nodeId: string): string {
  const runtimeNode = state.runtimeNodes.find((node) => node.id === nodeId);
  if (runtimeNode) {
    return runtimeNode.templateName;
  }
  const topologyNode = getTopologyNodeRecords(buildEffectiveTopology(state)).find((node) => node.id === nodeId);
  if (topologyNode) {
    return topologyNode.templateName;
  }
  throw new Error(`源节点不存在：${nodeId}`);
}

export function getNextGroupSequence(state: GraphTaskState, groupRuleId: string): number {
  const next = (state.groupSequenceByRule[groupRuleId] ?? 0) + 1;
  state.groupSequenceByRule[groupRuleId] = next;
  return next;
}
