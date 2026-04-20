import React, { useEffect, useMemo, useState } from "react";
import type {
  AgentRuntimeSnapshot,
  RuntimeUpdatedEventPayload,
  UiBootstrapPayload,
} from "@shared/types";
import { ChatWindow } from "./components/ChatWindow";
import { TopologyGraph } from "./components/TopologyGraph";
import { PANEL_HEADER_ACTION_BUTTON_CLASS } from "./lib/panel-header-action-button";
import { getAgentColorToken } from "./lib/agent-colors";
import { buildAgentHistoryItems, type AgentHistoryItem } from "./lib/agent-history";
import {
  bootstrapTask,
  getTaskRuntime,
  openAgentTerminal,
  readLaunchParams,
  submitTask,
  subscribeAgentFlowEvents,
} from "./lib/web-api";

function App() {
  const launchParams = useMemo(() => readLaunchParams(), []);
  const [bootstrap, setBootstrap] = useState<UiBootstrapPayload | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [runtimeSnapshots, setRuntimeSnapshots] = useState<Record<string, AgentRuntimeSnapshot>>({});
  const [openingAgentTerminalId, setOpeningAgentTerminalId] = useState<string | null>(null);
  const [agentTerminalActionError, setAgentTerminalActionError] = useState<string | null>(null);

  const workspace = bootstrap?.workspace ?? null;
  const task = bootstrap?.task ?? null;

  async function refreshBootstrap() {
    if (!launchParams.cwd || !launchParams.taskId) {
      setBootstrap({
        workspace: null,
        task: null,
        launchCwd: launchParams.cwd || null,
        launchTaskId: launchParams.taskId || null,
      });
      return;
    }

    const next = await bootstrapTask({
      cwd: launchParams.cwd,
      taskId: launchParams.taskId,
    });
    setBootstrap(next);
    const nextSelectedAgentId =
      next.task?.agents.find((agent) => agent.name === selectedAgentId)?.name
      ?? next.workspace?.agents[0]?.name
      ?? null;
    setSelectedAgentId(nextSelectedAgentId);
  }

  useEffect(() => {
    void refreshBootstrap();
  }, []);

  useEffect(() => {
    if (!workspace || !task) {
      setRuntimeSnapshots({});
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function loadRuntime() {
      try {
        const snapshots = await getTaskRuntime({
          cwd: workspace.cwd,
          taskId: task.task.id,
        });
        if (cancelled) {
          return;
        }
        setRuntimeSnapshots(Object.fromEntries(snapshots.map((snapshot) => [snapshot.agentId, snapshot])));
      } catch {
        if (!cancelled) {
          setRuntimeSnapshots({});
        }
      }
    }

    void loadRuntime();
    timer = setInterval(() => {
      void loadRuntime();
    }, 1000);

    return () => {
      cancelled = true;
      if (timer) {
        clearInterval(timer);
      }
    };
  }, [workspace?.cwd, task?.task.id]);

  useEffect(() => {
    if (!bootstrap?.workspace || !bootstrap.task) {
      return;
    }

    const unsubscribe = subscribeAgentFlowEvents({
      cwd: bootstrap.workspace.cwd,
      taskId: bootstrap.task.task.id,
    }, (event) => {
      if (!bootstrap.task || !bootstrap.workspace) {
        return;
      }

      if (event.type === "runtime-updated") {
        const payload = event.payload as RuntimeUpdatedEventPayload;
        const sessionIds = new Set(
          bootstrap.task.agents
            .map((agent) => agent.opencodeSessionId)
            .filter((sessionId): sessionId is string => Boolean(sessionId)),
        );
        if (payload.sessionId && sessionIds.size > 0 && !sessionIds.has(payload.sessionId)) {
          return;
        }
      }

      void refreshBootstrap();
    });
    return unsubscribe;
  }, [bootstrap?.workspace?.cwd, bootstrap?.task?.task.id, selectedAgentId]);

  const availableAgents = workspace?.agents.map((agent) => agent.name) ?? [];
  const agentCards = useMemo(() => {
    if (!workspace || !task) {
      return [];
    }

    const taskAgents = new Map(task.agents.map((agent) => [agent.name, agent]));
    return workspace.agents.map((agent) => {
      const taskAgent = taskAgents.get(agent.name);
      return {
        name: agent.name,
        prompt: agent.prompt,
        status: taskAgent?.status ?? "idle",
        runCount: taskAgent?.runCount ?? 0,
      };
    });
  }, [workspace, task]);
  const selectedAgentCard = agentCards.find((agent) => agent.name === selectedAgentId) ?? null;
  const selectedAgentRuntime = selectedAgentId ? runtimeSnapshots[selectedAgentId] : undefined;
  const selectedAgentHistory = useMemo(() => {
    if (!task || !workspace || !selectedAgentId) {
      return [];
    }

    return buildAgentHistoryItems({
      agentId: selectedAgentId,
      messages: task.messages,
      topology: task.topology ?? workspace.topology,
      runtimeSnapshot: runtimeSnapshots[selectedAgentId],
    });
  }, [runtimeSnapshots, selectedAgentId, task, workspace]);

  async function handleOpenAgentTerminal(agentName: string) {
    if (!workspace || !task || openingAgentTerminalId === agentName) {
      return;
    }

    setOpeningAgentTerminalId(agentName);
    setAgentTerminalActionError(null);
    try {
      await openAgentTerminal({
        cwd: workspace.cwd,
        taskId: task.task.id,
        agentName,
      });
    } catch (error) {
      setAgentTerminalActionError(
        error instanceof Error ? error.message : `打开 ${agentName} 对应终端失败，请稍后重试。`,
      );
    } finally {
      setOpeningAgentTerminalId((current) => (current === agentName ? null : current));
    }
  }

  if (!workspace || !task) {
    return (
      <div className="flex h-screen items-center justify-center bg-background px-6 text-foreground">
        <div className="PANEL-surface max-w-xl rounded-[12px] p-6 text-center">
          <p className="font-display text-[1.8rem] font-bold text-primary">当前没有可展示的 Task</p>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">
            请先通过命令行执行 <code>task ui --file &lt;topology.json&gt; --message &lt;message&gt;</code>
            ，或使用 <code>task ui --task &lt;taskId&gt;</code> 打开已有任务。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden text-foreground">
      <main className="min-h-0 flex-1 overflow-hidden px-5 py-5">
        <div className="grid h-full overflow-hidden grid-rows-[minmax(320px,42%)_minmax(0,1fr)] gap-[10px]">
          <TopologyGraph
            workspace={workspace}
            task={task}
            selectedAgentId={selectedAgentId}
            onSelectAgent={setSelectedAgentId}
            runtimeSnapshots={runtimeSnapshots}
          />

          <div className="grid min-h-0 overflow-hidden grid-cols-[minmax(0,1fr)_minmax(340px,380px)] gap-[10px]">
            <div className="min-h-0">
              <ChatWindow
                workspace={workspace}
                task={task}
                availableAgents={availableAgents}
                onSubmit={async ({ content, mentionAgent }) => {
                  await submitTask({
                    cwd: workspace.cwd,
                    taskId: task.task.id,
                    content,
                    mentionAgent,
                  });
                }}
              />
            </div>

            <aside className="PANEL-surface flex min-h-0 flex-col overflow-hidden rounded-[10px]">
              <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-5">
                <div>
                  <p className="font-display text-[1.45rem] font-bold text-primary">当前 Agent</p>
                  <p className="text-xs text-muted-foreground">纯展示面板，不提供配置入口</p>
                </div>
                <span className="rounded-full bg-[#c96f3b] px-2.5 py-0.5 text-xs font-semibold text-white">
                  {agentCards.length}
                </span>
              </header>

              <div className="grid min-h-0 flex-1 grid-rows-[minmax(240px,0.95fr)_minmax(0,1.05fr)] gap-4 px-5 py-4">
                <section className="flex min-h-0 flex-col overflow-hidden rounded-[10px] border border-border/60 bg-card/75">
                  <header className="border-b border-border/60 px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-foreground">Agent 历史记录</p>
                        <p className="text-xs text-muted-foreground">
                          {selectedAgentCard ? `${selectedAgentCard.name} 的完整运行轨迹` : "请选择一个 Agent"}
                        </p>
                      </div>
                      {selectedAgentRuntime?.headline ? (
                        <span className="max-w-[150px] truncate rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                          {selectedAgentRuntime.headline}
                        </span>
                      ) : null}
                    </div>
                  </header>

                  <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                    {selectedAgentCard ? (
                      <div className="space-y-3">
                        <div
                          className="rounded-[10px] border px-3 py-3"
                          style={{
                            background: getAgentColorToken(selectedAgentCard.name).soft,
                            borderColor: getAgentColorToken(selectedAgentCard.name).border,
                          }}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-foreground">{selectedAgentCard.name}</p>
                              <p className="text-xs text-foreground/70">
                                状态: {getAgentStatusText(selectedAgentCard.status)} · runs: {selectedAgentCard.runCount}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                void handleOpenAgentTerminal(selectedAgentCard.name);
                              }}
                              className={PANEL_HEADER_ACTION_BUTTON_CLASS}
                            >
                              {openingAgentTerminalId === selectedAgentCard.name ? "打开中..." : "attach"}
                            </button>
                          </div>
                          {selectedAgentCard.prompt ? (
                            <p className="mt-3 line-clamp-2 text-xs leading-6 text-foreground/80">
                              {selectedAgentCard.prompt.split(/\n+/).find((line) => line.trim())}
                            </p>
                          ) : null}
                        </div>

                        {selectedAgentHistory.length > 0 ? (
                          <div className="space-y-2">
                            {selectedAgentHistory.map((item) => (
                              <article
                                key={item.id}
                                className={`rounded-[10px] border px-3 py-2.5 text-left ${getHistoryItemClassName(item)}`}
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <span className="text-[11px] font-semibold">{item.label}</span>
                                  <span className="text-[11px] opacity-70">{formatHistoryTimestamp(item.timestamp)}</span>
                                </div>
                                <p className="mt-1 whitespace-pre-wrap break-all text-[12px] leading-6 opacity-90">
                                  {item.detail}
                                </p>
                              </article>
                            ))}
                          </div>
                        ) : (
                          <div className="rounded-[10px] border border-dashed border-border/70 bg-background/50 px-3 py-4 text-sm text-muted-foreground">
                            当前还没有这位 Agent 的历史记录。
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="rounded-[10px] border border-dashed border-border/70 bg-background/50 px-3 py-4 text-sm text-muted-foreground">
                        当前没有选中的 Agent。
                      </div>
                    )}
                  </div>
                </section>

                <div className="min-h-0 overflow-y-auto">
                  {agentTerminalActionError ? (
                    <div className="mb-3 rounded-[8px] border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
                      {agentTerminalActionError}
                    </div>
                  ) : null}

                  <div className="space-y-3">
                    {agentCards.map((agent) => {
                      const color = getAgentColorToken(agent.name);
                      const selected = agent.name === selectedAgentId;
                      return (
                        <div
                          key={agent.name}
                          role="button"
                          tabIndex={0}
                          onClick={() => {
                            setSelectedAgentId(agent.name);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              setSelectedAgentId(agent.name);
                            }
                          }}
                          className="block w-full rounded-[10px] border p-4 text-left transition"
                          style={{
                            background: color.soft,
                            borderColor: selected ? color.solid : color.border,
                            boxShadow: selected ? `0 0 0 2px ${color.solid}33 inset` : undefined,
                          }}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-base font-semibold text-foreground">{agent.name}</p>
                              <p className="text-xs text-foreground/70">runs: {agent.runCount}</p>
                            </div>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleOpenAgentTerminal(agent.name);
                              }}
                              className={PANEL_HEADER_ACTION_BUTTON_CLASS}
                            >
                              {openingAgentTerminalId === agent.name ? "打开中..." : "attach"}
                            </button>
                          </div>
                          {agent.prompt ? (
                            <p className="mt-3 text-sm leading-6 text-foreground/80">
                              {agent.prompt.split(/\n+/).find((line) => line.trim())}
                            </p>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </aside>
          </div>
        </div>
      </main>
    </div>
  );
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

function getAgentStatusText(status: string) {
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

export default App;
