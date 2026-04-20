import React, { useMemo } from "react";
import { getAgentColorToken } from "@/lib/agent-colors";
import { buildAgentHistoryItems, type AgentHistoryItem } from "@/lib/agent-history";
import { buildTopologyCanvasLayout } from "@/lib/topology-canvas";
import type {
  AgentRuntimeSnapshot,
  TaskSnapshot,
  TopologyEdge,
  WorkspaceSnapshot,
} from "@shared/types";

interface TopologyGraphProps {
  workspace: WorkspaceSnapshot | undefined;
  task: TaskSnapshot | undefined;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  runtimeSnapshots?: Record<string, AgentRuntimeSnapshot>;
}

const NODE_WIDTH = 248;
const NODE_HEIGHT = 308;
const HISTORY_VISIBLE_ITEMS = 6;

function getStatusLabel(status: TaskSnapshot["agents"][number]["status"]) {
  switch (status) {
    case "running":
      return "运行中";
    case "completed":
      return "已完成";
    case "failed":
      return "执行失败";
    case "needs_revision":
      return "需要修改";
    default:
      return "未启动";
  }
}

function getEdgeLabel(triggerOn: TopologyEdge["triggerOn"]) {
  switch (triggerOn) {
    case "association":
      return "传递";
    case "approved":
      return "审视通过";
    case "needs_revision":
      return "审视不通过";
    default:
      return triggerOn;
  }
}

function getEdgeAppearance(triggerOn: TopologyEdge["triggerOn"]) {
  switch (triggerOn) {
    case "approved":
      return {
        stroke: "#c96f3b",
        fill: "#fff1e8",
        text: "#8b4b22",
        dash: "6 6",
      };
    case "needs_revision":
      return {
        stroke: "#b25a4a",
        fill: "#f8e4df",
        text: "#7c3026",
        dash: "2 8",
      };
    default:
      return {
        stroke: "#2f6f5e",
        fill: "#e4f2ec",
        text: "#173328",
        dash: undefined,
      };
  }
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

export function TopologyGraph({
  workspace,
  task,
  selectedAgentId,
  onSelectAgent,
  runtimeSnapshots = {},
}: TopologyGraphProps) {
  const topology = task?.topology ?? workspace?.topology;
  const taskAgents = useMemo(
    () => new Map(task?.agents.map((agent) => [agent.name, agent]) ?? []),
    [task?.agents],
  );
  const canvasLayout = useMemo(() => {
    if (!topology) {
      return null;
    }
    return buildTopologyCanvasLayout({
      nodes: topology.nodes,
      edges: topology.edges,
      columnWidth: NODE_WIDTH,
      nodeHeight: NODE_HEIGHT,
    });
  }, [topology]);
  const historyByAgent = useMemo(() => {
    if (!task || !topology) {
      return new Map<string, AgentHistoryItem[]>();
    }

    return new Map(
      topology.nodes.map((agentName) => [
        agentName,
        buildAgentHistoryItems({
          agentId: agentName,
          messages: task.messages,
          topology,
          runtimeSnapshot: runtimeSnapshots[agentName],
        }).slice(-HISTORY_VISIBLE_ITEMS),
      ]),
    );
  }, [runtimeSnapshots, task, topology]);

  if (!workspace || !task || !topology || !canvasLayout) {
    return (
      <section className="PANEL-surface flex min-h-[320px] flex-col rounded-[10px] p-5">
        <header className="mb-4 flex items-center justify-between gap-3">
          <p className="font-display text-[1.45rem] font-bold text-primary">当前拓扑</p>
        </header>
        <div className="flex min-h-[220px] items-center justify-center rounded-[8px] border border-border/60 bg-card/70 text-sm text-muted-foreground">
          当前还没有可展示的 Task 拓扑。
        </div>
      </section>
    );
  }

  return (
    <section className="PANEL-surface flex min-h-[320px] flex-col rounded-[10px] p-5">
      <header className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="font-display text-[1.45rem] font-bold text-primary">当前拓扑</p>
          <p className="text-sm text-muted-foreground">纯展示模式，拓扑与 Prompt 全部来自 JSON 文件。</p>
        </div>
      </header>

      <div className="mesh-bg relative min-h-[350px] overflow-x-auto overflow-y-hidden rounded-[12px] border border-border/60 bg-card/75 p-4">
        <div
          className="relative min-w-full"
          style={{
            width: `${canvasLayout.width}px`,
            height: `${canvasLayout.height}px`,
          }}
        >
          <svg
            className="absolute inset-0 h-full w-full"
            viewBox={`0 0 ${canvasLayout.width} ${canvasLayout.height}`}
            fill="none"
            aria-label="当前任务拓扑图"
          >
            <defs>
              <marker
                id="topology-arrow"
                markerWidth="10"
                markerHeight="10"
                refX="8"
                refY="5"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#2f6f5e" />
              </marker>
            </defs>

            {canvasLayout.edges.map((edge) => {
              const appearance = getEdgeAppearance(edge.triggerOn);
              return (
                <g key={edge.id}>
                  <path
                    d={edge.path}
                    stroke={appearance.stroke}
                    strokeWidth="2.5"
                    strokeDasharray={appearance.dash}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    markerEnd="url(#topology-arrow)"
                  />
                  <g transform={`translate(${edge.labelX}, ${edge.labelY})`}>
                    <rect
                      x="-36"
                      y="-10"
                      width="72"
                      height="20"
                      rx="10"
                      fill={appearance.fill}
                      stroke={appearance.stroke}
                      strokeOpacity="0.45"
                    />
                    <text
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize="11"
                      fontWeight="600"
                      fill={appearance.text}
                    >
                      {getEdgeLabel(edge.triggerOn)}
                    </text>
                  </g>
                </g>
              );
            })}
          </svg>

          {canvasLayout.nodes.map((node) => {
            const taskAgent = taskAgents.get(node.id);
            const runtime = runtimeSnapshots[node.id];
            const color = getAgentColorToken(node.id);
            const selected = selectedAgentId === node.id;
            const historyItems = historyByAgent.get(node.id) ?? [];
            return (
              <button
                key={node.id}
                type="button"
                onClick={() => onSelectAgent(node.id)}
                className="absolute overflow-hidden rounded-[14px] text-left transition"
                style={{
                  left: `${node.x}px`,
                  top: `${node.y}px`,
                  width: `${node.width}px`,
                  height: `${node.height}px`,
                  border: selected ? `2px solid ${color.solid}` : `1px solid ${color.border}`,
                  boxShadow: selected ? `0 0 0 3px ${color.solid}1f, 0 20px 40px rgba(44, 74, 63, 0.14)` : "0 12px 30px rgba(44, 74, 63, 0.08)",
                  background: "rgba(255,248,240,0.9)",
                }}
              >
                <div
                  className="border-b px-4 py-3"
                  style={{
                    background: color.soft,
                    borderColor: color.border,
                  }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-base font-semibold text-foreground">{node.id}</p>
                    <span className="rounded-full border border-black/8 bg-white/70 px-2 py-0.5 text-xs text-foreground/75">
                      {getStatusLabel(taskAgent?.status ?? "idle")}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-foreground/70">
                    runs: {taskAgent?.runCount ?? 0}
                  </p>
                  {runtime?.headline ? (
                    <p className="mt-2 line-clamp-2 text-xs leading-5 text-foreground/80">{runtime.headline}</p>
                  ) : null}
                </div>

                <div className="h-[220px] px-3 py-3">
                  {historyItems.length > 0 ? (
                    <div className="h-full space-y-2 overflow-y-auto pr-1">
                      {historyItems.map((item) => (
                        <article
                          key={item.id}
                          className={`rounded-[10px] border px-3 py-2 text-left ${getHistoryItemClassName(item)}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] font-semibold">{item.label}</span>
                            <span className="text-[11px] opacity-70">{formatHistoryTimestamp(item.timestamp)}</span>
                          </div>
                          <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-all text-[11px] leading-5 opacity-90">
                            {item.detail}
                          </p>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="flex h-full items-center justify-center rounded-[10px] border border-dashed border-border/70 bg-background/45 text-sm text-muted-foreground">
                      待启动
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
