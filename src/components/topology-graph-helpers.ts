import type { TopologyEdge, TopologyRecord } from "@shared/types";

export function getTopologyAgentStatusLabel(agentName: string, agentState: string) {
  const reviewAgent = !agentName.trim().toLowerCase().startsWith("build");

  switch (agentState) {
    case "success":
      return reviewAgent ? "审查通过" : "已完成";
    case "failed":
      return reviewAgent ? "审查不通过" : "执行失败";
    case "needs_revision":
      return "审查不通过";
    case "running":
      return "运行中";
    default:
      return "未启动";
  }
}

export function getTopologyEdgeTriggerAppearance(triggerOn: TopologyEdge["triggerOn"]) {
  return triggerOn === "association"
    ? {
        color: "#2C4A3F",
        strokeWidth: 2,
        strokeDasharray: undefined,
        zIndex: 1,
        animated: false,
      }
    : {
        color: "#A95C42",
        strokeWidth: 2,
        strokeDasharray: "6 4",
        zIndex: 1,
        animated: false,
      };
}

export function getTopologyNodeOrder(
  topology: Pick<TopologyRecord, "nodes" | "agentOrderIds">,
  defaultAgentOrderIds: string[],
) {
  return topology.agentOrderIds.length > 0 ? topology.agentOrderIds : defaultAgentOrderIds;
}
