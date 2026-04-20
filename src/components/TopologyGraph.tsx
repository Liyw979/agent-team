import React from "react";
import { getAgentColorToken } from "@/lib/agent-colors";
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

export function TopologyGraph({
  workspace,
  task,
  selectedAgentId,
  onSelectAgent,
  runtimeSnapshots = {},
}: TopologyGraphProps) {
  const topology = task?.topology ?? workspace?.topology;
  const taskAgents = new Map(task?.agents.map((agent) => [agent.name, agent]) ?? []);

  if (!workspace || !task || !topology) {
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

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {topology.nodes.map((agentName) => {
          const taskAgent = taskAgents.get(agentName);
          const runtime = runtimeSnapshots[agentName];
          const color = getAgentColorToken(agentName);
          const selected = selectedAgentId === agentName;
          return (
            <button
              key={agentName}
              type="button"
              onClick={() => onSelectAgent(agentName)}
              className="rounded-[10px] border p-4 text-left transition"
              style={{
                background: color.soft,
                borderColor: selected ? color.solid : color.border,
                boxShadow: selected ? `0 0 0 2px ${color.solid}33 inset` : undefined,
              }}
            >
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="text-base font-semibold text-foreground">{agentName}</p>
                <span className="rounded-full border border-black/8 bg-white/70 px-2 py-0.5 text-xs text-foreground/75">
                  {getStatusLabel(taskAgent?.status ?? "idle")}
                </span>
              </div>
              <p className="text-xs leading-5 text-foreground/70">
                runs: {taskAgent?.runCount ?? 0}
              </p>
              {runtime?.headline ? (
                <p className="mt-2 text-sm leading-6 text-foreground/80">{runtime.headline}</p>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="mt-4 rounded-[8px] border border-border/60 bg-card/75 p-4">
        <p className="mb-3 text-sm font-semibold text-foreground">关系</p>
        {topology.edges.length === 0 ? (
          <p className="text-sm text-muted-foreground">当前没有任何边。</p>
        ) : (
          <div className="space-y-2">
            {topology.edges.map((edge) => (
              <div
                key={`${edge.source}-${edge.target}-${edge.triggerOn}`}
                className="flex flex-wrap items-center gap-2 text-sm text-foreground/80"
              >
                <span>{edge.source}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {getEdgeLabel(edge.triggerOn)}
                </span>
                <span>{edge.target}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
