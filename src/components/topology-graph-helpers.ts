import { isReviewAgentInTopology, type TopologyEdge, type TopologyRecord } from "@shared/types";
import type { MessageRecord } from "@shared/types";

export interface TopologyAgentStatusBadgePresentation {
  label: string;
  icon: "idle" | "running" | "success" | "failed";
  className: string;
  effectClassName: string;
}

export type TopologyNodeHeaderAction = "attach" | "status";

export function getTopologyNodeHeaderActionOrder(input: {
  showAttachButton: boolean;
}): TopologyNodeHeaderAction[] {
  return input.showAttachButton ? ["attach", "status"] : ["status"];
}

export function getTopologyAgentStatusBadgePresentation(
  topology: Pick<TopologyRecord, "edges">,
  agentName: string,
  agentState: string,
  options?: {
    finalLoopReviewerName?: string | null;
  },
): TopologyAgentStatusBadgePresentation {
  const reviewAgent = isReviewAgentInTopology(topology, agentName);
  const isFinalLoopFailedReviewer =
    reviewAgent
    && agentState === "failed"
    && options?.finalLoopReviewerName === agentName;

  switch (agentState) {
    case "completed":
      return {
        label: reviewAgent ? "审查通过" : "已完成",
        icon: "success",
        className: "border border-[#2c4a3f]/18 bg-[#edf5f0] text-[#2c4a3f]",
        effectClassName: "",
      };
    case "failed":
      return {
        label: reviewAgent
          ? (isFinalLoopFailedReviewer ? "审查不通过，最后一次" : "审查不通过")
          : "执行失败",
        icon: "failed",
        className: "border border-[#d66b63]/45 bg-[#fff1ef] text-[#a33f38]",
        effectClassName: "",
      };
    case "needs_revision":
      return {
        label: "审查不通过",
        icon: "failed",
        className: "border border-[#d66b63]/45 bg-[#fff1ef] text-[#a33f38]",
        effectClassName: "",
      };
    case "running":
      return {
        label: "运行中",
        icon: "running",
        className:
          "border border-[#d8b14a]/70 bg-[linear-gradient(180deg,#fff7d8_0%,#ffedb8_100%)] text-[#6b5208]",
        effectClassName: "topology-status-badge-running",
      };
    default:
      return {
        label: "未启动",
        icon: "idle",
        className: "border border-[#c9d6ce]/85 bg-[#f7fbf8] text-[#5f7267]",
        effectClassName: "",
      };
  }
}

export function getTopologyAgentStatusLabel(
  topology: Pick<TopologyRecord, "edges">,
  agentName: string,
  agentState: string,
) {
  return getTopologyAgentStatusBadgePresentation(topology, agentName, agentState).label;
}

export function getTopologyLoopLimitFailedReviewerName(
  messages: Pick<MessageRecord, "content" | "meta">[],
): string | null {
  const failedCompletionMessage = [...messages]
    .reverse()
    .find((message) => message.meta?.kind === "task-completed" && message.meta?.status === "failed");
  const content = failedCompletionMessage?.content?.trim() ?? "";
  const match = /^(.*?)\s*->\s*.*已连续交流\s+\d+\s+次，任务已结束$/u.exec(content);
  const reviewerName = match?.[1]?.trim() ?? "";
  return reviewerName || null;
}

export function getTopologyEdgeTriggerAppearance(triggerOn: TopologyEdge["triggerOn"]) {
  switch (triggerOn) {
    case "association":
      return {
        color: "#2C4A3F",
        strokeWidth: 2,
        strokeDasharray: undefined,
        zIndex: 1,
        animated: false,
      };
    case "approved":
      return {
        color: "#2F5E9E",
        strokeWidth: 2,
        strokeDasharray: "6 4",
        zIndex: 1,
        animated: false,
      };
    case "needs_revision":
      return {
        color: "#A95C42",
        strokeWidth: 2,
        strokeDasharray: "6 4",
        zIndex: 1,
        animated: false,
      };
    default:
      return {
        color: "#2C4A3F",
        strokeWidth: 2,
        strokeDasharray: undefined,
        zIndex: 1,
        animated: false,
      };
  }
}

export function getTopologyNodeOrder(
  topology: Pick<TopologyRecord, "nodes">,
  defaultAgentOrderIds: string[],
) {
  return topology.nodes.length > 0 ? topology.nodes : defaultAgentOrderIds;
}
