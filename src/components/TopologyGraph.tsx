import React, { useEffect, useMemo, useRef, useState, type ComponentType, type MouseEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { createPortal } from "react-dom";
import {
  BaseEdge,
  Background,
  MarkerType,
  Position,
  ReactFlow,
  getNodesBounds,
  type ReactFlowInstance,
  type EdgeProps,
  type Edge,
  type Node,
} from "@xyflow/react";
import { getAgentColorToken } from "@/lib/agent-colors";
import { getPanelHeaderActionButtonClass } from "@/lib/panel-header-action-button";
import { stripReviewResponseMarkup } from "@shared/review-response";
import { isReviewAgentInTopology, resolveTopologyAgentOrder } from "@shared/types";
import type {
  AgentRole,
  AgentRuntimeSnapshot,
  MessageRecord,
  ProjectSnapshot,
  TaskSnapshot,
  TopologyEdge,
  TopologyRecord,
} from "@shared/types";

interface TopologyGraphProps {
  project: ProjectSnapshot | undefined;
  task: TaskSnapshot | undefined;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  onSaveTopology: (topology: TopologyRecord) => Promise<void>;
  compact?: boolean;
  showEdgeList?: boolean;
  runtimeSnapshots?: Record<string, AgentRuntimeSnapshot>;
}

interface TopologyEdgeData {
  edgeKind: TopologyEdge["triggerOn"];
  laneIndex: number;
  span: number;
  horizontalPhase: number;
  sourceBlockHeight: number;
  targetBlockHeight: number;
}

interface SelectedHistoryRecord {
  agentName: string;
  label: string;
  timestamp: string;
  content: string;
}

interface HoveredHistoryPreview extends SelectedHistoryRecord {
  x: number;
  y: number;
}

const NODE_COLUMN_GAP = 8;
const NODE_START_X = 0;
const NODE_START_Y = 0;
const MAIN_NODE_COLUMN_HEIGHT = 440;
const EXPANDED_NODE_COLUMN_HEIGHT = 820;
const MAIN_NODE_CARD_WIDTH = 264;
const EXPANDED_NODE_CARD_WIDTH = 292;
const MAIN_NODE_CARD_MAX_WIDTH = 9999;
const EXPANDED_NODE_CARD_MAX_WIDTH = 9999;
const MAIN_NODE_CARD_MIN_WIDTH = 120;
const EXPANDED_NODE_CARD_MIN_WIDTH = 144;
const NODE_COLUMN_MIN_GAP = 8;
const IDLE_AGENT_BLOCK_HEIGHT = 26;
const RUNNING_AGENT_BLOCK_HEIGHT = 26;
const HISTORY_STACK_GAP = 0;
const MAX_VISIBLE_HISTORY_ITEMS = 10;
const AGENT_EDGE_TOP_INSET = 2;
const AGENT_EDGE_BOTTOM_INSET = 2;
const TOPOLOGY_EDGE_LANE_HEIGHT = 30;
const MAIN_FIT_PADDING = 0.015;
const PREVIEW_FIT_PADDING = 0.05;
const EXPANDED_FIT_PADDING = 0;
const FLOW_MIN_ZOOM = 0.1;
const FLOW_MAX_ZOOM = 2;
const MAIN_FLOW_LEFT_INSET = 3;
const MAIN_FLOW_RIGHT_INSET = 3;
const EXPANDED_FLOW_LEFT_INSET = 8;
const EXPANDED_FLOW_RIGHT_INSET = 8;
const MAIN_FLOW_TOP_INSET = TOPOLOGY_EDGE_LANE_HEIGHT;
const EXPANDED_FLOW_TOP_INSET = TOPOLOGY_EDGE_LANE_HEIGHT;
const MAIN_FLOW_BOTTOM_INSET = 4;
const EXPANDED_FLOW_BOTTOM_INSET = 6;
const AGENT_HEADER_SIDE_PADDING = 10;
const AGENT_STATUS_ICON_BUTTON_SIZE = 20;
const AGENT_HEADER_ICON_SLOT_WIDTH = 26;
const AGENT_TITLE_FONT_SIZE = 16;
const HISTORY_PANEL_PADDING_X = "0.375rem";
const HISTORY_PANEL_PADDING_Y = "0.25rem";
const EMPTY_HISTORY_PANEL_PADDING_X = "0.5rem";
const EMPTY_HISTORY_PANEL_PADDING_Y = "0.375rem";
const REJECTION_BADGE_CLASS_NAME = "border border-[#d66b63]/45 bg-[#fff1ef] text-[#a33f38]";
const REJECTION_HISTORY_CLASS_NAME = "border-[#df766e]/45 bg-[#fff1ef] text-[#a33f38]";
const REJECTION_CARD_BORDER = "#D66B63";
const REJECTION_CARD_SHADOW = "0 12px 28px rgba(214,107,99,0.2)";

function getAgentDisplayName(name: string) {
  return name;
}

function getAgentBlockHeight(agentState: string) {
  return agentState === "running" ? 38 : 38;
}

function getAgentCardAppearance(
  agentState: string,
  agentColor: ReturnType<typeof getAgentColorToken>,
) {
  switch (agentState) {
    case "running":
      return {
        borderColor: agentColor.solid,
        background: agentColor.soft,
        color: agentColor.text,
        shadow: `0 12px 30px ${agentColor.solid}33`,
      };
    case "needs_revision":
      return {
        borderColor: REJECTION_CARD_BORDER,
        background: agentColor.soft,
        color: agentColor.text,
        shadow: REJECTION_CARD_SHADOW,
      };
    case "completed":
      return {
        borderColor: agentColor.border,
        background: agentColor.soft,
        color: agentColor.text,
        shadow: `0 10px 26px ${agentColor.solid}22`,
      };
    case "failed":
      return {
        borderColor: REJECTION_CARD_BORDER,
        background: agentColor.soft,
        color: agentColor.text,
        shadow: REJECTION_CARD_SHADOW,
      };
    default:
      return {
        borderColor: agentColor.border,
        background: agentColor.soft,
        color: agentColor.text,
        shadow: `0 8px 24px ${agentColor.solid}14`,
      };
  }
}

function getAgentNameStyle() {
  return {
    fontSize: `${AGENT_TITLE_FONT_SIZE}px`,
    lineHeight: 1.15,
    letterSpacing: "0",
  } as const;
}

function createEdgeId(source: string, target: string, triggerOn: TopologyEdge["triggerOn"]) {
  return `${source}__${target}__${triggerOn}`;
}

function getEdgeTriggerLabel(triggerOn: TopologyEdge["triggerOn"]) {
  switch (triggerOn) {
    case "association":
      return "传递";
    case "review_pass":
      return "审视通过";
    case "review_fail":
      return "审视不通过";
    default:
      return triggerOn;
  }
}

function getEdgeTriggerDescription(triggerOn: TopologyEdge["triggerOn"]) {
  switch (triggerOn) {
    case "association":
      return "当前 Agent 正常完成本轮任务后，会自动传递到这个下游 Agent。";
    case "review_pass":
      return "当前 Agent 给出审查通过结论时，才会传递到这个下游 Agent。";
    case "review_fail":
      return "当前 Agent 明确给出需要继续回应的结论时，才会传递到这个下游 Agent。";
    default:
      return "";
  }
}

function getEdgeTriggerAppearance(triggerOn: TopologyEdge["triggerOn"]) {
  switch (triggerOn) {
    case "association":
      return {
        color: "#2C4A3F",
        strokeWidth: 2,
        strokeDasharray: undefined,
        zIndex: 1,
        animated: false,
      };
    case "review_pass":
      return {
        color: "#2F5E9E",
        strokeWidth: 2,
        strokeDasharray: "6 4",
        zIndex: 1,
        animated: false,
      };
    case "review_fail":
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

function getAgentStatusBadge(
  topology: Pick<TopologyRecord, "edges">,
  agentName: string,
  agentState: string,
) {
  const reviewAgent = isReviewAgentInTopology(topology, agentName);

  switch (agentState) {
    case "idle":
      return {
        label: "未启动",
        className: "border border-[#c9d6ce]/85 bg-[#f7fbf8] text-[#5f7267]",
        effectClassName: "",
        icon: "idle",
      };
    case "running":
      return {
        label: "运行中",
        className:
          "border border-[#d8b14a]/70 bg-[linear-gradient(180deg,#fff7d8_0%,#ffedb8_100%)] text-[#6b5208]",
        effectClassName: "topology-status-badge-running",
        icon: "running",
      };
    case "completed":
      return {
        label: reviewAgent ? "审视通过" : "已完成",
        className: "border border-[#2c4a3f]/18 bg-[#edf5f0] text-[#2c4a3f]",
        effectClassName: "",
        icon: "completed",
      };
    case "failed":
      return {
        label: reviewAgent ? "审视不通过" : "执行失败",
        className: REJECTION_BADGE_CLASS_NAME,
        effectClassName: "",
        icon: "failed",
      };
    case "needs_revision":
      return {
        label: "审视不通过",
        className: REJECTION_BADGE_CLASS_NAME,
        effectClassName: "",
        icon: "needs_revision",
      };
    default:
      return {
        label: "未启动",
        className: "border border-[#c9d6ce]/85 bg-[#f7fbf8] text-[#5f7267]",
        effectClassName: "",
        icon: "idle",
      };
  }
}

function renderAgentStatusIcon(statusBadge: ReturnType<typeof getAgentStatusBadge>) {
  const iconClassName =
    statusBadge.icon === "running" ? "animate-spin motion-reduce:animate-none" : "";

  return (
    <span
      title={statusBadge.label}
      aria-label={statusBadge.label}
      className={`inline-flex items-center justify-center rounded-full shadow-[0_1px_0_rgba(255,255,255,0.45)] ${statusBadge.className} ${statusBadge.effectClassName}`}
      style={{
        width: AGENT_STATUS_ICON_BUTTON_SIZE,
        height: AGENT_STATUS_ICON_BUTTON_SIZE,
      }}
    >
      {statusBadge.icon === "idle" ? (
        <svg
          viewBox="0 0 16 16"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="5.2" />
          <path d="M8 5.1v3.3l2.1 1.2" />
        </svg>
      ) : null}
      {statusBadge.icon === "running" ? (
        <svg
          viewBox="0 0 16 16"
          className={`h-3.5 w-3.5 ${iconClassName}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M13 8a5 5 0 1 1-1.46-3.54" />
          <path d="M10.8 2.7H13v2.2" />
        </svg>
      ) : null}
      {statusBadge.icon === "completed" ? (
        <svg
          viewBox="0 0 16 16"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3.4 8.1 6.6 11l6-6.2" />
        </svg>
      ) : null}
      {statusBadge.icon === "failed" || statusBadge.icon === "needs_revision" ? (
        <svg
          viewBox="0 0 16 16"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4.2 4.2 11.8 11.8" />
          <path d="M11.8 4.2 4.2 11.8" />
        </svg>
      ) : null}
    </span>
  );
}

export function getTopologyAgentStatusLabel(
  topology: Pick<TopologyRecord, "edges">,
  agentName: string,
  agentState: string,
) {
  return getAgentStatusBadge(topology, agentName, agentState).label;
}

export function getTopologyEdgeTriggerAppearance(triggerOn: TopologyEdge["triggerOn"]) {
  return getEdgeTriggerAppearance(triggerOn);
}

export function getTopologyNodeOrder(
  topology: Pick<TopologyRecord, "nodes">,
  defaultAgentOrderIds: string[],
) {
  return topology.nodes.length > 0 ? topology.nodes : defaultAgentOrderIds;
}

function computeNodeLayout(
  draft: TopologyRecord,
  _agentRoles: Map<string, AgentRole | null>,
  options?: {
    viewportWidth: number;
    viewportHeight: number;
    nodeCardWidth: number;
    nodeColumnHeight: number;
    horizontalInsetLeft: number;
    horizontalInsetRight: number;
    topInset: number;
    bottomInset: number;
    maxNodeCardWidth?: number;
    minNodeCardWidth?: number;
    minNodeGap?: number;
    stretchCards?: boolean;
  },
) {
  const layoutByNode = new Map<
    string,
    {
      x: number;
      y: number;
      sourcePosition: Position;
      targetPosition: Position;
    }
  >();
  const sortedNodeIds = [...draft.nodes];

  const nodeCount = Math.max(sortedNodeIds.length, 1);
  const fallbackGap = NODE_COLUMN_GAP;
  const viewportWidth = options?.viewportWidth ?? 0;
  const viewportHeight = options?.viewportHeight ?? 0;
  const baseNodeCardWidth = options?.nodeCardWidth ?? MAIN_NODE_CARD_WIDTH;
  const baseNodeColumnHeight = options?.nodeColumnHeight ?? MAIN_NODE_COLUMN_HEIGHT;
  const maxNodeCardWidth = options?.maxNodeCardWidth ?? baseNodeCardWidth;
  const minNodeCardWidth = Math.min(options?.minNodeCardWidth ?? baseNodeCardWidth, baseNodeCardWidth);
  const minNodeGap = Math.max(0, Math.min(options?.minNodeGap ?? NODE_COLUMN_MIN_GAP, fallbackGap));
  const stretchCards = options?.stretchCards ?? false;
  const leftPadding = options?.horizontalInsetLeft ?? 0;
  const rightPadding = options?.horizontalInsetRight ?? 0;
  const topPadding = options?.topInset ?? 0;
  const bottomPadding = options?.bottomInset ?? 0;
  const availableWidth = Math.max(1, viewportWidth - leftPadding - rightPadding);
  const availableHeight = Math.max(1, viewportHeight - topPadding - bottomPadding);
  const resolvedNodeColumnHeight = viewportHeight > 0 ? availableHeight : baseNodeColumnHeight;
  const gapCount = Math.max(nodeCount - 1, 0);
  const baseContentWidth = baseNodeCardWidth * nodeCount + fallbackGap * gapCount;
  let resolvedNodeCardWidth = baseNodeCardWidth;
  let resolvedGap = fallbackGap;
  let startOffsetX = leftPadding;

  if (viewportWidth > 0) {
    if (availableWidth >= baseContentWidth) {
      if (stretchCards) {
        resolvedGap = gapCount > 0 ? minNodeGap : 0;
        resolvedNodeCardWidth = Math.min(
          maxNodeCardWidth,
          Math.max(
            baseNodeCardWidth,
            (availableWidth - resolvedGap * gapCount) / Math.max(nodeCount, 1),
          ),
        );
      } else {
        const extraWidth = availableWidth - baseContentWidth;
        const widthCapacity = Math.max(0, maxNodeCardWidth - baseNodeCardWidth) * nodeCount;
        const appliedWidthExtra = Math.min(extraWidth, widthCapacity);
        resolvedNodeCardWidth =
          baseNodeCardWidth + (nodeCount > 0 ? appliedWidthExtra / nodeCount : 0);
        resolvedGap = gapCount > 0 ? fallbackGap : 0;
      }
      startOffsetX = leftPadding;
    } else {
      const missingWidth = baseContentWidth - availableWidth;
      const widthShrinkCapacity = Math.max(0, baseNodeCardWidth - minNodeCardWidth) * nodeCount;
      const appliedWidthShrink = Math.min(missingWidth, widthShrinkCapacity);
      resolvedNodeCardWidth =
        baseNodeCardWidth - (nodeCount > 0 ? appliedWidthShrink / nodeCount : 0);
      const remainingShrink = missingWidth - appliedWidthShrink;
      const nextGap = gapCount > 0 ? fallbackGap - remainingShrink / gapCount : 0;
      resolvedGap = gapCount > 0 ? Math.max(minNodeGap, nextGap) : 0;
      startOffsetX = leftPadding;
    }
  }

  sortedNodeIds.forEach((nodeId, index) => {
    layoutByNode.set(nodeId, {
      x:
        NODE_START_X +
        startOffsetX +
        index * (resolvedNodeCardWidth + (viewportWidth > 0 ? resolvedGap : fallbackGap)),
      y: NODE_START_Y,
      sourcePosition: Position.Top,
      targetPosition: Position.Top,
    });
  });

  return {
    layoutByNode,
    nodeCardWidth: resolvedNodeCardWidth,
    nodeColumnHeight: resolvedNodeColumnHeight,
  };
}

function toShortTime(timestamp: string | null | undefined) {
  if (!timestamp) {
    return "";
  }

  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) {
    return "";
  }

  return value.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function summarizeHistoryText(content: string | null | undefined) {
  const normalized = stripReviewResponseMarkup(content ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "暂无详细记录";
  }
  return normalized;
}

function normalizeFullHistoryText(content: string | null | undefined) {
  const normalized = stripReviewResponseMarkup(content ?? "").trim();
  return normalized || "暂无详细记录";
}

function summarizeToolHistory(toolName: string, detail: string) {
  const normalizedDetail = detail.replace(/^参数:\s*/u, "").trim();
  return summarizeHistoryText(
    normalizedDetail ? `${toolName.trim()} · 参数: ${normalizedDetail}` : toolName.trim(),
  );
}

function buildFullToolHistory(toolName: string, detail: string) {
  const normalizedDetail = detail.replace(/^参数:\s*/u, "").trim();
  return normalizeFullHistoryText(
    normalizedDetail ? `${toolName.trim()} · 参数: ${normalizedDetail}` : toolName.trim(),
  );
}

function getRuntimeActivityAppearance(kind: string) {
  switch (kind) {
    case "tool":
      return {
        label: "工具",
        className: "border-[#d4b07b] bg-[#fff3e1] text-[#7a4d15]",
      };
    case "thinking":
      return {
        label: "思考",
        className: "border-[#b7b8cb] bg-[#f5f5fb] text-[#43455f]",
      };
    case "step":
      return {
        label: "步骤",
        className: "border-[#9cb9d7] bg-[#edf4fb] text-[#27496b]",
      };
    default:
      return {
        label: "消息",
        className: "border-[#a9cbb6] bg-[#e9f4ee] text-[#1f4b34]",
      };
  }
}

function getHistoryAppearance(status: string, reviewAgent: boolean) {
  switch (status) {
    case "running":
      return {
        label: "消息",
        className: "border-secondary/50 bg-secondary/12 text-secondary-foreground",
      };
    case "needs_revision":
      return {
        label: "审视不通过",
        className: REJECTION_HISTORY_CLASS_NAME,
      };
    case "failed":
      return {
        label: reviewAgent ? "审视不通过" : "执行失败",
        className: REJECTION_HISTORY_CLASS_NAME,
      };
    default:
      return {
        label: reviewAgent ? "审视通过" : "已完成",
        className: "border-accent/55 bg-accent/18 text-foreground",
      };
  }
}

function getAgentHistoryFromMessages(
  messages: MessageRecord[],
  topology: Pick<TopologyRecord, "edges">,
  agentId: string,
) {
  const reviewAgent = isReviewAgentInTopology(topology, agentId);
  return messages
    .filter((message) => message.sender === agentId && message.meta?.kind === "agent-final")
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(-MAX_VISIBLE_HISTORY_ITEMS)
    .map((message) => {
      const status =
        message.meta?.reviewDecision === "needs_revision"
          ? "needs_revision"
          : message.meta?.status ?? "completed";
      const appearance = getHistoryAppearance(status, reviewAgent);
      return {
        id: message.id,
        label: appearance.label,
        className: appearance.className,
        sortTimestamp: message.timestamp,
        timestamp: toShortTime(message.timestamp),
        detail: summarizeHistoryText(message.meta?.finalMessage ?? message.content),
        fullDetail: normalizeFullHistoryText(message.meta?.finalMessage ?? message.content),
      };
    });
}

function getRuntimeHistoryItems(snapshot: AgentRuntimeSnapshot | undefined, agentId: string) {
  if (!snapshot) {
    return [];
  }

  return [...snapshot.activities]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(-MAX_VISIBLE_HISTORY_ITEMS)
    .map((activity, index) => {
      const appearance = getRuntimeActivityAppearance(activity.kind);
      const detail =
        activity.kind === "tool"
          ? summarizeToolHistory(activity.label, activity.detail)
          : summarizeHistoryText(activity.detail || activity.label);
      return {
        id: `${agentId}-runtime-${activity.id}-${index}`,
        label: appearance.label,
        className: appearance.className,
        sortTimestamp: activity.timestamp,
        timestamp: toShortTime(activity.timestamp),
        detail,
        fullDetail:
          activity.kind === "tool"
            ? buildFullToolHistory(activity.label, activity.detail)
            : normalizeFullHistoryText(activity.detail || activity.label),
      };
  });
}

function CurvedTopologyEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  style,
  data,
}: EdgeProps<Edge<TopologyEdgeData>>) {
  const laneIndex = data?.laneIndex ?? 0;
  const span = data?.span ?? 1;
  const horizontalPhase = data?.horizontalPhase ?? 0;
  const sourceTopY = sourceY + AGENT_EDGE_TOP_INSET;
  const targetTopY = targetY + AGENT_EDGE_TOP_INSET;
  const maxArcRise = Math.max(12, TOPOLOGY_EDGE_LANE_HEIGHT - 8);

  if (Math.abs(targetX - sourceX) < 2) {
    const loopWidth = 30 + laneIndex * 10;
    const loopDepth = Math.min(maxArcRise - 3, 16 + laneIndex * 6);
    const path = [
      `M ${sourceX} ${sourceTopY}`,
      `C ${sourceX + loopWidth} ${sourceTopY - 8}, ${sourceX + loopWidth} ${sourceTopY - loopDepth}, ${sourceX} ${sourceTopY - loopDepth}`,
      `C ${sourceX - loopWidth} ${sourceTopY - loopDepth}, ${sourceX - loopWidth} ${sourceTopY - 8}, ${sourceX} ${sourceTopY}`,
    ].join(" ");

    return (
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          ...style,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }}
      />
    );
  }

  const direction = targetX > sourceX ? 1 : -1;
  const horizontalDistance = Math.abs(targetX - sourceX);
  const verticalDepth = Math.min(
    maxArcRise,
    14 + Math.min(span, 5) * 3 + laneIndex * 4.5 + Math.abs(horizontalPhase) * 2.5,
  );
  const horizontalBias = horizontalPhase * 10;
  const startX = sourceX;
  const endX = targetX;
  const startY = sourceTopY;
  const endY = targetTopY;
  const controlReach = Math.max(28, Math.min(92, horizontalDistance * 0.2));
  const sourceControlX = startX + direction * (controlReach + horizontalBias);
  const targetControlX = endX - direction * (controlReach - horizontalBias);
  const sourceControlY = startY - verticalDepth * 0.55;
  const targetControlY = endY - verticalDepth * 1.02;
  const path = [
    `M ${startX} ${startY}`,
    `C ${sourceControlX} ${sourceControlY}, ${targetControlX} ${targetControlY}, ${endX} ${endY}`,
  ].join(" ");

  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={{
        ...style,
        strokeLinecap: "round",
        strokeLinejoin: "round",
      }}
    />
  );
}

interface BottomAnchoredFlowProps {
  nodes: Node[];
  edges: Edge[];
  edgeTypes: Record<string, ComponentType<EdgeProps<Edge<TopologyEdgeData>>>>;
  fitPadding?: number;
  horizontalInsetLeft?: number;
  horizontalInsetRight?: number;
  topInset?: number;
  bottomInset?: number;
  framed?: boolean;
  preserveLayoutViewport?: boolean;
  onNodeClick?: (_event: MouseEvent, node: Node) => void;
  onNodeMouseEnter?: (_event: MouseEvent, node: Node) => void;
  onNodeMouseLeave?: (_event: MouseEvent, node: Node) => void;
}

function BottomAnchoredFlow({
  nodes,
  edges,
  edgeTypes,
  fitPadding = EXPANDED_FIT_PADDING,
  horizontalInsetLeft = 18,
  horizontalInsetRight = 18,
  topInset = 8,
  bottomInset = 8,
  framed = true,
  preserveLayoutViewport = false,
  onNodeClick,
  onNodeMouseEnter,
  onNodeMouseLeave,
}: BottomAnchoredFlowProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const flowRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const viewportSignature = useMemo(
    () =>
      [
        nodes
          .map((node) => {
            const height =
              typeof node.style?.height === "number" || typeof node.style?.height === "string"
                ? node.style.height
                : "";
            return `${node.id}:${node.position.x}:${node.position.y}:${height}`;
          })
          .join("|"),
        edges.map((edge) => `${edge.id}:${edge.source}:${edge.target}`).join("|"),
      ].join("::"),
    [edges, nodes],
  );

  useEffect(() => {
    if (!containerRef.current || !flowRef.current || nodes.length === 0) {
      return;
    }

    const applyViewport = () => {
      if (!containerRef.current || !flowRef.current) {
        return;
      }

      if (preserveLayoutViewport) {
        void flowRef.current.setViewport(
          {
            x: 0,
            y: topInset,
            zoom: 1,
          },
          { duration: 0 },
        );
        return;
      }

      const bounds = getNodesBounds(nodes);
      const width = containerRef.current.clientWidth;
      const height = containerRef.current.clientHeight;
      if (width <= 0 || height <= 0) {
        return;
      }

      const leftPadding = horizontalInsetLeft;
      const rightPadding = horizontalInsetRight;
      const topPadding = Math.max(topInset, Math.round(height * fitPadding * 0.2));
      const bottomPadding = Math.max(bottomInset, Math.round(height * fitPadding * 0.2));
      const availableWidth = Math.max(1, width - leftPadding - rightPadding);
      const availableHeight = Math.max(1, height - topPadding - bottomPadding);
      const widthZoom = availableWidth / Math.max(bounds.width, 1);
      const heightZoom = availableHeight / Math.max(bounds.height, 1);
      const zoom = Math.min(FLOW_MAX_ZOOM, Math.max(FLOW_MIN_ZOOM, Math.min(widthZoom, heightZoom)));
      void flowRef.current.setViewport(
        {
          x: leftPadding - bounds.x * zoom,
          y: topPadding - bounds.y * zoom,
          zoom,
        },
        { duration: 0 },
      );
    };

    void applyViewport();
    const observer = new ResizeObserver(() => {
      void applyViewport();
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
    };
  }, [
    bottomInset,
    fitPadding,
    horizontalInsetLeft,
    horizontalInsetRight,
    preserveLayoutViewport,
    topInset,
    viewportSignature,
  ]);

  return (
    <div
      ref={containerRef}
      className={
        framed
          ? "min-h-0 h-full w-full overflow-hidden rounded-[8px] border border-border/70 bg-card"
          : "min-h-0 h-full w-full overflow-hidden"
      }
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        edgeTypes={edgeTypes}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        onInit={(instance) => {
          flowRef.current = instance;
        }}
        onNodeClick={onNodeClick}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
      >
        <Background color="rgba(44,74,63,0.08)" gap={24} />
      </ReactFlow>
    </div>
  );
}

export function TopologyGraph({
  project,
  task,
  selectedAgentId,
  onSelectAgent,
  onSaveTopology,
  compact = false,
  showEdgeList = !compact,
  runtimeSnapshots = {},
}: TopologyGraphProps) {
  const topology = project?.topology;
  const [draft, setDraft] = useState<TopologyRecord | null>(topology ?? null);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [hoveredAgentId, setHoveredAgentId] = useState<string | null>(null);
  const [expandedOpen, setExpandedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedHistoryRecord, setSelectedHistoryRecord] = useState<SelectedHistoryRecord | null>(null);
  const [hoveredHistoryPreview, setHoveredHistoryPreview] = useState<HoveredHistoryPreview | null>(null);
  const mainViewportRef = useRef<HTMLDivElement | null>(null);
  const expandedViewportRef = useRef<HTMLDivElement | null>(null);
  const historyScrollRefs = useRef(new Map<string, Set<HTMLDivElement>>());
  const historyAutoStickToBottom = useRef(new Map<string, boolean>());
  const [mainViewportSize, setMainViewportSize] = useState({ width: 0, height: 0 });
  const [expandedViewportSize, setExpandedViewportSize] = useState({ width: 0, height: 0 });
  const edgeTypes = useMemo(
    () => ({
      curvedTopology: CurvedTopologyEdge,
    }),
    [],
  );

  useEffect(() => {
    setDraft(topology ?? null);
  }, [topology]);

  useEffect(() => {
    if (selectedHistoryRecord) {
      setHoveredHistoryPreview(null);
    }
  }, [selectedHistoryRecord]);

  useEffect(() => {
    if (!mainViewportRef.current) {
      return;
    }

    const element = mainViewportRef.current;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      setMainViewportSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!expandedViewportRef.current || !expandedOpen) {
      return;
    }

    const element = expandedViewportRef.current;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      setExpandedViewportSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [expandedOpen]);

  const taskStatuses = useMemo(
    () => new Map(task?.agents.map((agent) => [agent.name, agent.status]) ?? []),
    [task],
  );
  const agentRoles = useMemo(() => new Map<string, AgentRole | null>(), []);
  const defaultAgentOrderIds = useMemo(
    () =>
      resolveTopologyAgentOrder(
        project?.agentFiles.map((agent) => ({ name: agent.name })) ?? [],
        project?.topology.nodes ?? null,
      ),
    [project],
  );
  const autoLayout = useMemo(() => {
    if (!draft) {
      return {
        layoutByNode: new Map(),
        nodeCardWidth: MAIN_NODE_CARD_WIDTH,
        nodeColumnHeight: MAIN_NODE_COLUMN_HEIGHT,
      };
    }
    return computeNodeLayout(
      {
        ...draft,
        nodes: draft.nodes.length > 0 ? draft.nodes : defaultAgentOrderIds,
      },
      agentRoles,
      {
        viewportWidth: mainViewportSize.width,
        viewportHeight: mainViewportSize.height,
        nodeCardWidth: MAIN_NODE_CARD_WIDTH,
        nodeColumnHeight: MAIN_NODE_COLUMN_HEIGHT,
        horizontalInsetLeft: MAIN_FLOW_LEFT_INSET,
        horizontalInsetRight: MAIN_FLOW_RIGHT_INSET,
        topInset: MAIN_FLOW_TOP_INSET,
        stretchCards: true,
        bottomInset: MAIN_FLOW_BOTTOM_INSET,
        maxNodeCardWidth: MAIN_NODE_CARD_MAX_WIDTH,
        minNodeCardWidth: MAIN_NODE_CARD_MIN_WIDTH,
        minNodeGap: NODE_COLUMN_MIN_GAP,
      },
    );
  }, [agentRoles, defaultAgentOrderIds, draft, mainViewportSize.height, mainViewportSize.width]);
  const expandedAutoLayout = useMemo(() => {
    if (!draft) {
      return {
        layoutByNode: new Map(),
        nodeCardWidth: EXPANDED_NODE_CARD_WIDTH,
        nodeColumnHeight: EXPANDED_NODE_COLUMN_HEIGHT,
      };
    }
    return computeNodeLayout(
      {
        ...draft,
        nodes: draft.nodes.length > 0 ? draft.nodes : defaultAgentOrderIds,
      },
      agentRoles,
      {
        viewportWidth: expandedViewportSize.width,
        viewportHeight: expandedViewportSize.height,
        nodeCardWidth: EXPANDED_NODE_CARD_WIDTH,
        nodeColumnHeight: EXPANDED_NODE_COLUMN_HEIGHT,
        horizontalInsetLeft: EXPANDED_FLOW_LEFT_INSET,
        horizontalInsetRight: EXPANDED_FLOW_RIGHT_INSET,
        topInset: EXPANDED_FLOW_TOP_INSET,
        bottomInset: EXPANDED_FLOW_BOTTOM_INSET,
        maxNodeCardWidth: EXPANDED_NODE_CARD_MAX_WIDTH,
        minNodeCardWidth: EXPANDED_NODE_CARD_MIN_WIDTH,
        minNodeGap: NODE_COLUMN_MIN_GAP,
        stretchCards: true,
      },
    );
  }, [agentRoles, defaultAgentOrderIds, draft, expandedViewportSize.height, expandedViewportSize.width]);
  const agentHistories = useMemo(() => {
    const taskMessages = task?.messages ?? [];
    const histories = new Map<string, ReturnType<typeof getAgentHistoryFromMessages>>();

    for (const nodeId of draft?.nodes ?? []) {
      histories.set(nodeId, getAgentHistoryFromMessages(taskMessages, draft, nodeId));
    }

    return histories;
  }, [draft, task?.messages]);
  const highlightedOutgoingTargets = useMemo(() => {
    if (!draft || !hoveredAgentId) {
      return new Set<string>();
    }

    return new Set(
      draft.edges
        .filter((edge) => edge.source === hoveredAgentId && edge.target !== hoveredAgentId)
        .map((edge) => edge.target),
    );
  }, [draft, hoveredAgentId]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      historyScrollRefs.current.forEach((elements, agentId) => {
        if (!historyAutoStickToBottom.current.get(agentId)) {
          return;
        }
        elements.forEach((element) => {
          element.scrollTop = element.scrollHeight;
        });
      });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [agentHistories, expandedOpen, runtimeSnapshots, task?.messages, taskStatuses]);

  function buildNodes(
    layoutByNode: Map<
      string,
      {
        x: number;
        y: number;
        sourcePosition: Position;
        targetPosition: Position;
      }
    >,
    nodeColumnHeight: number,
    nodeCardWidth: number,
  ): Node[] {
    const topologyForStatus = draft ?? project?.topology;
    if (!draft || !topologyForStatus) {
      return [];
    }

    return draft.nodes.map((nodeId) => {
      const displayName = getAgentDisplayName(nodeId);
      const agentState = taskStatuses.get(nodeId) ?? "idle";
      const agentColor = getAgentColorToken(nodeId);
      const active = nodeId === selectedAgentId;
      const hovered = nodeId === hoveredAgentId;
      const connectedFromHovered = highlightedOutgoingTargets.has(nodeId);
      const layout = layoutByNode.get(nodeId) ?? {
        x: NODE_START_X,
        y: NODE_START_Y,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      };
      const runtime = agentState === "running" ? runtimeSnapshots[nodeId] : undefined;
      const statusBadge = getAgentStatusBadge(topologyForStatus, nodeId, agentState);
      const agentBlockHeight = getAgentBlockHeight(agentState);
      const historyItems = agentHistories.get(nodeId) ?? [];
      const appearance = getAgentCardAppearance(agentState, agentColor);
      const visibleHistory =
        runtime && agentState === "running"
          ? [...historyItems, ...getRuntimeHistoryItems(runtime, nodeId)]
              .sort((left, right) => left.sortTimestamp.localeCompare(right.sortTimestamp))
              .slice(-MAX_VISIBLE_HISTORY_ITEMS)
          : historyItems;
      const historyTopOffset = agentBlockHeight + HISTORY_STACK_GAP;
      const bindHistoryScrollRef = (element: HTMLDivElement | null) => {
        const current = historyScrollRefs.current.get(nodeId) ?? new Set<HTMLDivElement>();
        current.forEach((registeredElement) => {
          if (!registeredElement.isConnected) {
            current.delete(registeredElement);
          }
        });

        if (element) {
          current.add(element);
          if (!historyAutoStickToBottom.current.has(nodeId)) {
            historyAutoStickToBottom.current.set(nodeId, true);
          }
        }

        if (current.size > 0) {
          historyScrollRefs.current.set(nodeId, current);
        } else {
          historyScrollRefs.current.delete(nodeId);
          historyAutoStickToBottom.current.delete(nodeId);
        }
      };
      const updateHoveredHistoryPreview = (
        event: MouseEvent<HTMLButtonElement>,
        record: SelectedHistoryRecord,
      ) => {
        if (selectedHistoryRecord) {
          return;
        }

        const previewWidth = 420;
        const previewHeight = 320;
        const gap = 16;
        const maxLeft = Math.max(16, window.innerWidth - previewWidth - 16);
        const maxTop = Math.max(16, window.innerHeight - previewHeight - 16);
        const nextLeft =
          event.clientX + gap + previewWidth <= window.innerWidth - 16
            ? event.clientX + gap
            : event.clientX - previewWidth - gap;
        const nextTop =
          event.clientY + gap + previewHeight <= window.innerHeight - 16
            ? event.clientY + gap
            : event.clientY - previewHeight - gap;
        const left = Math.max(16, Math.min(nextLeft, maxLeft));
        const top = Math.max(16, Math.min(nextTop, maxTop));

        setHoveredHistoryPreview({
          ...record,
          x: left,
          y: top,
        });
      };
      const cardStyle = {
        borderRadius: "8px 8px 0 0",
        border:
          active || hovered || connectedFromHovered
            ? "2px solid #3E8F63"
            : `1px solid ${appearance.borderColor}`,
        background: appearance.background,
        color: appearance.color,
        boxShadow:
          hovered || connectedFromHovered
            ? "0 0 0 3px rgba(62,143,99,0.16), 0 18px 38px rgba(62,143,99,0.16)"
            : active
              ? "0 20px 40px rgba(44,74,63,0.14)"
              : appearance.shadow,
      } as const;

      return {
        id: nodeId,
        position: { x: layout.x, y: layout.y },
        sourcePosition: layout.sourcePosition,
        targetPosition: layout.targetPosition,
        width: nodeCardWidth,
        height: nodeColumnHeight,
        data: {
          label: (
            <div className="relative h-full w-full">
              <div
                className="absolute inset-x-0 top-0 px-2.5 text-center"
                style={{
                  ...cardStyle,
                  minHeight: agentBlockHeight,
                  maxHeight: agentBlockHeight,
                }}
              >
                <div
                  className="absolute inset-x-0 top-1/2 -translate-y-1/2 overflow-hidden"
                  style={{
                    paddingLeft: `${AGENT_HEADER_SIDE_PADDING}px`,
                    paddingRight: `${AGENT_HEADER_SIDE_PADDING}px`,
                  }}
                >
                  <div
                    className="grid w-full items-center"
                    style={{
                      gridTemplateColumns: `${AGENT_HEADER_ICON_SLOT_WIDTH}px minmax(0, 1fr) ${AGENT_HEADER_ICON_SLOT_WIDTH}px`,
                    }}
                  >
                    <div aria-hidden="true" />
                    <p
                      className="block truncate text-center font-semibold"
                      style={{
                        ...getAgentNameStyle(),
                      }}
                    >
                      {displayName}
                    </p>
                    <div className="relative flex justify-end">
                      {renderAgentStatusIcon(statusBadge)}
                    </div>
                  </div>
                </div>
              </div>

              <div
                className="absolute inset-x-0 bottom-0"
                style={{
                  top: historyTopOffset,
                }}
              >
                {visibleHistory.length > 0 ? (
                  <div
                    className="flex h-full flex-col rounded-b-[12px] rounded-t-none border border-t-0 text-left shadow-sm"
                    style={{
                      borderColor: agentColor.border,
                      background: agentColor.soft,
                      color: agentColor.text,
                      paddingLeft: HISTORY_PANEL_PADDING_X,
                      paddingRight: HISTORY_PANEL_PADDING_X,
                      paddingTop: HISTORY_PANEL_PADDING_Y,
                      paddingBottom: HISTORY_PANEL_PADDING_Y,
                    }}
                  >
                    <div
                      ref={bindHistoryScrollRef}
                      onWheelCapture={(event) => {
                        event.stopPropagation();
                      }}
                      onScroll={(event) => {
                        const element = event.currentTarget;
                        const distanceToBottom =
                          element.scrollHeight - element.clientHeight - element.scrollTop;
                        historyAutoStickToBottom.current.set(nodeId, distanceToBottom <= 12);
                      }}
                      className="nowheel min-h-0 flex-1 space-y-1 overflow-y-auto pr-1"
                    >
                      {visibleHistory.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className={`block w-full rounded-[8px] border px-3 py-1.5 text-left text-[11px] leading-4 transition hover:brightness-[0.98] ${item.className}`}
                          onMouseDown={(event) => {
                            event.stopPropagation();
                          }}
                          onMouseEnter={(event) => {
                            event.stopPropagation();
                            updateHoveredHistoryPreview(event, {
                              agentName: getAgentDisplayName(nodeId),
                              label: item.label,
                              timestamp: item.timestamp,
                              content: item.fullDetail,
                            });
                          }}
                          onMouseMove={(event) => {
                            updateHoveredHistoryPreview(event, {
                              agentName: getAgentDisplayName(nodeId),
                              label: item.label,
                              timestamp: item.timestamp,
                              content: item.fullDetail,
                            });
                          }}
                          onMouseLeave={() => {
                            if (!selectedHistoryRecord) {
                              setHoveredHistoryPreview(null);
                            }
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedHistoryRecord({
                              agentName: getAgentDisplayName(nodeId),
                              label: item.label,
                              timestamp: item.timestamp,
                              content: item.fullDetail,
                            });
                          }}
                        >
                          {item.label || item.timestamp ? (
                            <div className="flex items-center justify-between gap-2">
                              {item.label ? <span className="font-semibold">{item.label}</span> : null}
                              {item.timestamp ? <span className="opacity-70">{item.timestamp}</span> : null}
                            </div>
                          ) : null}
                          <p className={`${item.label || item.timestamp ? "mt-1" : ""} line-clamp-3 whitespace-pre-wrap break-all opacity-90`}>
                            {item.detail}
                          </p>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div
                    className="flex h-full flex-col rounded-b-[12px] rounded-t-none border border-t-0 text-left text-[14px] font-medium shadow-sm"
                    style={{
                      borderColor: agentColor.border,
                      background: agentColor.soft,
                      color: agentColor.mutedText,
                      paddingLeft: EMPTY_HISTORY_PANEL_PADDING_X,
                      paddingRight: EMPTY_HISTORY_PANEL_PADDING_X,
                      paddingTop: EMPTY_HISTORY_PANEL_PADDING_Y,
                      paddingBottom: EMPTY_HISTORY_PANEL_PADDING_Y,
                    }}
                  >
                    待启动
                  </div>
                )}
              </div>

            </div>
          ),
        },
        style: {
          background: "transparent",
          border: "none",
          boxShadow: "none",
          padding: 0,
          width: nodeCardWidth,
          height: nodeColumnHeight,
        },
      };
    });
  }

  const nodes = useMemo(
    () => buildNodes(autoLayout.layoutByNode, autoLayout.nodeColumnHeight, autoLayout.nodeCardWidth),
    [agentHistories, autoLayout, draft, highlightedOutgoingTargets, hoveredAgentId, runtimeSnapshots, selectedAgentId, taskStatuses],
  );
  const expandedNodes = useMemo(
    () =>
      buildNodes(
        expandedAutoLayout.layoutByNode,
        expandedAutoLayout.nodeColumnHeight,
        expandedAutoLayout.nodeCardWidth,
      ),
    [agentHistories, draft, expandedAutoLayout, highlightedOutgoingTargets, hoveredAgentId, runtimeSnapshots, selectedAgentId, taskStatuses],
  );

  const edges = useMemo<Edge[]>(() => {
    const nodeOrder = new Map(
      draft?.nodes
        .map((node) => node)
        .sort((left, right) => {
          const leftX = autoLayout.layoutByNode.get(left)?.x ?? 0;
          const rightX = autoLayout.layoutByNode.get(right)?.x ?? 0;
          return leftX - rightX;
        })
        .map((nodeId, index) => [nodeId, index]) ?? [],
    );
    const orderedEdges = [...(draft?.edges ?? [])].sort((left, right) => {
      const leftSourceOrder = nodeOrder.get(left.source) ?? 0;
      const rightSourceOrder = nodeOrder.get(right.source) ?? 0;
      if (leftSourceOrder !== rightSourceOrder) {
        return leftSourceOrder - rightSourceOrder;
      }
      const leftTargetOrder = nodeOrder.get(left.target) ?? 0;
      const rightTargetOrder = nodeOrder.get(right.target) ?? 0;
      if (leftTargetOrder !== rightTargetOrder) {
        return leftTargetOrder - rightTargetOrder;
      }
      return createEdgeId(left.source, left.target, left.triggerOn).localeCompare(
        createEdgeId(right.source, right.target, right.triggerOn),
      );
    });

    return orderedEdges.map((edge, index) => {
      const triggerAppearance = getEdgeTriggerAppearance(edge.triggerOn);
      const isHoveredEdge =
        hoveredAgentId &&
        edge.source === hoveredAgentId &&
        edge.target !== hoveredAgentId;

      return {
        id: createEdgeId(edge.source, edge.target, edge.triggerOn),
        source: edge.source,
        target: edge.target,
        type: "curvedTopology",
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isHoveredEdge ? "#3E8F63" : triggerAppearance.color,
        },
        style: {
          stroke: isHoveredEdge ? "#3E8F63" : triggerAppearance.color,
          strokeWidth: isHoveredEdge ? 3 : triggerAppearance.strokeWidth,
          strokeDasharray: isHoveredEdge ? undefined : triggerAppearance.strokeDasharray,
        },
        zIndex: isHoveredEdge ? 3 : triggerAppearance.zIndex,
        animated: isHoveredEdge ? true : triggerAppearance.animated,
        interactionWidth: 24,
        sourceHandle: null,
        targetHandle: null,
        data: {
          edgeKind: edge.triggerOn,
          laneIndex: index % 5,
          span: Math.max(
            1,
            Math.abs((nodeOrder.get(edge.target) ?? 0) - (nodeOrder.get(edge.source) ?? 0)),
          ),
          horizontalPhase: (index % 3) - 1,
          sourceBlockHeight: getAgentBlockHeight(taskStatuses.get(edge.source) ?? "idle"),
          targetBlockHeight: getAgentBlockHeight(taskStatuses.get(edge.target) ?? "idle"),
        },
      };
    });
  }, [autoLayout, draft, hoveredAgentId, taskStatuses]);

  const editingAgent = project?.agentFiles.find((agent) => agent.name === editingAgentId);
  const downstreamTriggersByTarget = useMemo(() => {
    if (!draft || !editingAgentId) {
      return new Map<string, Set<TopologyEdge["triggerOn"]>>();
    }
    const next = new Map<string, Set<TopologyEdge["triggerOn"]>>();
    for (const edge of draft.edges.filter((item) => item.source === editingAgentId)) {
      const triggers = next.get(edge.target) ?? new Set<TopologyEdge["triggerOn"]>();
      triggers.add(edge.triggerOn);
      next.set(edge.target, triggers);
    }
    return next;
  }, [draft, editingAgentId]);

  async function saveDraft(next: TopologyRecord) {
    if (!project) {
      return;
    }
    setDraft(next);
    setSaving(true);
    try {
      await onSaveTopology(next);
    } finally {
      setSaving(false);
    }
  }

  async function setDownstreamTrigger(
    target: string,
    triggerOn: TopologyEdge["triggerOn"],
    enabled: boolean,
  ) {
    if (!draft || !editingAgentId) {
      return;
    }

    const retained = draft.edges.filter(
      (edge) => !(edge.source === editingAgentId && edge.target === target),
    );
    const nextEdges = enabled
      ? [
          ...retained,
          {
            source: editingAgentId,
            target,
            triggerOn,
          },
        ]
      : retained;

    await saveDraft({
      ...draft,
      edges: nextEdges,
    });
  }

  return (
    <section className="PANEL-surface relative flex h-full min-h-0 flex-col overflow-hidden rounded-[10px]">
      <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border/60 px-5">
          <div>
            <p className="font-display text-[1.45rem] font-bold text-primary">拓扑图</p>
            {compact ? (
              <p className="text-xs text-muted-foreground">
                右上角显示拓扑图预览，点击整块区域即可放大查看和编辑。
              </p>
            ) : null}
          </div>
          {!compact && draft ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={getPanelHeaderActionButtonClass()}
                onClick={() => {
                  setExpandedOpen(true);
                }}
              >
                放大查看
              </button>
            </div>
          ) : null}
      </header>

      <div
        className={
          compact || !showEdgeList
            ? "min-h-0 flex-1 px-2.5 pb-1.5 pt-1.5"
            : "grid min-h-0 flex-1 grid-rows-[320px_minmax(0,1fr)] gap-3 px-2.5 pb-1.5 pt-1.5"
        }
      >
        {compact ? (
          <button
            type="button"
            onClick={() => setExpandedOpen(true)}
            className="group relative block h-full min-h-0 w-full overflow-hidden rounded-[8px] text-left"
          >
            <div className="pointer-events-none h-full w-full">
              <BottomAnchoredFlow
                nodes={nodes}
                edges={edges}
                edgeTypes={edgeTypes}
                fitPadding={PREVIEW_FIT_PADDING}
                horizontalInsetLeft={MAIN_FLOW_LEFT_INSET}
                horizontalInsetRight={MAIN_FLOW_RIGHT_INSET}
                topInset={MAIN_FLOW_TOP_INSET}
                bottomInset={MAIN_FLOW_BOTTOM_INSET}
                framed={false}
              />
            </div>
            <div className="pointer-events-none absolute right-3 top-3">
              <span className="rounded-[6px] bg-white/90 px-3 py-1 text-[11px] text-foreground/75 shadow-sm transition group-hover:bg-primary group-hover:text-primary-foreground">
                点击放大
              </span>
            </div>
          </button>
        ) : (
          <div ref={mainViewportRef} className="min-h-0 h-full">
            <BottomAnchoredFlow
              nodes={nodes}
              edges={edges}
              edgeTypes={edgeTypes}
              fitPadding={MAIN_FIT_PADDING}
              horizontalInsetLeft={MAIN_FLOW_LEFT_INSET}
              horizontalInsetRight={MAIN_FLOW_RIGHT_INSET}
              topInset={MAIN_FLOW_TOP_INSET}
              bottomInset={MAIN_FLOW_BOTTOM_INSET}
              framed={false}
              onNodeClick={(_event, node) => {
                onSelectAgent(node.id);
                setEditingAgentId(node.id);
              }}
              onNodeMouseEnter={(_event, node) => {
                setHoveredAgentId(node.id);
              }}
              onNodeMouseLeave={() => {
                setHoveredAgentId(null);
              }}
            />
          </div>
        )}

        {compact || !showEdgeList ? null : (
          <div className="min-h-0 rounded-[8px] border border-border/70 bg-card/80 p-4">
            <div className="mb-3">
              <p className="font-semibold text-primary">传递关系</p>
            </div>
            <div className="max-h-full space-y-2 overflow-y-auto">
              {(draft?.edges ?? []).map((edge) => (
                <button
                  key={createEdgeId(edge.source, edge.target, edge.triggerOn)}
                  type="button"
                  onClick={() => {
                    onSelectAgent(edge.source);
                    setEditingAgentId(edge.source);
                  }}
                  className="flex w-full items-center justify-between gap-3 rounded-[8px] border border-border/60 bg-white/70 px-3 py-2 text-left text-sm transition hover:border-primary"
                >
                  <span className="truncate">
                    {getAgentDisplayName(edge.source)} {"->"} {getAgentDisplayName(edge.target)}
                  </span>
                  <span className="rounded-[6px] bg-muted px-2.5 py-1 text-[11px]">
                    {getEdgeTriggerLabel(edge.triggerOn)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <Dialog.Root open={expandedOpen} onOpenChange={setExpandedOpen}>
      <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/25" />
          <Dialog.Content className="PANEL-surface fixed left-1/2 top-1/2 h-[96vh] w-[98.5vw] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[10px] p-6">
            <div className="flex h-full min-h-0 flex-col">
              <div className="mb-4 flex items-start justify-between gap-4">
                <div>
                  <Dialog.Title className="font-display text-2xl font-bold text-primary">
                    拓扑图
                  </Dialog.Title>
                  <Dialog.Description className="mt-1 text-sm text-muted-foreground">
                    这里是放大版拓扑图。运行中的 Agent 会在节点内显示实时工具调用和消息摘要。
                  </Dialog.Description>
                </div>
                <div className="flex items-center gap-2">
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      className="rounded-[8px] border border-border bg-card px-4 py-2 text-sm text-foreground transition hover:border-primary"
                    >
                      关闭
                    </button>
                  </Dialog.Close>
                </div>
              </div>

              <div ref={expandedViewportRef} className="min-h-0 flex-1 overflow-hidden rounded-[8px]">
                <BottomAnchoredFlow
                  nodes={expandedNodes}
                  edges={edges}
                  edgeTypes={edgeTypes}
                  fitPadding={EXPANDED_FIT_PADDING}
                  horizontalInsetLeft={EXPANDED_FLOW_LEFT_INSET}
                  horizontalInsetRight={EXPANDED_FLOW_RIGHT_INSET}
                  topInset={EXPANDED_FLOW_TOP_INSET}
                  bottomInset={EXPANDED_FLOW_BOTTOM_INSET}
                  framed={false}
                  preserveLayoutViewport
                  onNodeClick={(_event, node) => {
                    onSelectAgent(node.id);
                    setEditingAgentId(node.id);
                  }}
                  onNodeMouseEnter={(_event, node) => {
                    setHoveredAgentId(node.id);
                  }}
                  onNodeMouseLeave={() => {
                    setHoveredAgentId(null);
                  }}
                />
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={!!editingAgentId} onOpenChange={(open) => !open && setEditingAgentId(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/25" />
          <Dialog.Content className="PANEL-surface fixed left-1/2 top-1/2 w-[min(640px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-[10px] p-6">
            <Dialog.Title className="font-display text-2xl font-bold text-primary">
              {editingAgentId ? getAgentDisplayName(editingAgentId) : "Agent"} 下游配置
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-muted-foreground">
              这里编辑的是 Project 级拓扑关系，不是 Agent 原始配置文件。
            </Dialog.Description>

            <div className="mt-5 rounded-[8px] border border-border bg-card/70 px-4 py-3">
              <p className="text-sm font-semibold text-primary">
                {getAgentDisplayName(editingAgent?.name ?? editingAgentId ?? "Agent")}
              </p>
            </div>

            <div className="mt-5 rounded-[8px] border border-border/70 bg-[#f8f4ea] px-4 py-3 text-xs text-muted-foreground">
              <p className="font-semibold text-primary">关系类型</p>
              <p className="mt-1">传递：上游 Agent 正常完成本轮任务后，直接传递到下游。</p>
              <p className="mt-1">审视通过：上游 Agent 给出审查通过结论后，才传递到下游。</p>
              <p className="mt-1">审视不通过：上游 Agent 明确要求继续回应当前内容后，才传递到下游。</p>
            </div>

            <div className="mt-5 space-y-2">
              {project?.agentFiles
                .filter((agent) => agent.name !== editingAgentId)
                .map((agent) => {
                  const selectedTriggers =
                    downstreamTriggersByTarget.get(agent.name) ?? new Set<TopologyEdge["triggerOn"]>();
                  const selectedLabels = [...selectedTriggers].map((trigger) => getEdgeTriggerLabel(trigger));
                  return (
                    <div
                      key={agent.name}
                      className="flex items-center justify-between gap-4 rounded-[8px] border border-border px-4 py-3"
                    >
                      <div>
                        <p className="text-sm font-semibold text-foreground">
                          {getAgentDisplayName(agent.name)}
                        </p>
                        {selectedLabels.length > 0 ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            已启用：{selectedLabels.join(" / ")}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex min-w-[220px] flex-wrap justify-end gap-2">
                        {(["association", "review_pass", "review_fail"] as TopologyEdge["triggerOn"][]).map((trigger) => {
                          const selected = selectedTriggers.has(trigger);
                          return (
                            <button
                              key={trigger}
                              type="button"
                              onClick={() => {
                                void setDownstreamTrigger(agent.name, trigger, !selected);
                              }}
                              className={`rounded-[8px] border px-3 py-2 text-sm transition ${
                                selected
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "border-border/70 bg-white/90 text-foreground hover:border-primary"
                              }`}
                              title={getEdgeTriggerDescription(trigger)}
                            >
                              {getEdgeTriggerLabel(trigger)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
            </div>

            <div className="mt-5 flex justify-end">
              <Dialog.Close asChild>
                <button type="button" className="rounded-[8px] border border-border px-4 py-2 text-sm">
                  关闭
                </button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={!!selectedHistoryRecord}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedHistoryRecord(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/30" />
          <Dialog.Content className="PANEL-surface fixed left-1/2 top-1/2 flex max-h-[82vh] w-[min(760px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[10px] p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <Dialog.Title className="font-display text-2xl font-bold text-primary">
                  历史消息
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-muted-foreground">
                  {selectedHistoryRecord
                    ? `${selectedHistoryRecord.agentName} · ${selectedHistoryRecord.label}${selectedHistoryRecord.timestamp ? ` · ${selectedHistoryRecord.timestamp}` : ""}`
                    : "查看完整历史消息"}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-[8px] border border-border bg-card px-4 py-2 text-sm text-foreground transition hover:border-primary"
                >
                  关闭
                </button>
              </Dialog.Close>
            </div>

            <div className="mt-5 min-h-0 flex-1 overflow-y-auto rounded-[8px] border border-border/70 bg-card/70 px-5 py-4">
              <p className="whitespace-pre-wrap break-words text-[15px] leading-8 text-foreground">
                {selectedHistoryRecord?.content}
              </p>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {hoveredHistoryPreview && !selectedHistoryRecord && typeof document !== "undefined"
        ? createPortal(
            <div
              className="pointer-events-none fixed inset-0"
              style={{
                zIndex: 2147483647,
                isolation: "isolate",
              }}
            >
              <div
                className="pointer-events-none absolute flex max-h-[min(320px,72vh)] w-[min(420px,calc(100vw-32px))] flex-col rounded-[10px] border border-border/80 bg-[#fffaf2]/95 p-4 shadow-[0_22px_54px_rgba(44,74,63,0.2)]"
                style={{
                  left: hoveredHistoryPreview.x,
                  top: hoveredHistoryPreview.y,
                }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-display text-[1.1rem] font-bold text-primary">历史消息</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {`${hoveredHistoryPreview.agentName} · ${hoveredHistoryPreview.label}${
                        hoveredHistoryPreview.timestamp ? ` · ${hoveredHistoryPreview.timestamp}` : ""
                      }`}
                    </p>
                  </div>
                  <span className="rounded-full bg-card/90 px-2.5 py-1 text-[10px] font-semibold tracking-[0.08em] text-foreground/70">
                    悬停预览
                  </span>
                </div>

                <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-[8px] border border-border/60 bg-card/75 px-4 py-3">
                  <p className="whitespace-pre-wrap break-words text-[13px] leading-6 text-foreground">
                    {hoveredHistoryPreview.content}
                  </p>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}
