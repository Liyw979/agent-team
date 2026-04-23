import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentRuntimeSnapshot,
  RuntimeUpdatedEventPayload,
  UiSnapshotPayload,
} from "@shared/types";
import { withOptionalString } from "@shared/object-utils";
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
import { getAppShellClassName } from "./lib/app-shell-layout";
import { getAppWorkspaceLayoutMetrics } from "./lib/app-workspace-layout";
import { buildAgentPromptPreviewText } from "./lib/agent-prompt-preview";
import {
  PANEL_HEADER_CLASS,
  PANEL_HEADER_LEADING_CLASS,
  PANEL_HEADER_TITLE_CLASS,
  PANEL_SECTION_BODY_CLASS,
  PANEL_SURFACE_CLASS,
} from "./lib/panel-header";
import {
  buildAvailableAgentIdsForFrontend,
  orderAgentsForFrontend,
  resolveDefaultSelectedAgentIdForFrontend,
} from "./lib/frontend-agent-order";
import { MarkdownMessage } from "./lib/chat-markdown";
import {
  buildAgentPromptDialogState,
  type AgentPromptDialogState,
} from "./lib/agent-prompt-dialog";
import { shouldRefreshForRuntimeEvent } from "./lib/runtime-event-refresh";
import { decideUiSnapshotRefreshAcceptance } from "./lib/ui-snapshot-refresh-gate";
import { getUiSnapshotPollingIntervalMs } from "./lib/ui-snapshot-polling";
import { resolveAppPanelVisibility, type AppPanelMode } from "./lib/app-panel-visibility";

function App() {
  const launchParams = useMemo(() => readLaunchParams(), []);
  const appShellClassName = getAppShellClassName();
  const workspaceLayoutMetrics = getAppWorkspaceLayoutMetrics();
  const [uiSnapshot, setUiSnapshot] = useState<UiSnapshotPayload | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [runtimeSnapshots, setRuntimeSnapshots] = useState<Record<string, AgentRuntimeSnapshot>>({});
  const [openingAgentTerminalId, setOpeningAgentTerminalId] = useState<string | null>(null);
  const [agentTerminalActionError, setAgentTerminalActionError] = useState<string | null>(null);
  const [promptLineCount, setPromptLineCount] = useState(1);
  const [agentCardGapPx, setAgentCardGapPx] = useState(6);
  const [panelMode, setPanelMode] = useState<AppPanelMode>("default");
  const [selectedAgentPromptDialog, setSelectedAgentPromptDialog] = useState<AgentPromptDialogState | null>(null);
  const agentPanelViewportRef = useRef<HTMLDivElement | null>(null);
  const latestUiSnapshotRef = useRef<UiSnapshotPayload | null>(null);
  const nextUiSnapshotRequestIdRef = useRef(0);
  const latestAcceptedUiSnapshotRequestIdRef = useRef(0);

  const workspace = uiSnapshot?.workspace ?? null;
  const task = uiSnapshot?.task ?? null;
  const launchTaskId = launchParams.taskId ?? "";
  const uiSnapshotPollingIntervalMs = getUiSnapshotPollingIntervalMs(launchTaskId);
  const panelVisibility = resolveAppPanelVisibility(panelMode);

  function applyUiSnapshotRefreshResult(nextUiSnapshot: UiSnapshotPayload, requestId: number) {
    const acceptance = decideUiSnapshotRefreshAcceptance({
      latestAcceptedRequestId: latestAcceptedUiSnapshotRequestIdRef.current,
      latestAcceptedPayload: latestUiSnapshotRef.current,
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

    if (!launchTaskId) {
      applyUiSnapshotRefreshResult({
        workspace: null,
        task: null,
        launchCwd: null,
        launchTaskId: launchParams.taskId,
        taskLogFilePath: null,
        taskUrl: null,
      }, requestId);
      return;
    }

    const next = await fetchUiSnapshot({
      taskId: launchTaskId,
    });
    applyUiSnapshotRefreshResult(next, requestId);
  }

  useEffect(() => {
    void refreshUiSnapshot();
  }, []);

  useEffect(() => {
    if (!uiSnapshotPollingIntervalMs) {
      return;
    }

    const timer = setInterval(() => {
      void refreshUiSnapshot();
    }, uiSnapshotPollingIntervalMs);

    return () => {
      clearInterval(timer);
    };
  }, [launchTaskId, uiSnapshotPollingIntervalMs]);

  useEffect(() => {
    latestUiSnapshotRef.current = uiSnapshot;
  }, [uiSnapshot]);

  useEffect(() => {
    if (!workspace || !task) {
      setRuntimeSnapshots({});
      return;
    }

    const activeTaskId = task.task.id;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function loadRuntime() {
      try {
        const snapshots = await getTaskRuntime({
          taskId: activeTaskId,
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
        if (!shouldRefreshForRuntimeEvent({
          currentTaskId: currentUiSnapshot.task.task.id,
          payload,
        })) {
          return;
        }
      }

      void refreshUiSnapshot();
    });
    return unsubscribe;
  }, [task?.task.id]);

  const availableAgents = useMemo(
    () => buildAvailableAgentIdsForFrontend(
      workspace?.agents ?? [],
      task?.topology ?? workspace?.topology ?? null,
    ),
    [task?.topology, workspace?.agents, workspace?.topology],
  );
  const agentCards = useMemo(() => {
    if (!workspace || !task) {
      return [];
    }

    const taskAgents = new Map(task.agents.map((agent) => [agent.id, agent]));
    return orderAgentsForFrontend(workspace.agents, task.topology ?? workspace.topology).map((agent) => {
      const taskAgent = taskAgents.get(agent.id);
      const promptPreview = buildAgentPromptPreviewText({
        agentId: agent.id,
        prompt: agent.prompt,
      });
      return {
        id: agent.id,
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

  async function handleOpenAgentTerminal(agentId: string) {
    if (!workspace || !task || openingAgentTerminalId === agentId) {
      return;
    }

    setOpeningAgentTerminalId(agentId);
    setAgentTerminalActionError(null);
    try {
      await openAgentTerminal({
        cwd: workspace.cwd,
        taskId: task.task.id,
        agentId,
      });
    } catch (error) {
      setAgentTerminalActionError(
        error instanceof Error ? error.message : `打开 ${agentId} 对应终端失败，请稍后重试。`,
      );
    } finally {
      setOpeningAgentTerminalId((current) => (current === agentId ? null : current));
    }
  }

  function handleOpenAgentPromptDialog(agent: {
    id: string;
    prompt: string;
  }) {
    setSelectedAgentId(agent.id);
    setSelectedAgentPromptDialog(
      buildAgentPromptDialogState({
        agentId: agent.id,
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
            打开当前任务页面。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden text-foreground">
      <main className={`min-h-0 flex-1 overflow-hidden ${appShellClassName}`}>
        {!panelVisibility.showChatPanel && panelVisibility.showTopologyPanel && !panelVisibility.showTeamPanel ? (
          <div className="h-full min-h-0 overflow-hidden">
            <TopologyGraph
              workspace={workspace}
              task={task}
              selectedAgentId={selectedAgentId}
              onSelectAgent={setSelectedAgentId}
              isMaximized={panelMode === "topology-only"}
              onToggleMaximize={() => {
                setPanelMode((current) => (current === "topology-only" ? "default" : "topology-only"));
              }}
              openingAgentTerminalId={openingAgentTerminalId}
              onOpenAgentTerminal={(agentId) => {
                void handleOpenAgentTerminal(agentId);
              }}
              runtimeSnapshots={runtimeSnapshots}
            />
          </div>
        ) : panelVisibility.showChatPanel && !panelVisibility.showTopologyPanel && !panelVisibility.showTeamPanel ? (
          <div className="h-full min-h-0 overflow-hidden">
            <ChatWindow
              workspace={workspace}
              task={task}
              availableAgents={availableAgents}
              taskLogFilePath={uiSnapshot?.taskLogFilePath ?? null}
              taskUrl={uiSnapshot?.taskUrl ?? null}
              isMaximized={panelMode === "chat-only"}
              onToggleMaximize={() => {
                setPanelMode((current) => (current === "chat-only" ? "default" : "chat-only"));
              }}
              onSubmit={async ({ content, mentionAgentId }) => {
                await submitTask(withOptionalString({
                  cwd: workspace.cwd,
                  taskId: task.task.id,
                  content,
                }, "mentionAgentId", mentionAgentId));
              }}
            />
          </div>
        ) : (
          <div
            className="grid h-full overflow-hidden grid-rows-[minmax(320px,42%)_minmax(0,1fr)]"
            style={{ gap: `${workspaceLayoutMetrics.panelGapPx}px` }}
          >
            <TopologyGraph
              workspace={workspace}
              task={task}
              selectedAgentId={selectedAgentId}
              onSelectAgent={setSelectedAgentId}
              isMaximized={panelMode === "topology-only"}
              onToggleMaximize={() => {
                setPanelMode((current) => (current === "topology-only" ? "default" : "topology-only"));
              }}
              openingAgentTerminalId={openingAgentTerminalId}
              onOpenAgentTerminal={(agentId) => {
                void handleOpenAgentTerminal(agentId);
              }}
              runtimeSnapshots={runtimeSnapshots}
            />

            <div
              className="grid min-h-0 overflow-hidden"
              style={{
                gap: `${workspaceLayoutMetrics.panelGapPx}px`,
                gridTemplateColumns: `minmax(0, 1fr) minmax(${workspaceLayoutMetrics.teamPanelMinWidthPx}px, ${workspaceLayoutMetrics.teamPanelMaxWidthPx}px)`,
              }}
            >
              <div className="min-h-0">
                <ChatWindow
                  workspace={workspace}
                  task={task}
                  availableAgents={availableAgents}
                  taskLogFilePath={uiSnapshot?.taskLogFilePath ?? null}
                  taskUrl={uiSnapshot?.taskUrl ?? null}
                  isMaximized={panelMode === "chat-only"}
                  onToggleMaximize={() => {
                    setPanelMode((current) => (current === "chat-only" ? "default" : "chat-only"));
                  }}
                  onSubmit={async ({ content, mentionAgentId }) => {
                    await submitTask(withOptionalString({
                      cwd: workspace.cwd,
                      taskId: task.task.id,
                      content,
                    }, "mentionAgentId", mentionAgentId));
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
                      const color = getAgentColorToken(agent.id);
                      const promptPreviewLine = agent.promptPreview.replace(/\s+/gu, "");
                      return (
                        <div
                          key={agent.id}
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
                                {agent.id}
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
        )}
      </main>

      {selectedAgentPromptDialog ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/28 px-6 py-6"
          onClick={() => setSelectedAgentPromptDialog(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`${selectedAgentPromptDialog.agentId} Prompt 详情`}
            className="flex max-h-[min(82vh,720px)] w-full max-w-[720px] flex-col overflow-hidden rounded-[14px] border bg-background shadow-[0_24px_80px_rgba(23,32,25,0.22)]"
            style={{
              borderColor: getAgentColorToken(selectedAgentPromptDialog.agentId).border,
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              className="flex items-center justify-between gap-3 border-b px-5 py-3"
              style={{
                background: getAgentColorToken(selectedAgentPromptDialog.agentId).soft,
                borderColor: getAgentColorToken(selectedAgentPromptDialog.agentId).border,
              }}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-flex max-w-full shrink-0 rounded-[8px] px-2 py-px text-center text-[14px] font-semibold leading-[1.2] tracking-[0.02em]"
                    style={{
                      background: getAgentColorToken(selectedAgentPromptDialog.agentId).solid,
                      color: getAgentColorToken(selectedAgentPromptDialog.agentId).badgeText,
                    }}
                  >
                    {selectedAgentPromptDialog.agentId}
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
