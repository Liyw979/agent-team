import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentRuntimeSnapshot,
  RuntimeUpdatedEventPayload,
  UiSnapshotPayload,
} from "@shared/types";
import { ChatWindow } from "./components/ChatWindow";
import { TopologyGraph } from "./components/TopologyGraph";
import {
  fetchUiSnapshot,
  getTaskRuntime,
  openAgentTerminal,
  readLaunchParams,
  submitTask,
  subscribeAgentTeamEvents,
} from "./lib/web-api";
import { getAgentColorToken } from "./lib/agent-colors";
import { calculateAgentCardListGap, calculateAgentCardPromptLineCount } from "./lib/agent-card-layout";
import { buildAgentPromptPreviewText } from "./lib/agent-prompt-preview";
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
import { MarkdownMessage } from "./lib/chat-markdown";
import {
  buildAgentPromptDialogState,
  type AgentPromptDialogState,
} from "./lib/agent-prompt-dialog";
import { decideUiSnapshotRefreshAcceptance } from "./lib/ui-snapshot-refresh-gate";

function App() {
  const launchParams = useMemo(() => readLaunchParams(), []);
  const [uiSnapshot, setUiSnapshot] = useState<UiSnapshotPayload | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [runtimeSnapshots, setRuntimeSnapshots] = useState<Record<string, AgentRuntimeSnapshot>>({});
  const [openingAgentTerminalId, setOpeningAgentTerminalId] = useState<string | null>(null);
  const [agentTerminalActionError, setAgentTerminalActionError] = useState<string | null>(null);
  const [promptLineCount, setPromptLineCount] = useState(1);
  const [agentCardGapPx, setAgentCardGapPx] = useState(6);
  const [selectedAgentPromptDialog, setSelectedAgentPromptDialog] = useState<AgentPromptDialogState | null>(null);
  const agentPanelViewportRef = useRef<HTMLDivElement | null>(null);
  const latestUiSnapshotRef = useRef<UiSnapshotPayload | null>(null);
  const nextUiSnapshotRequestIdRef = useRef(0);
  const latestAcceptedUiSnapshotRequestIdRef = useRef(0);

  const workspace = uiSnapshot?.workspace ?? null;
  const task = uiSnapshot?.task ?? null;

  function applyUiSnapshotRefreshResult(nextUiSnapshot: UiSnapshotPayload, requestId: number) {
    const acceptance = decideUiSnapshotRefreshAcceptance({
      latestAcceptedRequestId: latestAcceptedUiSnapshotRequestIdRef.current,
      requestId,
      payload: nextUiSnapshot,
    });
    if (!acceptance.accepted || !acceptance.payload) {
      return;
    }

    latestAcceptedUiSnapshotRequestIdRef.current = acceptance.latestAcceptedRequestId;
    latestUiSnapshotRef.current = acceptance.payload;
    setUiSnapshot(acceptance.payload);
    setSelectedAgentId((currentSelectedAgentId) =>
      resolveDefaultSelectedAgentIdForFrontend({
        selectedAgentId: currentSelectedAgentId,
        workspaceAgents: acceptance.payload?.workspace?.agents ?? [],
        taskAgents: acceptance.payload?.task?.agents ?? [],
        topology: acceptance.payload?.task?.topology ?? acceptance.payload?.workspace?.topology ?? null,
      }),
    );
  }

  async function refreshUiSnapshot() {
    const requestId = nextUiSnapshotRequestIdRef.current + 1;
    nextUiSnapshotRequestIdRef.current = requestId;

    if (!launchParams.taskId) {
      applyUiSnapshotRefreshResult({
        workspace: null,
        task: null,
        launchCwd: null,
        launchTaskId: launchParams.taskId || null,
      }, requestId);
      return;
    }

    const next = await fetchUiSnapshot({
      taskId: launchParams.taskId,
    });
    applyUiSnapshotRefreshResult(next, requestId);
  }

  useEffect(() => {
    void refreshUiSnapshot();
  }, []);

  useEffect(() => {
    latestUiSnapshotRef.current = uiSnapshot;
  }, [uiSnapshot]);

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
    if (!task?.task.id) {
      return;
    }

    const unsubscribe = subscribeAgentTeamEvents({
      taskId: task.task.id,
    }, (event) => {
      const currentUiSnapshot = latestUiSnapshotRef.current;
      if (!currentUiSnapshot?.task || !currentUiSnapshot.workspace) {
        return;
      }

      if (event.type === "runtime-updated") {
        const payload = event.payload as RuntimeUpdatedEventPayload;
        const sessionIds = new Set(
          currentUiSnapshot.task.agents
            .map((agent) => agent.opencodeSessionId)
            .filter((sessionId): sessionId is string => Boolean(sessionId)),
        );
        if (payload.sessionId && sessionIds.size > 0 && !sessionIds.has(payload.sessionId)) {
          return;
        }
      }

      void refreshUiSnapshot();
    });
    return unsubscribe;
  }, [task?.task.id]);

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

    const taskAgents = new Map(task.agents.map((agent) => [agent.name, agent]));
    return orderAgentsForFrontend(workspace.agents, task.topology ?? workspace.topology).map((agent) => {
      const taskAgent = taskAgents.get(agent.name);
      const promptPreview = buildAgentPromptPreviewText({
        agentName: agent.name,
        prompt: agent.prompt,
      });
      return {
        name: agent.name,
        prompt: agent.prompt,
        promptPreview,
        status: taskAgent?.status ?? "idle",
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
          promptCardCount: agentCards.filter((agent) => agent.promptPreview !== "-").length,
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

  function handleOpenAgentPromptDialog(agent: {
    name: string;
    prompt: string;
  }) {
    setSelectedAgentId(agent.name);
    setSelectedAgentPromptDialog(
      buildAgentPromptDialogState({
        agentName: agent.name,
        prompt: agent.prompt,
      }),
    );
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
            openingAgentTerminalId={openingAgentTerminalId}
            onOpenAgentTerminal={(agentName) => {
              void handleOpenAgentTerminal(agentName);
            }}
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
                    const promptPreviewLine = agent.promptPreview.replace(/\s+/gu, "");
                    return (
                      <div
                        key={agent.name}
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          handleOpenAgentPromptDialog(agent);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            handleOpenAgentPromptDialog(agent);
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
                          <div className="min-w-0">
                            <span
                              className="inline-flex max-w-full shrink-0 rounded-[8px] px-2 py-px text-center text-[14px] font-semibold leading-[1.2] tracking-[0.02em]"
                              style={{
                                background: color.solid,
                                color: color.badgeText,
                              }}
                            >
                              {agent.name}
                            </span>
                          </div>
                        </div>
                        {agent.promptPreview !== "-" ? (
                          <div className="mt-1 min-w-0">
                            <p
                              title={agent.promptPreview}
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
                      </div>
                    );
                  })}
                </div>
              </div>
            </aside>
          </div>
        </div>
      </main>

      {selectedAgentPromptDialog ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/28 px-6 py-6"
          onClick={() => setSelectedAgentPromptDialog(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`${selectedAgentPromptDialog.agentName} Prompt 详情`}
            className="flex max-h-[min(82vh,720px)] w-full max-w-[720px] flex-col overflow-hidden rounded-[14px] border bg-background shadow-[0_24px_80px_rgba(23,32,25,0.22)]"
            style={{
              borderColor: getAgentColorToken(selectedAgentPromptDialog.agentName).border,
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              className="flex items-center justify-between gap-3 border-b px-5 py-3"
              style={{
                background: getAgentColorToken(selectedAgentPromptDialog.agentName).soft,
                borderColor: getAgentColorToken(selectedAgentPromptDialog.agentName).border,
              }}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-flex max-w-full shrink-0 rounded-[8px] px-2 py-px text-center text-[14px] font-semibold leading-[1.2] tracking-[0.02em]"
                    style={{
                      background: getAgentColorToken(selectedAgentPromptDialog.agentName).solid,
                      color: getAgentColorToken(selectedAgentPromptDialog.agentName).badgeText,
                    }}
                  >
                    {selectedAgentPromptDialog.agentName}
                  </span>
                </div>
                <p className="mt-1 text-xs text-foreground/60">
                  {selectedAgentPromptDialog.promptSourceLabel}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedAgentPromptDialog(null)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border/70 bg-background/90 text-lg leading-none text-foreground/68 transition hover:bg-background"
                aria-label="关闭 Prompt 详情"
              >
                ×
              </button>
            </div>

            <div className={`min-h-0 overflow-y-auto ${PANEL_SECTION_BODY_CLASS}`}>
              <MarkdownMessage
                content={selectedAgentPromptDialog.content}
                className="text-[14px] leading-[1.35] text-foreground/84"
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
