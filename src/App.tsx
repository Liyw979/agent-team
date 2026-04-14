import { useEffect, useMemo, useRef, useState } from "react";
import { AgentConfigModal } from "./components/AgentConfigModal";
import { ChatWindow } from "./components/ChatWindow";
import { SidebarList } from "./components/SidebarList";
import { TopologyGraph } from "./components/TopologyGraph";
import {
  acknowledgeTaskCompletionReminder,
  countVisibleTaskCompletionReminders,
  loadTaskCompletionReminderAcks,
  persistTaskCompletionReminderAcks,
  pruneTaskCompletionReminderAcks,
  shouldShowTaskCompletionReminder,
  type TaskCompletionReminderAcks,
} from "./lib/task-completion-reminders";
import { getAgentColorToken } from "./lib/agent-colors";
import { useAgentFlowStore } from "./store/useAgentFlowStore";
import { isBuiltinAgentPath, resolveTopologyAgentOrder } from "@shared/types";
import type { AgentRuntimeSnapshot, MessageRecord, TaskSnapshot, TopologyRecord } from "@shared/types";

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
  const [taskCompletionReminderAcks, setTaskCompletionReminderAcks] =
    useState<TaskCompletionReminderAcks>(() =>
      loadTaskCompletionReminderAcks(
        typeof window === "undefined" ? null : window.localStorage,
      ),
    );
  const [draggingAgentId, setDraggingAgentId] = useState<string | null>(null);
  const [dragOverAgentId, setDragOverAgentId] = useState<string | null>(null);
  const [openingAgentPaneId, setOpeningAgentPaneId] = useState<string | null>(null);
  const [agentPaneActionError, setAgentPaneActionError] = useState<string | null>(null);
  const suppressNextAgentCardClickRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const refreshProjects = async () => {
      const snapshots = await window.agentFlow.bootstrap();
      if (!cancelled) {
        setProjects(snapshots);
      }
    };

    void refreshProjects();
    const unsubscribe = window.agentFlow.onAgentFlowEvent((event) => {
      applyEvent(event);
    });

    const timer = globalThis.setInterval(() => {
      void refreshProjects();
    }, 3000);

    return () => {
      cancelled = true;
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

  useEffect(() => {
    const allTasks = projects.flatMap((project) => project.tasks.map((task) => task.task));
    setTaskCompletionReminderAcks((current) => {
      const next = pruneTaskCompletionReminderAcks(current, allTasks);
      if (next === current) {
        return current;
      }
      persistTaskCompletionReminderAcks(window.localStorage, next);
      return next;
    });
  }, [projects]);

  useEffect(() => {
    if (!activeTask) {
      return;
    }

    setTaskCompletionReminderAcks((current) => {
      const next = acknowledgeTaskCompletionReminder(current, activeTask.task);
      if (next === current) {
        return current;
      }
      persistTaskCompletionReminderAcks(window.localStorage, next);
      return next;
    });
  }, [activeTask]);

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
        mode: agentFile.mode,
        role: agentFile.role,
        relativePath: agentFile.relativePath,
      })),
      activeProject.topology.agentOrderIds,
    );
    const orderIndex = new Map(orderedAgentNames.map((agentName, index) => [agentName, index]));

    return activeProject.agentFiles
      .map((agentFile) => {
        const runtime = taskAgents.get(agentFile.name);
        const runtimeSnapshot = runtimeSnapshots[agentFile.name];
        const roleSummary =
          agentFile.prompt
            .split(/\n+/)
            .map((line) => line.trim())
            .find((line) => line && !line.startsWith("你是")) ?? "点击后可查看完整 Agent 原始配置。";
        return {
          ...agentFile,
          displayName: getAgentDisplayName(agentFile.name),
          roleSummary,
          status: runtime?.status ?? "idle",
          messageCount: runtimeSnapshot?.messageCount ?? 0,
          isBuiltin: isBuiltinAgentPath(agentFile.relativePath),
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
    setOpeningAgentPaneId(null);
    setAgentPaneActionError(null);
  }, [activeProject?.project.id, activeTaskView?.task.id]);

  const panelMappings = activeTaskView?.panels ?? [];
  const hasAgentPanelSummary = panelMappings.length > 0 || Boolean(agentPaneActionError);
  const runtimePollKey = useMemo(
    () =>
      activeTaskView?.agents
        .map((agent) => `${agent.name}:${agent.status}:${agent.opencodeSessionId ?? ""}`)
        .join("|") ?? "",
    [activeTaskView],
  );

  const taskCompletionReminderIds = useMemo(
    () =>
      new Set(
        projects
          .flatMap((project) => project.tasks)
          .filter((task) => shouldShowTaskCompletionReminder(task.task, taskCompletionReminderAcks))
          .map((task) => task.task.id),
      ),
    [projects, taskCompletionReminderAcks],
  );

  const projectCompletionReminderCounts = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          project.project.id,
          countVisibleTaskCompletionReminders(
            project.tasks.map((task) => task.task),
            taskCompletionReminderAcks,
          ),
        ]),
      ),
    [projects, taskCompletionReminderAcks],
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
      }, 1500);
    }

    return () => {
      cancelled = true;
      if (timer) {
        globalThis.clearInterval(timer);
      }
    };
  }, [activeProject, activeTaskView, runtimePollKey]);

  async function saveAgentOrder(nextOrderIds: string[]) {
    if (!activeProject) {
      return;
    }

    const validAgentNames = new Set(activeProject.agentFiles.map((agent) => agent.name));
    const normalizedOrderIds = nextOrderIds.filter((agentName) => validAgentNames.has(agentName));
    const currentOrderIds = resolveTopologyAgentOrder(
      activeProject.agentFiles.map((agent) => ({
        name: agent.name,
        mode: agent.mode,
        role: agent.role,
        relativePath: agent.relativePath,
      })),
      activeProject.topology.agentOrderIds,
    );
    if (normalizedOrderIds.join("|") === currentOrderIds.join("|")) {
      return;
    }

    const nodeById = new Map(activeProject.topology.nodes.map((node) => [node.id, node]));
    const nextTopology: TopologyRecord = {
      ...activeProject.topology,
      agentOrderIds: normalizedOrderIds,
      nodes: normalizedOrderIds.map(
        (agentName) =>
          nodeById.get(agentName) ?? {
            id: agentName,
            label: agentName,
            kind: "agent",
          },
      ),
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

  async function handleOpenAgentPane(agentName: string) {
    if (!activeProject || !activeTaskView || openingAgentPaneId === agentName) {
      return;
    }

    setOpeningAgentPaneId(agentName);
    setAgentPaneActionError(null);
    try {
      await window.agentFlow.openAgentPane({
        projectId: activeProject.project.id,
        taskId: activeTaskView.task.id,
        agentName,
      });
    } catch (error) {
      setAgentPaneActionError(
        error instanceof Error ? error.message : `打开 ${agentName} 对应 pane 失败，请稍后重试。`,
      );
    } finally {
      setOpeningAgentPaneId((current) => (current === agentName ? null : current));
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
              taskCompletionReminderIds={taskCompletionReminderIds}
              projectCompletionReminderCounts={projectCompletionReminderCounts}
              onSelectProject={selectProject}
              onSelectTask={selectTask}
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
                      const resolvedMentionAgent =
                        mentionAgent ||
                        (activeProject.agentFiles.some((agent) => agent.name === "Build")
                          ? "Build"
                          : activeProject.agentFiles[0]?.name);
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
                  </header>

                  <div className="flex flex-1 min-h-0 flex-col px-5 py-3">
                    {hasAgentPanelSummary ? (
                      <div className="mb-3 space-y-2">
                        {panelMappings.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            <span className="rounded-[6px] bg-card px-3 py-1 text-[11px] text-foreground/80">
                              {`${panelMappings.length} 个 panel 已绑定`}
                            </span>
                          </div>
                        ) : null}
                        {agentPaneActionError ? (
                          <div className="rounded-[8px] border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
                            {agentPaneActionError}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="min-h-0 flex-1 overflow-y-auto rounded-[8px] border border-border/60 bg-card/80 p-2">
                      {agentCards.map((agent) => {
                        const mappedPanel = panelMappings.find((panel) => panel.agentName === agent.name);
                        const agentColor = getAgentColorToken(agent.name);
                        const isDragging = draggingAgentId === agent.name;
                        const isDragOver = dragOverAgentId === agent.name && draggingAgentId !== agent.name;
                        const isOpeningPane = openingAgentPaneId === agent.name;
                        const canOpenPane = Boolean(activeTaskView);
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
                              if (!agent.relativePath.startsWith("builtin://")) {
                                setAgentConfigPath(agent.relativePath);
                                setAgentConfigOpen(true);
                              }
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter" && event.key !== " ") {
                                return;
                              }
                              event.preventDefault();
                              if (!agent.relativePath.startsWith("builtin://")) {
                                setAgentConfigPath(agent.relativePath);
                                setAgentConfigOpen(true);
                              }
                            }}
                            className={`mb-2 flex w-full cursor-grab items-center gap-3 rounded-[8px] border px-3 py-3 text-left transition active:cursor-grabbing last:mb-0 ${
                              agent.relativePath.startsWith("builtin://") ? "" : "hover:brightness-[0.99]"
                            }`}
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
                                    disabled={!canOpenPane || isOpeningPane}
                                    title={
                                      canOpenPane
                                        ? `打开 ${agent.displayName} 对应的 OpenCode 窗口`
                                        : "请先选择一个 Task"
                                    }
                                    onPointerDown={(event) => {
                                      event.stopPropagation();
                                    }}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void handleOpenAgentPane(agent.name);
                                    }}
                                    className="no-drag inline-flex items-center justify-center rounded-[6px] border border-border/70 bg-card/90 px-2.5 py-1 text-[11px] font-medium text-foreground/75 shadow-sm transition hover:border-primary disabled:cursor-not-allowed disabled:hover:border-border/70 disabled:opacity-45"
                                  >
                                    {isOpeningPane ? "打开中..." : "打开 Pane"}
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
