import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  resolveAgentAttachButtonState,
  resolveSessionStateFromSessionIdText,
} from "@/lib/agent-attach-state";
import { getAgentColorToken } from "@/lib/agent-colors";
import {
  buildAgentFinalHistoryItems,
  type AgentHistoryItem,
} from "@/lib/agent-history";
import {
  AGENT_HISTORY_DETAIL_TEXT_CLASS,
  AGENT_HISTORY_META_TEXT_CLASS,
} from "@/lib/agent-history-display";
import { AgentHistoryMarkdown } from "@/lib/agent-history-markdown";
import { getTopologyHistoryItemButtonClassName } from "@/lib/topology-history-layout";
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
  getTopologyNodeHeaderActionOrder,
  type TopologyAgentStatusBadgePresentation,
} from "@/components/topology-graph-helpers";
import { getTopologyDisplayNodeIds } from "@/components/topology-group-drafts";
import { buildTopologyCanvasLayout } from "@/lib/topology-canvas";
import { getTopologyCanvasViewportMeasurementKey } from "@/lib/topology-canvas-viewport-measure";
import { createTopologyHistoryAutoScrollTracker } from "@/lib/topology-history-scroll";
import { getTopologyPanelBodyClassName } from "@/lib/topology-panel-layout";
import type {
  AgentStatus,
  TaskAgentRecord,
  TaskSnapshot,
  TaskStatus,
  UtcIsoTimestamp,
} from "@shared/types";

interface TopologyGraphProps {
  task: TaskSnapshot;
  isMaximized: boolean;
  onOpenSystemPromptPanel: () => void;
  onToggleMaximize: () => void;
  onOpenAgentTerminal: (agentId: string) => void;
}

const NODE_WIDTH = 248;
const NODE_HEIGHT = 308;
const TOPOLOGY_PENDING_RESULT_COPY = "正在执行，暂无结果";
const TOPOLOGY_SYNC_PENDING_COPY = "等待最终结果同步";
const TOPOLOGY_FAILED_RESULT_COPY = "执行失败，暂无可展示的最终结果";
const TOPOLOGY_MISSING_RESULT_COPY = "暂无可展示的最终结果";

type TopologyNodeContent =
  | {
      kind: "final-history";
      items: AgentHistoryItem[];
    }
  | {
      kind: "pending";
      copy: string;
    };

interface TopologyNodePresentation {
  color: ReturnType<typeof getAgentColorToken>;
  content: TopologyNodeContent;
  statusBadge: TopologyAgentStatusBadgePresentation;
  headerActions: ReturnType<typeof getTopologyNodeHeaderActionOrder>;
  attachDisabled: boolean;
  attachTitle: string;
}

function formatHistoryTimestamp(timestamp: UtcIsoTimestamp) {
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

function TopologyAgentHistoryList(input: {
  agentId: string;
  historyItems: AgentHistoryItem[];
}) {
  const historyScrollTrackerRef = useRef(createTopologyHistoryAutoScrollTracker());
  const lastHistoryItem = input.historyItems.at(-1);
  const historyTailVersion = lastHistoryItem
    ? `${input.historyItems.length}:${lastHistoryItem.sortTimestamp}`
    : "0:";
  const bindHistoryViewport = useCallback((viewport: HTMLDivElement | null) => {
    historyScrollTrackerRef.current.bindViewport(viewport);
  }, []);

  useEffect(() => () => {
    historyScrollTrackerRef.current.reset();
  }, []);

  useLayoutEffect(() => {
    const frameId = historyScrollTrackerRef.current.sync(historyTailVersion);
    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [historyTailVersion]);

  return (
    <div
      ref={bindHistoryViewport}
      onScroll={(event) => {
        historyScrollTrackerRef.current.updateStickState({
          scrollHeight: event.currentTarget.scrollHeight,
          clientHeight: event.currentTarget.clientHeight,
          scrollTop: event.currentTarget.scrollTop,
        });
      }}
      className="min-h-0 flex-1 overflow-y-auto"
      data-topology-history-viewport={input.agentId}
    >
      <div className="space-y-1">
        {input.historyItems.map((item, index) => (
          <article
            key={`${item.sortTimestamp}:${item.tone}:${item.label}:${index}`}
            className={`${getTopologyHistoryItemButtonClassName()} min-w-0 flex-none border-slate-200 bg-slate-50 text-slate-800`}
            data-topology-history-item={`${item.sortTimestamp}:${index}`}
          >
            <div className="min-w-0 flex-1 select-text">
              <div className="flex items-center justify-between gap-2">
                <span className={`${AGENT_HISTORY_META_TEXT_CLASS} font-semibold`}>
                  {item.label}
                </span>
                <span className={`${AGENT_HISTORY_META_TEXT_CLASS} opacity-70`}>
                  {formatHistoryTimestamp(item.timestamp)}
                </span>
              </div>
              <AgentHistoryMarkdown
                content={item.detailSnippet}
                className={AGENT_HISTORY_DETAIL_TEXT_CLASS}
                style={{ marginTop: "0.125rem" }}
              />
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function resolveTopologyNodeContent(input: {
  agentId: string;
  messages: TaskSnapshot["messages"];
  topology: TaskSnapshot["topology"];
  taskStatus: TaskStatus;
  agentStatus: AgentStatus;
}): TopologyNodeContent {
  const finalHistoryItems = buildAgentFinalHistoryItems({
    agentId: input.agentId,
    messages: input.messages,
    topology: input.topology,
  });

  if (finalHistoryItems.length > 0) {
    return {
      kind: "final-history",
      items: finalHistoryItems,
    };
  }

  if (input.taskStatus === "running" && input.agentStatus === "running") {
    return {
      kind: "pending",
      copy: TOPOLOGY_PENDING_RESULT_COPY,
    };
  }

  if (input.taskStatus === "running" && input.agentStatus === "completed") {
    return {
      kind: "pending",
      copy: TOPOLOGY_SYNC_PENDING_COPY,
    };
  }

  if (input.agentStatus === "failed" || input.taskStatus === "failed") {
    return {
      kind: "pending",
      copy: TOPOLOGY_FAILED_RESULT_COPY,
    };
  }

  return {
    kind: "pending",
    copy: TOPOLOGY_MISSING_RESULT_COPY,
  };
}

function renderStatusBadgeIcon(
  presentation: TopologyAgentStatusBadgePresentation,
) {
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
  task,
  isMaximized,
  onOpenSystemPromptPanel,
  onToggleMaximize,
  onOpenAgentTerminal,
}: TopologyGraphProps) {
  const topologyPanelBodyClassName = getTopologyPanelBodyClassName();
  const fullscreenButtonCopy = getPanelFullscreenButtonCopy(isMaximized);
  const canvasViewportRef = useRef<HTMLDivElement | null>(null);
  const [canvasViewport, setCanvasViewport] = useState<{
    width: number;
    height: number;
  }>({
    width: 0,
    height: 0,
  });

  const topology = task.topology;
  const taskAgents = useMemo(
    () => new Map(task.agents.map((agent) => [agent.id, agent])),
    [task.agents],
  );
  const visibleTopologyCandidateNodeIds = useMemo(
    () =>
      Array.from(
        new Set(
          task.agents
            .filter((agent) => agent.runCount > 0)
            .map((agent) => agent.id),
        ),
      ),
    [task.agents],
  );

  const orderedNodeIds = useMemo(
    () => getTopologyDisplayNodeIds(topology, visibleTopologyCandidateNodeIds),
    [topology, visibleTopologyCandidateNodeIds],
  );
  const hasRenderableTopology = orderedNodeIds.length > 0;
  const canvasViewportMeasurementKey = useMemo(
    () =>
      getTopologyCanvasViewportMeasurementKey({
        topologyNodeCount: topology.nodes.length,
        topologyNodeRecordCount: topology.nodeRecords.length,
        hasRenderableCanvas: hasRenderableTopology,
      }),
    [hasRenderableTopology, topology.nodeRecords.length, topology.nodes.length],
  );

  useEffect(() => {
    const element = canvasViewportRef.current;
    if (!element || !hasRenderableTopology) {
      return;
    }

    const updateViewport = (width: number, height: number) => {
      setCanvasViewport((current) => {
        const next = {
          width: Math.max(0, Math.floor(width)),
          height: Math.max(0, Math.floor(height)),
        };
        if (current.width === next.width && current.height === next.height) {
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
  }, [canvasViewportMeasurementKey, hasRenderableTopology]);
  const canvasLayout = useMemo(() => {
    if (!hasRenderableTopology) {
      return null;
    }

    return buildTopologyCanvasLayout({
      nodes: orderedNodeIds,
      edges: topology.edges,
      availableWidth: canvasViewport.width,
      availableHeight: canvasViewport.height,
      columnWidth: NODE_WIDTH,
      minNodeWidth: NODE_WIDTH,
      minNodeHeight: NODE_HEIGHT,
      columnGap: 4.5,
      sidePadding: 0,
      topPadding: 0,
      bottomPadding: 0,
      nodeHeight: NODE_HEIGHT,
    });
  }, [canvasViewport.height, canvasViewport.width, hasRenderableTopology, orderedNodeIds, topology.edges]);
  function getTaskAgent(agentId: string): TaskAgentRecord {
    const taskAgent = taskAgents.get(agentId);
    if (!taskAgent) {
      throw new Error(`拓扑节点 ${agentId} 缺少 task agent 运行态`);
    }
    return taskAgent;
  }

  function buildNodePresentation(agentId: string): TopologyNodePresentation {
    const taskAgent = getTaskAgent(agentId);
    const color = getAgentColorToken(agentId);
    const agentStatus = taskAgent.status;
    const content = resolveTopologyNodeContent({
      agentId,
      messages: task.messages,
      topology,
      taskStatus: task.task.status,
      agentStatus,
    });
    const statusBadge = getTopologyAgentStatusBadgePresentation(
      agentStatus,
    );
    const headerActions = getTopologyNodeHeaderActionOrder({
      showAttachButton: true,
    });
    const attachState = resolveAgentAttachButtonState({
      agentId,
      sessionState: resolveSessionStateFromSessionIdText(taskAgent.opencodeSessionId),
    });
    const attachDisabled = attachState.disabled;
    const attachTitle = attachState.title;
    return {
      color,
      content,
      statusBadge,
      headerActions,
      attachDisabled,
      attachTitle,
    };
  }

  if (!hasRenderableTopology || !canvasLayout) {
    return (
      <section className={PANEL_SURFACE_CLASS}>
        <header className={PANEL_HEADER_CLASS}>
          <div className={PANEL_HEADER_LEADING_CLASS}>
            <p className={PANEL_HEADER_TITLE_CLASS}>拓扑</p>
          </div>
          <div className="flex min-w-0 shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onOpenSystemPromptPanel}
              className={`${PANEL_HEADER_ACTION_BUTTON_CLASS} no-drag`}
              aria-label="打开 System Prompt 面板"
            >
              System Prompt
            </button>
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

  if (canvasLayout.nodes.length !== orderedNodeIds.length) {
    throw new Error(
      `拓扑布局节点数量异常：layout=${canvasLayout.nodes.length} display=${orderedNodeIds.length}`,
    );
  }

  return (
    <section className={PANEL_SURFACE_CLASS}>
      <header className={PANEL_HEADER_CLASS}>
        <div className={PANEL_HEADER_LEADING_CLASS}>
          <p className={PANEL_HEADER_TITLE_CLASS}>拓扑</p>
        </div>
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onOpenSystemPromptPanel}
            className={`${PANEL_HEADER_ACTION_BUTTON_CLASS} no-drag`}
            aria-label="打开 System Prompt 面板"
          >
            System Prompt
          </button>
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

      <div className={`relative min-h-0 min-w-0 flex-1 ${topologyPanelBodyClassName}`}>
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
            {orderedNodeIds.map((nodeName, index) => {
              const node = canvasLayout.nodes[index];
              if (!node) {
                throw new Error(`拓扑布局缺少第 ${index + 1} 个节点坐标：${nodeName}`);
              }
              const {
                color,
                content,
                statusBadge,
                headerActions,
                attachDisabled,
                attachTitle,
              } = buildNodePresentation(nodeName);
              return (
                <div
                  key={`${task.task.id}:${nodeName}`}
                  data-topology-node-card={nodeName}
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
                        title={nodeName}
                        className="min-w-0 flex-1 truncate text-base font-semibold text-foreground"
                      >
                        {nodeName}
                      </p>
                      <div className="shrink-0 flex items-center gap-2">
                        {headerActions.map((action) => {
                          if (action === "attach") {
                            return (
                              <button
                                key={action}
                                type="button"
                                aria-label={`打开 ${nodeName} 的 attach 终端`}
                                title={attachTitle}
                                disabled={attachDisabled}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (attachDisabled) {
                                    return;
                                  }
                                  onOpenAgentTerminal(nodeName);
                                }}
                                className="inline-flex h-6 items-center justify-center gap-1 rounded-full border border-[#d8cdbd] bg-[#fffaf2] px-2 text-[10px] font-semibold text-foreground/76 shadow-[0_1px_0_rgba(255,255,255,0.45)] transition hover:border-[#cda27d] hover:bg-white disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-[#d8cdbd] disabled:hover:bg-[#fffaf2]"
                              >
                                {renderAttachButtonIcon()}
                                <span>attach</span>
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

                  <div className="flex min-h-0 flex-1 flex-col px-1 py-1">
                    {content.kind === "final-history" ? (
                      <TopologyAgentHistoryList
                        agentId={nodeName}
                        historyItems={content.items}
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center rounded-[12px] border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-center text-[12px] text-foreground/56">
                        {content.copy}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
