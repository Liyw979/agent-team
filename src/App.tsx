import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentRuntimeSnapshot,
  RuntimeUpdatedEventPayload,
  UiBootstrapPayload,
} from "@shared/types";
import { ChatWindow } from "./components/ChatWindow";
import { TopologyGraph } from "./components/TopologyGraph";
import {
  bootstrapTask,
  getTaskRuntime,
  openAgentTerminal,
  readLaunchParams,
  submitTask,
  subscribeAgentFlowEvents,
} from "./lib/web-api";
import { getAgentColorToken } from "./lib/agent-colors";
import { calculateAgentCardListGap, calculateAgentCardPromptLineCount } from "./lib/agent-card-layout";
import {
  PANEL_HEADER_CLASS,
  PANEL_HEADER_LEADING_CLASS,
  PANEL_HEADER_TITLE_CLASS,
  PANEL_SECTION_BODY_CLASS,
  PANEL_SURFACE_CLASS,
} from "./lib/panel-header";
import {
  buildAvailableAgentNamesForFrontend,
  orderAgentsForFrontend,
  resolveDefaultSelectedAgentIdForFrontend,
} from "./lib/frontend-agent-order";

function App() {
  const launchParams = useMemo(() => readLaunchParams(), []);
  const [bootstrap, setBootstrap] = useState<UiBootstrapPayload | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [runtimeSnapshots, setRuntimeSnapshots] = useState<Record<string, AgentRuntimeSnapshot>>({});
  const [openingAgentTerminalId, setOpeningAgentTerminalId] = useState<string | null>(null);
  const [agentTerminalActionError, setAgentTerminalActionError] = useState<string | null>(null);
  const [promptLineCount, setPromptLineCount] = useState(1);
  const [agentCardGapPx, setAgentCardGapPx] = useState(6);
  const agentPanelViewportRef = useRef<HTMLDivElement | null>(null);

  const workspace = bootstrap?.workspace ?? null;
  const task = bootstrap?.task ?? null;

  async function refreshBootstrap() {
    if (!launchParams.taskId) {
      setBootstrap({
        workspace: null,
        task: null,
        launchCwd: null,
        launchTaskId: launchParams.taskId || null,
      });
      return;
    }

    const next = await bootstrapTask({
      taskId: launchParams.taskId,
    });
    setBootstrap(next);
    const nextSelectedAgentId = resolveDefaultSelectedAgentIdForFrontend({
      selectedAgentId,
      workspaceAgents: next.workspace?.agents ?? [],
      taskAgents: next.task?.agents ?? [],
      topology: next.task?.topology ?? next.workspace?.topology ?? null,
    });
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

  const availableAgents = useMemo(
    () => buildAvailableAgentNamesForFrontend(
      workspace?.agents ?? [],
      task?.topology ?? workspace?.topology ?? null,
    ),
    [task?.topology, workspace?.agents, workspace?.topology],
  );
  const agentCards = useMemo(() => {
    if (!workspace || !task) {
      return [];
    }

    const taskMessages = task.messages;
    const taskAgents = new Map(task.agents.map((agent) => [agent.name, agent]));
    return orderAgentsForFrontend(workspace.agents, task.topology ?? workspace.topology).map((agent) => {
      const taskAgent = taskAgents.get(agent.name);
      return {
        name: agent.name,
        prompt: agent.prompt,
        status: taskAgent?.status ?? "idle",
        messageCount: taskMessages.filter((message) => message.sender === agent.name).length,
      };
    });
  }, [workspace, task]);

  useEffect(() => {
    const viewport = agentPanelViewportRef.current;
    if (!viewport || agentCards.length === 0) {
      setPromptLineCount(1);
      setAgentCardGapPx(6);
      return;
    }

    const updatePromptLineCount = () => {
      const viewportHeight = viewport.clientHeight - (agentTerminalActionError ? 42 : 0);
      const nextPromptLineCount = calculateAgentCardPromptLineCount({
        viewportHeight,
        cardCount: agentCards.length,
        gapPx: 6,
        reservedHeightPx: 58,
        lineHeightPx: 18,
      });
      setPromptLineCount(nextPromptLineCount);
      setAgentCardGapPx(
        calculateAgentCardListGap({
          viewportHeight,
          cardCount: agentCards.length,
          promptCardCount: agentCards.filter((agent) => agent.prompt.trim().length > 0).length,
          promptLineCount: nextPromptLineCount,
          minGapPx: 6,
          reservedHeightPx: 58,
          lineHeightPx: 18,
          emptyStateHeightPx: 20,
        }),
      );
    };

    updatePromptLineCount();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            updatePromptLineCount();
          });
    resizeObserver?.observe(viewport);
    window.addEventListener("resize", updatePromptLineCount);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updatePromptLineCount);
    };
  }, [agentCards.length, agentTerminalActionError]);

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

            <aside className={PANEL_SURFACE_CLASS}>
              <header className={PANEL_HEADER_CLASS}>
                <div className={PANEL_HEADER_LEADING_CLASS}>
                  <p className={PANEL_HEADER_TITLE_CLASS}>团队</p>
                </div>
              </header>

              <div
                ref={agentPanelViewportRef}
                className={`min-h-0 flex-1 overflow-y-auto ${PANEL_SECTION_BODY_CLASS}`}
              >
                {agentTerminalActionError ? (
                  <div className="mb-1.5 rounded-[8px] border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
                    {agentTerminalActionError}
                  </div>
                ) : null}

                <div className="flex flex-col" style={{ gap: `${agentCardGapPx}px` }}>
                  {agentCards.map((agent) => {
                    const color = getAgentColorToken(agent.name);
                    const promptPreview = agent.prompt.trim();
                    const promptPreviewLine = promptPreview.replace(/\s+/gu, "");
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
                        className="rounded-[8px] border px-3 py-2 text-left shadow-sm transition"
                        style={{
                          background: color.soft,
                          borderColor: color.border,
                          color: color.text,
                        }}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span
                            className="inline-flex max-w-full shrink-0 rounded-[8px] px-2 py-px text-center text-[14px] font-semibold leading-[1.2] tracking-[0.02em]"
                            style={{
                              background: color.solid,
                              color: color.badgeText,
                            }}
                          >
                            {agent.name}
                          </span>
                          <span className="rounded-full border border-[#d8cdbd] bg-[#fffaf2] px-2.5 py-0.5 text-[0.78rem] font-semibold text-foreground/76">{agent.messageCount}</span>
                        </div>
                        {promptPreview ? (
                          <div className="mt-1 min-w-0">
                            <p
                              title={promptPreview}
                              className="min-w-0 overflow-hidden break-all text-[13px] leading-[18px]"
                              style={{
                                color: color.mutedText,
                                display: "-webkit-box",
                                WebkitBoxOrient: "vertical",
                                WebkitLineClamp: promptLineCount,
                              }}
                            >
                              {promptPreviewLine}
                            </p>
                          </div>
                        ) : (
                          <div className="mt-1 min-w-0 text-[13px] leading-5" style={{ color: color.mutedText }}>
                            -
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleOpenAgentTerminal(agent.name);
                          }}
                          className="sr-only"
                        >
                          {openingAgentTerminalId === agent.name ? "打开中..." : "attach"}
                        </button>
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
