import React, { useEffect, useMemo, useState } from "react";
import { ChatWindow } from "./components/ChatWindow";
import { TopologyGraph } from "./components/TopologyGraph";
import { getAgentColorToken } from "./lib/agent-colors";
import { PANEL_HEADER_ACTION_BUTTON_CLASS } from "./lib/panel-header-action-button";
import type {
  AgentRuntimeSnapshot,
  RuntimeUpdatedEventPayload,
  UiBootstrapPayload,
} from "@shared/types";

function App() {
  const [bootstrap, setBootstrap] = useState<UiBootstrapPayload | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [runtimeSnapshots, setRuntimeSnapshots] = useState<Record<string, AgentRuntimeSnapshot>>({});
  const [openingAgentTerminalId, setOpeningAgentTerminalId] = useState<string | null>(null);
  const [agentTerminalActionError, setAgentTerminalActionError] = useState<string | null>(null);

  const workspace = bootstrap?.workspace ?? null;
  const task = bootstrap?.task ?? null;

  async function refreshBootstrap() {
    const next = await window.agentFlow.bootstrap();
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
        const snapshots = await window.agentFlow.getTaskRuntime({
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
    const unsubscribe = window.agentFlow.onAgentFlowEvent((event) => {
      if (!bootstrap?.task || !bootstrap.workspace) {
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

  async function handleOpenAgentTerminal(agentName: string) {
    if (!workspace || !task || openingAgentTerminalId === agentName) {
      return;
    }

    setOpeningAgentTerminalId(agentName);
    setAgentTerminalActionError(null);
    try {
      await window.agentFlow.openAgentTerminal({
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
            请先通过命令行执行 <code>task run --file &lt;topology.json&gt; --message &lt;message&gt; --ui</code>
            ，或使用 <code>task show &lt;taskId&gt; --ui</code> 打开已有任务。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden text-foreground">
      <div className="window-drag-region h-8 shrink-0" />

      <main className="min-h-0 flex-1 overflow-hidden px-5 pb-5">
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
                  await window.agentFlow.submitTask({
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

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {agentTerminalActionError ? (
                  <div className="mb-3 rounded-[8px] border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
                    {agentTerminalActionError}
                  </div>
                ) : null}

                <div className="space-y-3">
                  {agentCards.map((agent) => {
                    const color = getAgentColorToken(agent.name);
                    return (
                      <div
                        key={agent.name}
                        className="rounded-[10px] border p-4"
                        style={{
                          background: color.soft,
                          borderColor: color.border,
                        }}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-base font-semibold text-foreground">{agent.name}</p>
                            <p className="text-xs text-foreground/70">runs: {agent.runCount}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
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
            </aside>
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
