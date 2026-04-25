import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { withOptionalValue } from "@shared/object-utils";
import { getAgentColorToken } from "@/lib/agent-colors";
import { buildAgentHistoryItems, type AgentHistoryItem } from "@/lib/agent-history";
import { AgentHistoryMarkdown } from "@/lib/agent-history-markdown";
import { resolveFullscreenOverlayStrategy } from "@/lib/fullscreen-overlay-strategy";
import { getTopologyHistoryItemButtonClassName } from "@/lib/topology-history-layout";
import {
  shouldAutoScrollTopologyHistory,
  shouldStickTopologyHistoryToBottom,
} from "@/lib/topology-history-scroll";
import {
  PANEL_HEADER_CLASS,
  PANEL_HEADER_LEADING_CLASS,
  PANEL_HEADER_TITLE_CLASS,
  PANEL_SURFACE_CLASS,
} from "@/lib/panel-header";
import { PANEL_HEADER_ACTION_BUTTON_CLASS } from "@/lib/panel-header-action-button";
import { getPanelFullscreenButtonCopy } from "@/lib/panel-fullscreen-label";
import {
  getTopologyAgentStatusBadgePresentation,
  getTopologyLoopLimitFailedDecisionAgentName,
  getTopologyNodeHeaderActionOrder,
  type TopologyAgentStatusBadgePresentation,
} from "@/components/topology-graph-helpers";
import { getTopologyDisplayNodeIds } from "@/components/topology-spawn-drafts";
import { buildTopologyCanvasLayout } from "@/lib/topology-canvas";
import { getTopologyCanvasViewportMeasurementKey } from "@/lib/topology-canvas-viewport-measure";
import {
  filterTopologyAgentIdsWithDisplayableHistory,
  selectTopologyHistoryItemsForDisplay,
} from "@/lib/topology-history-items";
import { getTopologyPanelBodyClassName } from "@/lib/topology-panel-layout";
import type {
  AgentRuntimeSnapshot,
  TaskSnapshot,
  WorkspaceSnapshot,
} from "@shared/types";

interface TopologyGraphProps {
  workspace: WorkspaceSnapshot;
  task: TaskSnapshot;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  isMaximized?: boolean;
  onToggleMaximize?: () => void;
  openingAgentTerminalId?: string | null;
  onOpenAgentTerminal?: (agentId: string) => void;
  runtimeSnapshots?: Record<string, AgentRuntimeSnapshot>;
}

const NODE_WIDTH = 248;
const NODE_HEIGHT = 308;

interface SelectedHistoryItemState {
  agentId: string;
  color: ReturnType<typeof getAgentColorToken>;
  item: AgentHistoryItem;
}

interface TopologyNodePresentation {
  color: ReturnType<typeof getAgentColorToken>;
  historyItems: AgentHistoryItem[];
  statusBadge: TopologyAgentStatusBadgePresentation;
  headerActions: ReturnType<typeof getTopologyNodeHeaderActionOrder>;
  isAttachOpening: boolean;
  attachDisabled: boolean;
  attachTitle: string;
  agentFullscreenButtonCopy: ReturnType<typeof getPanelFullscreenButtonCopy>;
}

const TOPOLOGY_VIEWPORT_OVERLAY_STRATEGY = resolveFullscreenOverlayStrategy({
  ancestorCssEffects: ["backdrop-filter"],
});

function getHistoryItemClassName(item: AgentHistoryItem) {
  switch (item.tone) {
    case "failure":
      return "border-rose-200 bg-rose-50 text-rose-900";
    case "runtime-tool":
      return "border-amber-200 bg-amber-50 text-amber-900";
    case "runtime-thinking":
      return "border-slate-200 bg-slate-50 text-slate-800";
    case "runtime-step":
      return "border-sky-200 bg-sky-50 text-sky-900";
    case "runtime-message":
      return "border-emerald-200 bg-emerald-50 text-emerald-900";
    default:
      return "border-emerald-200 bg-emerald-50 text-emerald-900";
  }
}

function formatHistoryTimestamp(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function resolveTopologyNodeDisplayStatus(input: {
  taskAgentStatus?: string;
  runtimeSnapshotStatus?: string;
}) {
  if (input.runtimeSnapshotStatus === "running") {
    return "running";
  }
  return input.taskAgentStatus ?? input.runtimeSnapshotStatus ?? "idle";
}

function renderStatusBadgeIcon(presentation: TopologyAgentStatusBadgePresentation) {
  if (presentation.icon === "idle") {
    return (
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
    );
  }

  if (presentation.icon === "running") {
    return (
      <svg
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none origin-center [transform-box:fill-box]"
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
    );
  }

  if (presentation.icon === "success") {
    return (
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
    );
  }

  if (presentation.icon === "continue") {
    return (
      <svg
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12.6 8A4.6 4.6 0 1 1 8 3.4" />
        <path d="M8 1.9h4v4" />
        <path d="M12 2 8.9 5.1" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 5 11 11" />
      <path d="M11 5 5 11" />
    </svg>
  );
}

function renderAttachButtonIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.25" y="3" width="11.5" height="10" rx="2" />
      <path d="m5.2 7.1 2 1.9-2 2" />
      <path d="M8.9 11h2.1" />
    </svg>
  );
}

export function TopologyGraph({
  workspace,
  task,
  selectedAgentId: _selectedAgentId,
  onSelectAgent,
  isMaximized = false,
  onToggleMaximize,
  openingAgentTerminalId = null,
  onOpenAgentTerminal,
  runtimeSnapshots = {},
}: TopologyGraphProps) {
  const topologyPanelBodyClassName = getTopologyPanelBodyClassName();
  const fullscreenButtonCopy = getPanelFullscreenButtonCopy(isMaximized);
  const canvasViewportRef = useRef<HTMLDivElement | null>(null);
  const historyViewportRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const historyShouldStickToBottomRef = useRef<Record<string, boolean>>({});
  const historyLastItemIdRef = useRef<Record<string, string | null>>({});
  const [canvasViewport, setCanvasViewport] = useState<{ width: number; height: number } | null>(null);
  const [maximizedAgentId, setMaximizedAgentId] = useState<string | null>(null);
  const [selectedHistoryItem, setSelectedHistoryItem] = useState<SelectedHistoryItemState | null>(null);

  function renderViewportOverlay(content: ReactNode) {
    if (
      TOPOLOGY_VIEWPORT_OVERLAY_STRATEGY.mountTarget === "body-portal" &&
      typeof document !== "undefined" &&
      document.body
    ) {
      return createPortal(content, document.body);
    }

    return content;
  }

  const topology = task?.topology ?? workspace?.topology;
  const taskAgents = useMemo(
    () => new Map(task?.agents.map((agent) => [agent.id, agent]) ?? []),
    [task?.agents],
  );
  const visibleTopologyCandidateNodeIds = useMemo(
    () => Array.from(new Set([
      ...(task?.agents.map((agent) => agent.id) ?? []),
      ...Object.keys(runtimeSnapshots),
    ])),
    [runtimeSnapshots, task?.agents],
  );

  const orderedNodeIds = useMemo(
    () => (topology ? getTopologyDisplayNodeIds(topology, visibleTopologyCandidateNodeIds) : []),
    [topology, visibleTopologyCandidateNodeIds],
  );
  const rawHistoryByAgent = useMemo(() => {
    if (!topology) {
      return new Map<string, AgentHistoryItem[]>();
    }

    if (!task || orderedNodeIds.length === 0) {
      return new Map<string, AgentHistoryItem[]>();
    }

    return new Map(
      orderedNodeIds.map((agentId) => [
        agentId,
        selectTopologyHistoryItemsForDisplay(buildAgentHistoryItems(withOptionalValue({
          agentId: agentId,
          messages: task.messages,
          topology,
        }, "runtimeSnapshot", runtimeSnapshots[agentId]))),
      ]),
    );
  }, [orderedNodeIds, runtimeSnapshots, task, topology]);
  const visibleNodeIds = useMemo(
    () => filterTopologyAgentIdsWithDisplayableHistory(orderedNodeIds, rawHistoryByAgent),
    [orderedNodeIds, rawHistoryByAgent],
  );
  const canvasViewportMeasurementKey = useMemo(
    () => getTopologyCanvasViewportMeasurementKey({
      topologyNodeCount: topology?.nodes.length ?? 0,
      topologyNodeRecordCount: topology?.nodeRecords?.length ?? 0,
      hasRenderableCanvas: Boolean(topology && visibleNodeIds.length > 0),
    }),
    [topology, visibleNodeIds.length],
  );

  useEffect(() => {
    const element = canvasViewportRef.current;
    if (!element) {
      return;
    }

    const updateViewport = (width: number, height: number) => {
      setCanvasViewport((current) => {
        const next = {
          width: Math.max(0, Math.floor(width)),
          height: Math.max(0, Math.floor(height)),
        };
        if (current?.width === next.width && current?.height === next.height) {
          return current;
        }
        return next;
      });
    };

    updateViewport(element.clientWidth, element.clientHeight);

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      updateViewport(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [canvasViewportMeasurementKey]);
  const canvasLayout = useMemo(() => {
    if (!topology || visibleNodeIds.length === 0) {
      return null;
    }

    return buildTopologyCanvasLayout({
      nodes: visibleNodeIds,
      edges: topology.edges,
      ...withOptionalValue({}, "availableWidth", canvasViewport?.width),
      ...withOptionalValue({}, "availableHeight", canvasViewport?.height),
      columnWidth: NODE_WIDTH,
      minNodeWidth: NODE_WIDTH,
      minNodeHeight: NODE_HEIGHT,
      columnGap: 18,
      sidePadding: 0,
      topPadding: 0,
      bottomPadding: 0,
      nodeHeight: NODE_HEIGHT,
    });
  }, [canvasViewport?.height, canvasViewport?.width, topology, visibleNodeIds]);
  const historyByAgent = useMemo(() => {
    return new Map(
      visibleNodeIds.map((agentId) => [agentId, rawHistoryByAgent.get(agentId) ?? []]),
    );
  }, [rawHistoryByAgent, visibleNodeIds]);
  const finalLoopDecisionAgentName = useMemo(
    () => (task ? getTopologyLoopLimitFailedDecisionAgentName(task.messages) : null),
    [task],
  );

  useEffect(() => {
    if (!selectedHistoryItem && !maximizedAgentId) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      if (selectedHistoryItem) {
        setSelectedHistoryItem(null);
        return;
      }

      setMaximizedAgentId(null);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [maximizedAgentId, selectedHistoryItem]);

  useEffect(() => {
    if (!topology) {
      historyViewportRefs.current = {};
      historyShouldStickToBottomRef.current = {};
      historyLastItemIdRef.current = {};
      return;
    }

    const activeNodeIds = new Set(visibleNodeIds);
    for (const nodeId of Object.keys(historyViewportRefs.current)) {
      if (!activeNodeIds.has(nodeId)) {
        delete historyViewportRefs.current[nodeId];
      }
    }
    for (const nodeId of Object.keys(historyShouldStickToBottomRef.current)) {
      if (!activeNodeIds.has(nodeId)) {
        delete historyShouldStickToBottomRef.current[nodeId];
      }
    }
    for (const nodeId of Object.keys(historyLastItemIdRef.current)) {
      if (!activeNodeIds.has(nodeId)) {
        delete historyLastItemIdRef.current[nodeId];
      }
    }
  }, [topology, visibleNodeIds]);

  useEffect(() => {
    if (!topology || visibleNodeIds.length === 0) {
      return;
    }

    const frameIds: number[] = [];

    for (const nodeId of visibleNodeIds) {
      const historyItems = historyByAgent.get(nodeId) ?? [];
      const nextLastItemId = historyItems.at(-1)?.id ?? null;
      const previousLastItemId = historyLastItemIdRef.current[nodeId] ?? null;
      const shouldStickToBottom = historyShouldStickToBottomRef.current[nodeId] ?? true;

      if (
        shouldAutoScrollTopologyHistory({
          previousLastItemId,
          nextLastItemId,
          shouldStickToBottom,
        })
      ) {
        frameIds.push(
          requestAnimationFrame(() => {
            const viewport = historyViewportRefs.current[nodeId];
            if (!viewport) {
              return;
            }
            viewport.scrollTop = viewport.scrollHeight;
          }),
        );
      }

      historyLastItemIdRef.current[nodeId] = nextLastItemId;
    }

    return () => {
      for (const frameId of frameIds) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [historyByAgent, topology, visibleNodeIds]);

  useEffect(() => {
    if (!maximizedAgentId) {
      return;
    }

    if (!visibleNodeIds.includes(maximizedAgentId)) {
      setMaximizedAgentId(null);
    }
  }, [maximizedAgentId, visibleNodeIds]);

  function buildNodePresentation(agentId: string): TopologyNodePresentation {
    const taskAgent = taskAgents.get(agentId);
    const runtimeSnapshot = runtimeSnapshots[agentId];
    const color = getAgentColorToken(agentId);
    const historyItems = historyByAgent.get(agentId) ?? [];
    const statusBadge = getTopologyAgentStatusBadgePresentation(
      topology!,
      agentId,
      resolveTopologyNodeDisplayStatus({
        ...withOptionalValue({}, "taskAgentStatus", taskAgent?.status),
        ...withOptionalValue(
          {},
          "runtimeSnapshotStatus",
          runtimeSnapshot?.runtimeStatus ?? runtimeSnapshot?.status,
        ),
      }),
      {
        finalLoopDecisionAgentName,
      },
    );
    const showAttachButton = typeof onOpenAgentTerminal === "function";
    const headerActions = getTopologyNodeHeaderActionOrder({
      showFullscreenButton: true,
      showAttachButton,
    });
    const isAttachOpening = openingAgentTerminalId === agentId;
    const attachDisabled = !taskAgent?.opencodeSessionId || isAttachOpening;
    const attachTitle = taskAgent?.opencodeSessionId
      ? (isAttachOpening ? `正在打开 ${agentId} 的 attach 终端` : `attach 到 ${agentId}`)
      : `${agentId} 当前还没有可 attach 的 OpenCode session。`;
    return {
      color,
      historyItems,
      statusBadge,
      headerActions,
      isAttachOpening,
      attachDisabled,
      attachTitle,
      agentFullscreenButtonCopy: getPanelFullscreenButtonCopy(maximizedAgentId === agentId),
    };
  }

  const maximizedNode = maximizedAgentId
    ? (canvasLayout?.nodes.find((node) => node.id === maximizedAgentId) ?? null)
    : null;
  const maximizedNodePresentation = maximizedNode ? buildNodePresentation(maximizedNode.id) : null;

  if (!workspace || !task || !topology || !canvasLayout) {
    return (
      <section className={PANEL_SURFACE_CLASS}>
        <header className={PANEL_HEADER_CLASS}>
          <div className={PANEL_HEADER_LEADING_CLASS}>
            <p className={PANEL_HEADER_TITLE_CLASS}>拓扑</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onToggleMaximize}
              className={`${PANEL_HEADER_ACTION_BUTTON_CLASS} no-drag`}
              aria-label={fullscreenButtonCopy.ariaLabel}
            >
              {fullscreenButtonCopy.label}
            </button>
          </div>
        </header>
        <div className={topologyPanelBodyClassName}>
          <div className="flex h-full min-h-0 items-center justify-center rounded-[8px] border border-border/60 bg-card/70 text-sm text-muted-foreground">
            当前还没有可展示的 Task 拓扑。
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={PANEL_SURFACE_CLASS}>
      <header className={PANEL_HEADER_CLASS}>
        <div className={PANEL_HEADER_LEADING_CLASS}>
          <p className={PANEL_HEADER_TITLE_CLASS}>拓扑</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleMaximize}
            className={`${PANEL_HEADER_ACTION_BUTTON_CLASS} no-drag`}
            aria-label={fullscreenButtonCopy.ariaLabel}
          >
            {fullscreenButtonCopy.label}
          </button>
        </div>
      </header>

      <div className={`relative flex-1 min-h-0 ${topologyPanelBodyClassName}`}>
        <div
          ref={canvasViewportRef}
          className="h-full min-h-0 w-full overflow-auto"
        >
          <div
            className="relative min-h-full min-w-full"
            style={{
              width: `${canvasLayout.width}px`,
              height: `${canvasLayout.height}px`,
            }}
          >
            {canvasLayout.nodes.map((node) => {
              const {
                color,
                historyItems,
                statusBadge,
                headerActions,
                isAttachOpening,
                attachDisabled,
                attachTitle,
                agentFullscreenButtonCopy,
              } = buildNodePresentation(node.id);
              return (
                <div
                  key={node.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectAgent(node.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelectAgent(node.id);
                    }
                  }}
                  className="absolute flex flex-col overflow-hidden rounded-[14px] text-left transition"
                  style={{
                    left: `${node.x}px`,
                    top: `${node.y}px`,
                    width: `${node.width}px`,
                    height: `${node.height}px`,
                    border: `1px solid ${color.border}`,
                    boxShadow: "0 12px 30px rgba(44, 74, 63, 0.08)",
                    background: "rgba(255,248,240,0.9)",
                  }}
                >
                  <div
                    className="border-b px-4 py-[3px]"
                    style={{
                      background: color.soft,
                      borderColor: color.border,
                    }}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p
                        title={node.id}
                        className="min-w-0 flex-1 truncate text-base font-semibold text-foreground"
                      >
                        {node.id}
                      </p>
                      <div className="shrink-0 flex items-center gap-2">
                        {headerActions.map((action) => {
                          if (action === "fullscreen") {
                            return (
                              <button
                                key={action}
                                type="button"
                                aria-label={`${agentFullscreenButtonCopy.ariaLabel} ${node.id} 详情`}
                                title={`${agentFullscreenButtonCopy.label}查看 ${node.id} 详情`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onSelectAgent(node.id);
                                  setMaximizedAgentId(node.id);
                                }}
                                className="inline-flex h-6 items-center justify-center rounded-full border border-[#d8cdbd] bg-[#fffaf2] px-2 text-[10px] font-semibold text-foreground/76 shadow-[0_1px_0_rgba(255,255,255,0.45)] transition hover:border-[#cda27d] hover:bg-white"
                              >
                                {agentFullscreenButtonCopy.label}
                              </button>
                            );
                          }

                          if (action === "attach") {
                            return (
                              <button
                                key={action}
                                type="button"
                                aria-label={`打开 ${node.id} 的 attach 终端`}
                                title={attachTitle}
                                disabled={attachDisabled}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (attachDisabled || !onOpenAgentTerminal) {
                                    return;
                                  }
                                  onOpenAgentTerminal(node.id);
                                }}
                                className="inline-flex h-6 items-center justify-center gap-1 rounded-full border border-[#d8cdbd] bg-[#fffaf2] px-2 text-[10px] font-semibold text-foreground/76 shadow-[0_1px_0_rgba(255,255,255,0.45)] transition hover:border-[#cda27d] hover:bg-white disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-[#d8cdbd] disabled:hover:bg-[#fffaf2]"
                              >
                                {renderAttachButtonIcon()}
                                <span>{isAttachOpening ? "打开中" : "attach"}</span>
                              </button>
                            );
                          }

                          return (
                            <span
                              key={action}
                              aria-label={statusBadge.label}
                              title={statusBadge.label}
                              className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold shadow-[0_1px_0_rgba(255,255,255,0.45)] ${statusBadge.className} ${statusBadge.effectClassName}`}
                            >
                              {renderStatusBadgeIcon(statusBadge)}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  <div className="min-h-0 flex-1 px-2 py-2">
                    {historyItems.length > 0 ? (
                      <div
                        ref={(element) => {
                          historyViewportRefs.current[node.id] = element;
                        }}
                        onScroll={(event) => {
                          historyShouldStickToBottomRef.current[node.id] =
                            shouldStickTopologyHistoryToBottom({
                              scrollHeight: event.currentTarget.scrollHeight,
                              clientHeight: event.currentTarget.clientHeight,
                              scrollTop: event.currentTarget.scrollTop,
                            });
                        }}
                        className="h-full space-y-1 overflow-y-auto"
                      >
                        {historyItems.map((item) => (
                          <article
                            key={item.id}
                            className={`${getTopologyHistoryItemButtonClassName()} ${getHistoryItemClassName(item)}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (window.getSelection()?.toString().trim()) {
                                return;
                              }
                              setSelectedHistoryItem({
                                agentId: node.id,
                                color,
                                item,
                              });
                            }}
                          >
                            <div className="min-w-0 flex-1 select-text">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[11px] font-semibold">{item.label}</span>
                                <span className="text-[11px] opacity-70">{formatHistoryTimestamp(item.timestamp)}</span>
                              </div>
                              <AgentHistoryMarkdown
                                content={item.detailSnippet}
                                className="mt-1 text-[11px] leading-[1.35] opacity-90 select-text"
                              />
                            </div>
                          </article>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {maximizedNode && maximizedNodePresentation ? renderViewportOverlay(
        <div
          className="fixed inset-0 z-[60] bg-black/28"
          onClick={() => setMaximizedAgentId(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`${maximizedNode.id} 全屏详情`}
            className="flex h-full w-full flex-col overflow-hidden bg-background"
            onClick={(event) => event.stopPropagation()}
          >
            <div
              className="border-b px-3 py-2"
              style={{
                background: maximizedNodePresentation.color.soft,
                borderColor: maximizedNodePresentation.color.border,
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-3">
                    <span
                      className="inline-flex max-w-full shrink-0 rounded-[10px] px-3 py-1 text-center text-[18px] font-semibold leading-[1.2] tracking-[0.02em]"
                      style={{
                        background: maximizedNodePresentation.color.solid,
                        color: maximizedNodePresentation.color.badgeText,
                      }}
                    >
                      {maximizedNode.id}
                    </span>
                    <span className="text-sm text-foreground/68">
                      {maximizedNodePresentation.statusBadge.label}
                    </span>
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-2">
                  {maximizedNodePresentation.headerActions.map((action) => {
                    if (action === "fullscreen") {
                      return (
                        <button
                          key={action}
                          type="button"
                          aria-label={`${maximizedNodePresentation.agentFullscreenButtonCopy.ariaLabel} ${maximizedNode.id} 详情`}
                          onClick={() => setMaximizedAgentId(null)}
                          className={`${PANEL_HEADER_ACTION_BUTTON_CLASS} no-drag`}
                        >
                          {maximizedNodePresentation.agentFullscreenButtonCopy.label}
                        </button>
                      );
                    }

                    if (action === "attach") {
                      return (
                        <button
                          key={action}
                          type="button"
                          aria-label={`打开 ${maximizedNode.id} 的 attach 终端`}
                          title={maximizedNodePresentation.attachTitle}
                          disabled={maximizedNodePresentation.attachDisabled}
                          onClick={() => {
                            if (maximizedNodePresentation.attachDisabled || !onOpenAgentTerminal) {
                              return;
                            }
                            onOpenAgentTerminal(maximizedNode.id);
                          }}
                          className="inline-flex h-8 items-center justify-center gap-1 rounded-full border border-[#d8cdbd] bg-[#fffaf2] px-3 text-[12px] font-semibold text-foreground/76 shadow-[0_1px_0_rgba(255,255,255,0.45)] transition hover:border-[#cda27d] hover:bg-white disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-[#d8cdbd] disabled:hover:bg-[#fffaf2]"
                        >
                          {renderAttachButtonIcon()}
                          <span>{maximizedNodePresentation.isAttachOpening ? "打开中" : "attach"}</span>
                        </button>
                      );
                    }

                    return (
                      <span
                        key={action}
                        aria-label={maximizedNodePresentation.statusBadge.label}
                        title={maximizedNodePresentation.statusBadge.label}
                        className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-semibold shadow-[0_1px_0_rgba(255,255,255,0.45)] ${maximizedNodePresentation.statusBadge.className} ${maximizedNodePresentation.statusBadge.effectClassName}`}
                      >
                        {renderStatusBadgeIcon(maximizedNodePresentation.statusBadge)}
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
              {maximizedNodePresentation.historyItems.length > 0 ? (
                <div className="space-y-1.5">
                  {maximizedNodePresentation.historyItems.map((item) => (
                    <article
                      key={item.id}
                      className={`rounded-[12px] border px-2 py-1.5 ${getHistoryItemClassName(item)}`}
                    >
                      <div className="min-w-0 flex-1 select-text">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-[13px] font-semibold">{item.label}</span>
                          <span className="text-[12px] opacity-70">{formatHistoryTimestamp(item.timestamp)}</span>
                        </div>
                        <AgentHistoryMarkdown
                          content={item.detail}
                          className="mt-1 text-[13px] leading-[1.5] text-inherit opacity-95 select-text"
                        />
                      </div>
                    </article>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>,
      ) : null}

      {selectedHistoryItem ? renderViewportOverlay(
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/28 px-6 py-6"
          onClick={() => setSelectedHistoryItem(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`${selectedHistoryItem.agentId} 历史详情`}
            className="flex max-h-[min(82vh,720px)] w-full max-w-[720px] flex-col overflow-hidden rounded-[14px] border bg-background shadow-[0_24px_80px_rgba(23,32,25,0.22)]"
            style={{
              borderColor: selectedHistoryItem.color.border,
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              className="flex items-center justify-between gap-3 border-b px-5 py-3"
              style={{
                background: selectedHistoryItem.color.soft,
                borderColor: selectedHistoryItem.color.border,
              }}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-flex max-w-full shrink-0 rounded-[8px] px-2 py-px text-center text-[14px] font-semibold leading-[1.2] tracking-[0.02em]"
                    style={{
                      background: selectedHistoryItem.color.solid,
                      color: selectedHistoryItem.color.badgeText,
                    }}
                  >
                    {selectedHistoryItem.agentId}
                  </span>
                  <span className="text-sm font-semibold text-foreground/86">
                    {selectedHistoryItem.item.label}
                  </span>
                </div>
                <p className="mt-1 text-xs text-foreground/60">
                  {formatHistoryTimestamp(selectedHistoryItem.item.timestamp)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedHistoryItem(null)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border/70 bg-background/90 text-lg leading-none text-foreground/68 transition hover:bg-background"
                aria-label="关闭历史详情"
              >
                ×
              </button>
            </div>

            <div className="min-h-0 overflow-y-auto px-5 py-4">
              <AgentHistoryMarkdown
                content={selectedHistoryItem.item.detail}
                className="text-[14px] leading-[1.35] text-foreground/84"
              />
            </div>
          </div>
        </div>,
      ) : null}
    </section>
  );
}
