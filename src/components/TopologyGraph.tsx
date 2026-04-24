import { useEffect, useMemo, useRef, useState } from "react";
import { withOptionalValue } from "@shared/object-utils";
import { getAgentColorToken } from "@/lib/agent-colors";
import { buildAgentHistoryItems, type AgentHistoryItem } from "@/lib/agent-history";
import { AgentHistoryMarkdown } from "@/lib/agent-history-markdown";
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
  getTopologyLoopLimitFailedReviewerName,
  getTopologyNodeHeaderActionOrder,
  type TopologyAgentStatusBadgePresentation,
} from "@/components/topology-graph-helpers";
import { getTopologyDisplayNodeIds } from "@/components/topology-spawn-drafts";
import { buildTopologyCanvasLayout } from "@/lib/topology-canvas";
import { selectTopologyHistoryItemsForDisplay } from "@/lib/topology-history-items";
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
      className="h-3.5 w-3.5"
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
  const [selectedHistoryItem, setSelectedHistoryItem] = useState<SelectedHistoryItemState | null>(null);
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
  }, [topology?.nodes.length, topology?.nodeRecords?.length]);

  const visibleNodeIds = useMemo(
    () => (topology ? getTopologyDisplayNodeIds(topology, visibleTopologyCandidateNodeIds) : []),
    [topology, visibleTopologyCandidateNodeIds],
  );
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
    if (!topology) {
      return new Map<string, AgentHistoryItem[]>();
    }

    if (!task || visibleNodeIds.length === 0) {
      return new Map<string, AgentHistoryItem[]>();
    }

    return new Map(
      visibleNodeIds.map((agentId) => [
        agentId,
        selectTopologyHistoryItemsForDisplay(buildAgentHistoryItems(withOptionalValue({
          agentId: agentId,
          messages: task.messages,
          topology,
        }, "runtimeSnapshot", runtimeSnapshots[agentId]))),
      ]),
    );
  }, [runtimeSnapshots, task, topology, visibleNodeIds]);
  const finalLoopReviewerName = useMemo(
    () => (task ? getTopologyLoopLimitFailedReviewerName(task.messages) : null),
    [task],
  );

  useEffect(() => {
    if (!selectedHistoryItem) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedHistoryItem(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedHistoryItem]);

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
              const taskAgent = taskAgents.get(node.id);
              const runtimeSnapshot = runtimeSnapshots[node.id];
              const color = getAgentColorToken(node.id);
              const historyItems = historyByAgent.get(node.id) ?? [];
              const statusBadge = getTopologyAgentStatusBadgePresentation(
                topology,
                node.id,
                resolveTopologyNodeDisplayStatus({
                  ...withOptionalValue({}, "taskAgentStatus", taskAgent?.status),
                  ...withOptionalValue(
                    {},
                    "runtimeSnapshotStatus",
                    runtimeSnapshot?.runtimeStatus ?? runtimeSnapshot?.status,
                  ),
                }),
                {
                  finalLoopReviewerName,
                },
              );
              const showAttachButton = typeof onOpenAgentTerminal === "function";
              const headerActions = getTopologyNodeHeaderActionOrder({
                showAttachButton,
              });
              const isAttachOpening = openingAgentTerminalId === node.id;
              const attachDisabled = !taskAgent?.opencodeSessionId || isAttachOpening;
              const attachTitle = taskAgent?.opencodeSessionId
                ? (isAttachOpening ? `正在打开 ${node.id} 的 attach 终端` : `attach 到 ${node.id}`)
                : `${node.id} 当前还没有可 attach 的 OpenCode session。`;
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
                                className="inline-flex h-7 items-center justify-center gap-1 rounded-full border border-[#d8cdbd] bg-[#fffaf2] px-2.5 text-[11px] font-semibold text-foreground/76 shadow-[0_1px_0_rgba(255,255,255,0.45)] transition hover:border-[#cda27d] hover:bg-white disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-[#d8cdbd] disabled:hover:bg-[#fffaf2]"
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
                                content={item.previewDetail}
                                className="mt-1 text-[11px] leading-[1.35] opacity-90 select-text"
                              />
                            </div>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <div className="flex h-full items-center justify-center rounded-[10px] border border-dashed border-border/70 bg-background/45 text-sm text-muted-foreground">
                        待启动
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {selectedHistoryItem ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/28 px-6 py-6"
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
        </div>
      ) : null}
    </section>
  );
}
