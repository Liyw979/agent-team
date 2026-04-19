import React, { useEffect, useMemo, useRef, useState } from "react";
import { resolveTaskSubmissionTarget } from "@shared/task-submission";
import { AgentConfigModal, NEW_AGENT_DRAFT_PATH } from "./components/AgentConfigModal";
import { ChatWindow } from "./components/ChatWindow";
import { SidebarList } from "./components/SidebarList";
import { TopologyGraph } from "./components/TopologyGraph";
import { getAgentColorToken } from "./lib/agent-colors";
import { getPanelHeaderActionButtonClass } from "./lib/panel-header-action-button";
import { useAgentFlowStore } from "./store/useAgentFlowStore";
import { resolveBuildAgentName, resolveTopologyAgentOrder, usesOpenCodeBuiltinPrompt } from "@shared/types";
import type {
  AgentRuntimeSnapshot,
  MessageRecord,
  ProjectSnapshot,
  RuntimeUpdatedEventPayload,
  TaskSnapshot,
  TopologyRecord,
} from "@shared/types";

interface OptimisticSubmission {
  id: string;
  taskId: string;
  mentionAgent?: string;
  message: MessageRecord;
}

function getAgentDisplayName(name: string) {
  return name;
}

function buildUserHistoryContent(content: string, targetAgentId: string) {
  const trimmed = content.trim();
  if (!trimmed) {
    return `@${targetAgentId}`;
  }

  if (/@([^\s]+)/.test(trimmed)) {
    return content;
  }

  return `@${targetAgentId} ${trimmed}`;
}

function moveItemBefore(items: string[], sourceId: string, targetId: string) {
  if (sourceId === targetId) {
    return items;
  }
  const next = items.filter((item) => item !== sourceId);
  const targetIndex = next.indexOf(targetId);
  if (targetIndex < 0) {
    return items;
  }
  next.splice(targetIndex, 0, sourceId);
  return next;
}

function getAgentMetricLabel(messageCount: number) {
  return `消息 · ${messageCount}`;
}

export function getOpenAgentTerminalButtonLabel(isOpeningTerminal: boolean) {
  return isOpeningTerminal ? "打开中..." : "打开终端";
}

export function getOpenAgentTerminalButtonTitle(
  agentDisplayName: string,
  canOpenTerminal: boolean,
) {
  return canOpenTerminal
    ? `打开 ${agentDisplayName} 对应的 OpenCode 独立终端窗口`
    : "请先选择一个 Task";
}

function App() {
  const {
    projects,
    selectedProjectId,
    selectedTaskId,
    selectedAgentId,
    setProjects,
    selectProject,
    selectTask,
    selectAgent,
    applyEvent,
  } = useAgentFlowStore();
  const [agentConfigOpen, setAgentConfigOpen] = useState(false);
  const [agentConfigPath, setAgentConfigPath] = useState<string | null>(null);
  const [optimisticSubmissions, setOptimisticSubmissions] = useState<OptimisticSubmission[]>([]);
  const [runtimeSnapshots, setRuntimeSnapshots] = useState<Record<string, AgentRuntimeSnapshot>>(
    {},
  );
  const [runtimeRefreshToken, setRuntimeRefreshToken] = useState(0);
  const [draggingAgentId, setDraggingAgentId] = useState<string | null>(null);
  const [dragOverAgentId, setDragOverAgentId] = useState<string | null>(null);
  const [openingAgentTerminalId, setOpeningAgentTerminalId] = useState<string | null>(null);
  const [agentTerminalActionError, setAgentTerminalActionError] = useState<string | null>(null);
  const suppressNextAgentCardClickRef = useRef(false);
  const runtimeEventContextRef = useRef<{
    projects: ProjectSnapshot[];
    selectedProjectId: string | null;
    selectedTaskId: string | null;
  }>({
    projects: [],
    selectedProjectId: null,
    selectedTaskId: null,
  });

  useEffect(() => {
    runtimeEventContextRef.current = {
      projects,
      selectedProjectId,
      selectedTaskId,
    };
  }, [projects, selectedProjectId, selectedTaskId]);

  useEffect(() => {
    let cancelled = false;
    let pendingRuntimeRefreshTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

    const refreshProjects = async () => {
      const snapshots = await window.agentFlow.bootstrap();
      if (!cancelled) {
        setProjects(snapshots);
      }
    };

    void refreshProjects();
    const unsubscribe = window.agentFlow.onAgentFlowEvent((event) => {
      const {
        projects: currentProjects,
        selectedProjectId: currentSelectedProjectId,
        selectedTaskId: currentSelectedTaskId,
      } = runtimeEventContextRef.current;

      if (event.type === "runtime-updated" && event.projectId === currentSelectedProjectId) {
        const payload = event.payload as RuntimeUpdatedEventPayload;
        const currentProject = currentProjects.find(
          (project) => project.project.id === currentSelectedProjectId,
        );
        const currentTask = currentProject?.tasks.find((task) => task.task.id === currentSelectedTaskId);
        const activeSessionIds = new Set(
          currentTask?.agents
            .map((agent) => agent.opencodeSessionId)
            .filter((sessionId): sessionId is string => Boolean(sessionId)),
        );

        if (payload.sessionId && activeSessionIds.size > 0 && !activeSessionIds.has(payload.sessionId)) {
          return;
        }

        if (pendingRuntimeRefreshTimer) {
          globalThis.clearTimeout(pendingRuntimeRefreshTimer);
        }
        pendingRuntimeRefreshTimer = globalThis.setTimeout(() => {
          if (!cancelled) {
            setRuntimeRefreshToken((current) => current + 1);
          }
          pendingRuntimeRefreshTimer = null;
        }, 120);
      }
      applyEvent(event);
    });

    const timer = globalThis.setInterval(() => {
      void refreshProjects();
    }, 3000);

    return () => {
      cancelled = true;
      if (pendingRuntimeRefreshTimer) {
        globalThis.clearTimeout(pendingRuntimeRefreshTimer);
      }
      globalThis.clearInterval(timer);
      unsubscribe();
    };
  }, [applyEvent, setProjects]);

  const activeProject = useMemo(
    () => projects.find((project) => project.project.id === selectedProjectId),
    [projects, selectedProjectId],
  );

  const activeTask = useMemo(
    () => activeProject?.tasks.find((task) => task.task.id === selectedTaskId),
    [activeProject, selectedTaskId],
  );

  const activeTaskView = useMemo<TaskSnapshot | undefined>(() => {
    if (!activeTask) {
      return activeTask;
    }

    const pending = optimisticSubmissions.filter((item) => item.taskId === activeTask.task.id);
    if (pending.length === 0) {
      return activeTask;
    }

    const runningAgents = new Set(
      pending.map((item) => item.mentionAgent).filter((agentName): agentName is string => Boolean(agentName)),
    );

    return {
      ...activeTask,
      messages: [...activeTask.messages, ...pending.map((item) => item.message)].sort((left, right) =>
        left.timestamp.localeCompare(right.timestamp),
      ),
      agents: activeTask.agents.map((agent) =>
        runningAgents.has(agent.name) && agent.status === "idle"
          ? {
              ...agent,
              status: "running",
            }
          : agent,
      ),
    };
  }, [activeTask, optimisticSubmissions]);

  const agentCards = useMemo(() => {
    if (!activeProject) {
      return [];
    }

    const taskAgents = new Map(activeTaskView?.agents.map((agent) => [agent.name, agent]) ?? []);
    const orderedAgentNames = resolveTopologyAgentOrder(
      activeProject.agentFiles.map((agentFile) => ({
        name: agentFile.name,
      })),
      activeProject.topology.nodes,
    );
    const orderIndex = new Map(orderedAgentNames.map((agentName, index) => [agentName, index]));

    return activeProject.agentFiles
      .map((agentFile) => {
        const runtime = taskAgents.get(agentFile.name);
        const runtimeSnapshot = runtimeSnapshots[agentFile.name];
        const roleSummary =
          usesOpenCodeBuiltinPrompt(agentFile.name)
            ? "使用 OpenCode 内置 Build prompt。"
            : agentFile.prompt
              .split(/\n+/)
              .map((line) => line.trim())
              .find((line) => line && !line.startsWith("你是")) ?? "点击后可查看完整 Agent prompt。";
        return {
          ...agentFile,
          id: agentFile.name,
          displayName: getAgentDisplayName(agentFile.name),
          isWritable: agentFile.isWritable === true,
          roleSummary,
          status: runtime?.status ?? "idle",
          messageCount: runtimeSnapshot?.messageCount ?? 0,
        };
      })
      .sort((left, right) => {
        const leftIndex = orderIndex.get(left.name) ?? Number.MAX_SAFE_INTEGER;
        const rightIndex = orderIndex.get(right.name) ?? Number.MAX_SAFE_INTEGER;
        if (leftIndex !== rightIndex) {
          return leftIndex - rightIndex;
        }
        return left.name.localeCompare(right.name);
      });
  }, [activeProject, activeTaskView, runtimeSnapshots]);

  useEffect(() => {
    setDraggingAgentId(null);
    setDragOverAgentId(null);
    setOpeningAgentTerminalId(null);
    setAgentTerminalActionError(null);
  }, [activeProject?.project.id, activeTaskView?.task.id]);

  const panelMappings = activeTaskView?.panels ?? [];
  const runtimePollKey = useMemo(
    () =>
      activeTaskView?.agents
        .map((agent) => `${agent.name}:${agent.status}:${agent.opencodeSessionId ?? ""}`)
        .join("|") ?? "",
    [activeTaskView],
  );

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof globalThis.setInterval> | null = null;

    async function loadRuntime() {
      if (!activeProject || !activeTaskView) {
        if (!cancelled) {
          setRuntimeSnapshots({});
        }
        return;
      }

      try {
        const snapshots = await window.agentFlow.getTaskRuntime({
          projectId: activeProject.project.id,
          taskId: activeTaskView.task.id,
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

    if (!activeProject || !activeTaskView) {
      setRuntimeSnapshots({});
      return () => {
        cancelled = true;
      };
    }

    void loadRuntime();

    if (activeTaskView.agents.some((agent) => agent.opencodeSessionId)) {
      timer = globalThis.setInterval(() => {
        void loadRuntime();
      }, 1000);
    }

    return () => {
      cancelled = true;
      if (timer) {
        globalThis.clearInterval(timer);
      }
    };
  }, [activeProject, activeTaskView, runtimePollKey, runtimeRefreshToken]);

  async function saveAgentOrder(nextOrderIds: string[]) {
    if (!activeProject) {
      return;
    }

    const validAgentNames = new Set(activeProject.agentFiles.map((agent) => agent.name));
    const normalizedOrderIds = nextOrderIds.filter((agentName) => validAgentNames.has(agentName));
    const currentOrderIds = resolveTopologyAgentOrder(
      activeProject.agentFiles.map((agent) => ({
        name: agent.name,
      })),
      activeProject.topology.nodes,
    );
    if (normalizedOrderIds.join("|") === currentOrderIds.join("|")) {
      return;
    }

    const nextTopology: TopologyRecord = {
      ...activeProject.topology,
      nodes: normalizedOrderIds,
    };

    await window.agentFlow.saveTopology({
      projectId: activeProject.project.id,
      topology: nextTopology,
    });
  }

  async function handleAgentCardDrop(targetAgentId: string) {
    if (!draggingAgentId || draggingAgentId === targetAgentId) {
      setDraggingAgentId(null);
      setDragOverAgentId(null);
      return;
    }

    const currentOrderIds = agentCards.map((agent) => agent.name);
    const nextOrderIds = moveItemBefore(currentOrderIds, draggingAgentId, targetAgentId);
    suppressNextAgentCardClickRef.current = true;
    await saveAgentOrder(nextOrderIds);
    setDraggingAgentId(null);
    setDragOverAgentId(null);
    window.setTimeout(() => {
      suppressNextAgentCardClickRef.current = false;
    }, 0);
  }

  async function handleOpenAgentTerminal(agentName: string) {
    if (!activeProject || !activeTaskView || openingAgentTerminalId === agentName) {
      return;
    }

    setOpeningAgentTerminalId(agentName);
    setAgentTerminalActionError(null);
    try {
      await window.agentFlow.openAgentTerminal({
        projectId: activeProject.project.id,
        taskId: activeTaskView.task.id,
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

  return (
    <>
      <div className="flex h-screen flex-col overflow-hidden text-foreground">
        <div className="window-drag-region h-8 shrink-0" />

        <main className="min-h-0 flex-1 overflow-hidden px-5 pb-5">
          <div className="grid h-full overflow-hidden grid-cols-[320px_minmax(0,1fr)] gap-[10px]">
            <SidebarList
              projects={projects}
              selectedProjectId={selectedProjectId}
              selectedTaskId={selectedTaskId}
              onSelectProject={selectProject}
              onSelectTask={selectTask}
              onDeleteProject={async (projectId) => {
                const snapshots = await window.agentFlow.deleteProject({
                  projectId,
                });
                setProjects(snapshots);
              }}
              onDeleteTask={async (projectId, taskId) => {
                await window.agentFlow.deleteTask({
                  projectId,
                  taskId,
                });
              }}
              onCreateProject={async (path) => {
                await window.agentFlow.createProject({ path });
              }}
            />

            <div className="grid min-h-0 overflow-hidden grid-rows-[minmax(360px,46%)_minmax(0,1fr)] gap-[10px]">
              <TopologyGraph
                project={activeProject}
                task={activeTaskView}
                selectedAgentId={selectedAgentId}
                runtimeSnapshots={runtimeSnapshots}
                showEdgeList={false}
                onSelectAgent={(agentId) => {
                  selectAgent(agentId);
                }}
                onOpenLangGraphStudio={async () => {
                  if (!activeProject) {
                    return;
                  }
                  return window.agentFlow.openLangGraphStudio({
                    projectId: activeProject.project.id,
                  });
                }}
                onSaveTopology={async (topology) => {
                  if (!activeProject) {
                    return;
                  }
                  await window.agentFlow.saveTopology({
                    projectId: activeProject.project.id,
                    topology,
                  });
                }}
              />

              <div className="grid min-h-0 overflow-hidden grid-cols-[minmax(0,1fr)_minmax(380px,420px)] gap-[10px]">
                <div className="min-h-0">
                  <ChatWindow
                    project={activeProject}
                    task={activeTaskView}
                    availableAgents={activeProject?.agentFiles.map((agent) => agent.name) ?? []}
                    onOpenTaskSession={async () => {
                      if (!activeProject || !activeTaskView) {
                        return;
                      }
                      await window.agentFlow.openTaskSession({
                        projectId: activeProject.project.id,
                        taskId: activeTaskView.task.id,
                      });
                    }}
                    onSubmit={async ({ content, mentionAgent }) => {
                      if (!activeProject) {
                        return;
                      }
                      const resolution = resolveTaskSubmissionTarget({
                        content,
                        mentionAgent,
                        availableAgents: activeProject.agentFiles.map((agent) => agent.name),
                      });
                      if (!resolution.ok) {
                        throw new Error(resolution.message);
                      }
                      const resolvedMentionAgent = resolution.targetAgent;
                      let optimisticId: string | null = null;
                      if (activeTask) {
                        const optimisticContent = buildUserHistoryContent(content, resolvedMentionAgent);
                        optimisticId = globalThis.crypto.randomUUID();
                        setOptimisticSubmissions((current) => [
                          ...current,
                          {
                            id: optimisticId,
                            taskId: activeTask.task.id,
                            mentionAgent: resolvedMentionAgent,
                            message: {
                              id: optimisticId,
                              projectId: activeProject.project.id,
                              taskId: activeTask.task.id,
                              sender: "user",
                              content: optimisticContent,
                              timestamp: new Date().toISOString(),
                              meta: {
                                optimistic: "true",
                                targetAgentId: resolvedMentionAgent,
                              },
                            },
                          },
                        ]);
                      }
                      try {
                        await window.agentFlow.submitTask({
                          projectId: activeProject.project.id,
                          taskId: activeTask?.task.id ?? null,
                          content,
                          mentionAgent: resolvedMentionAgent,
                        });
                      } finally {
                        if (optimisticId) {
                          setOptimisticSubmissions((current) =>
                            current.filter((item) => item.id !== optimisticId),
                          );
                        }
                      }
                    }}
                  />
                </div>

                <aside className="PANEL-surface flex min-h-0 flex-col overflow-hidden rounded-[10px]">
                  <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-5">
                    <div className="flex items-center gap-2.5">
                      <p className="font-display text-[1.45rem] font-bold text-primary">团队成员</p>
                      <span className="rounded-full bg-[#c96f3b] px-2.5 py-0.5 text-xs font-semibold text-white">
                        {agentCards.length}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setAgentConfigPath(NEW_AGENT_DRAFT_PATH);
                        setAgentConfigOpen(true);
                      }}
                      className={getPanelHeaderActionButtonClass()}
                    >
                      配置 Agent
                    </button>
                  </header>

                  <div className="flex flex-1 min-h-0 flex-col px-5 py-3">
                    <div className="mb-3 space-y-2">
                      <div className="flex flex-wrap gap-2">
                        <span className="rounded-[6px] bg-card px-3 py-1 text-[11px] text-foreground/80">
                          {panelMappings.length > 0
                            ? `${panelMappings.length} 个 panel 已绑定`
                            : "当前还没有 panel 绑定记录"}
                        </span>
                      </div>
                      {agentTerminalActionError ? (
                        <div className="rounded-[8px] border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
                          {agentTerminalActionError}
                        </div>
                      ) : null}
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto rounded-[8px] border border-border/60 bg-card/80 p-2">
                      {agentCards.map((agent) => {
                        const mappedPanel = panelMappings.find((panel) => panel.agentName === agent.name);
                        const agentColor = getAgentColorToken(agent.name);
                        const isDragging = draggingAgentId === agent.name;
                        const isDragOver = dragOverAgentId === agent.name && draggingAgentId !== agent.name;
                        const isOpeningTerminal = openingAgentTerminalId === agent.name;
                        const canOpenTerminal = Boolean(activeTaskView);
                        return (
                          <div
                            key={agent.id}
                            role="button"
                            tabIndex={0}
                            draggable
                            onDragStart={(event) => {
                              setDraggingAgentId(agent.name);
                              setDragOverAgentId(agent.name);
                              event.dataTransfer.effectAllowed = "move";
                              event.dataTransfer.setData("text/plain", agent.name);
                            }}
                            onDragOver={(event) => {
                              event.preventDefault();
                              event.dataTransfer.dropEffect = "move";
                              if (dragOverAgentId !== agent.name) {
                                setDragOverAgentId(agent.name);
                              }
                            }}
                            onDrop={async (event) => {
                              event.preventDefault();
                              await handleAgentCardDrop(agent.name);
                            }}
                            onDragEnd={() => {
                              setDraggingAgentId(null);
                              setDragOverAgentId(null);
                            }}
                            onClick={() => {
                              if (suppressNextAgentCardClickRef.current) {
                                return;
                              }
                              setAgentConfigPath(agent.name);
                              setAgentConfigOpen(true);
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter" && event.key !== " ") {
                                return;
                              }
                              event.preventDefault();
                              setAgentConfigPath(agent.name);
                              setAgentConfigOpen(true);
                            }}
                            className="mb-2 flex w-full cursor-grab items-center gap-3 rounded-[8px] border px-3 py-3 text-left transition hover:brightness-[0.99] active:cursor-grabbing last:mb-0"
                            style={{
                              background: agentColor.soft,
                              borderColor: isDragOver ? agentColor.solid : agentColor.border,
                              boxShadow: isDragOver
                                ? `0 0 0 2px ${agentColor.solid}55 inset`
                                : isDragging
                                  ? `0 14px 26px ${agentColor.solid}22`
                                  : undefined,
                              opacity: isDragging ? 0.72 : 1,
                            }}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-center justify-between gap-3">
                                <div className="min-w-0 flex-1 py-1">
                                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                                    <p
                                      className="min-w-0 break-all text-[15px] font-semibold leading-5"
                                      style={{ color: agentColor.text }}
                                    >
                                      {agent.displayName}
                                    </p>
                                    {agent.isWritable && (
                                      <span
                                        className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]"
                                        title="当前 Project 的可写 Agent"
                                        style={{
                                          color: agentColor.text,
                                          borderColor: agentColor.border,
                                          background: "#fff8",
                                        }}
                                      >
                                        唯一可写
                                      </span>
                                    )}
                                  </div>
                                  {mappedPanel && (
                                    <div
                                      className="mt-1 break-all text-[11px]"
                                      style={{ color: agentColor.mutedText }}
                                    >
                                      {mappedPanel.paneId}
                                    </div>
                                  )}
                                </div>

                                <div className="flex shrink-0 items-center gap-2">
                                  <span
                                    className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[#c96f3b] px-1.5 text-[10px] font-semibold leading-none text-white"
                                    title={getAgentMetricLabel(agent.messageCount)}
                                  >
                                    {agent.messageCount}
                                  </span>
                                  <button
                                    type="button"
                                    draggable={false}
                                    disabled={!canOpenTerminal || isOpeningTerminal}
                                    title={getOpenAgentTerminalButtonTitle(agent.displayName, canOpenTerminal)}
                                    onPointerDown={(event) => {
                                      event.stopPropagation();
                                    }}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void handleOpenAgentTerminal(agent.name);
                                    }}
                                    className="no-drag inline-flex items-center justify-center rounded-[6px] border border-border/70 bg-card/90 px-2.5 py-1 text-[11px] font-medium text-foreground/75 shadow-sm transition hover:border-primary disabled:cursor-not-allowed disabled:hover:border-border/70 disabled:opacity-45"
                                  >
                                    {getOpenAgentTerminalButtonLabel(isOpeningTerminal)}
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}

                      {!activeProject && (
                        <div className="rounded-[8px] border border-dashed border-border bg-card/50 px-4 py-5 text-sm text-muted-foreground">
                          先创建或选择一个 Project。
                        </div>
                      )}
                    </div>
                  </div>
                </aside>
              </div>
            </div>
          </div>
        </main>
      </div>

      <AgentConfigModal
        project={activeProject}
        open={agentConfigOpen}
        selectedPath={agentConfigPath}
        onSelectPath={setAgentConfigPath}
        onOpenChange={setAgentConfigOpen}
      />
    </>
  );
}

export default App;
