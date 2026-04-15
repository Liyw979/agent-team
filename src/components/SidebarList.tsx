import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ProjectSnapshot } from "@shared/types";
import { cn } from "@/lib/utils";
import { CreateProjectDialog } from "./CreateProjectDialog";

interface SidebarListProps {
  projects: ProjectSnapshot[];
  selectedProjectId: string | null;
  selectedTaskId: string | null;
  onSelectProject: (projectId: string) => void;
  onSelectTask: (projectId: string, taskId: string | null) => void;
  onDeleteProject: (projectId: string) => Promise<void>;
  onDeleteTask: (projectId: string, taskId: string) => Promise<void>;
  onCreateProject: (path: string) => Promise<void>;
}

interface ProjectContextMenuState {
  kind: "project";
  projectId: string;
  projectName: string;
  x: number;
  y: number;
}

interface TaskContextMenuState {
  kind: "task";
  projectId: string;
  taskId: string;
  taskTitle: string;
  x: number;
  y: number;
}

type ContextMenuState = ProjectContextMenuState | TaskContextMenuState;

const TASK_CONTEXT_MENU_WIDTH = 188;
const TASK_CONTEXT_MENU_HEIGHT = 56;
const PROJECT_CONTEXT_MENU_WIDTH = 188;
const PROJECT_CONTEXT_MENU_HEIGHT = 56;
const TASK_CONTEXT_MENU_MARGIN = 12;

const taskStatusStyles: Record<string, string> = {
  pending: "bg-muted text-foreground/80",
  running: "bg-secondary text-secondary-foreground",
  waiting: "bg-[#efe4bf] text-[#6b5620]",
  finished: "bg-accent text-foreground",
  needs_revision: "bg-secondary text-secondary-foreground",
  failed: "bg-primary text-primary-foreground",
};

const taskStatusLabels: Record<string, string> = {
  pending: "pending",
  running: "running",
  waiting: "waiting",
  finished: "finished",
  needs_revision: "needs_revision",
  failed: "failed",
};

export function SidebarList({
  projects,
  selectedProjectId,
  selectedTaskId,
  onSelectProject,
  onSelectTask,
  onDeleteProject,
  onDeleteTask,
  onCreateProject,
}: SidebarListProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const closeMenu = () => {
      setContextMenu(null);
    };

    window.addEventListener("click", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("resize", closeMenu);

    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("resize", closeMenu);
    };
  }, [contextMenu]);

  const contextMenuNode = contextMenu ? (
    <div
      className="fixed z-[200] w-[188px] rounded-[10px] border border-border bg-[#fff8f0] p-1.5 shadow-2xl"
      style={{
        left: Math.min(
          Math.max(TASK_CONTEXT_MENU_MARGIN, contextMenu.x - 12),
          window.innerWidth
            - (contextMenu.kind === "project" ? PROJECT_CONTEXT_MENU_WIDTH : TASK_CONTEXT_MENU_WIDTH)
            - TASK_CONTEXT_MENU_MARGIN,
        ),
        top: Math.min(
          Math.max(TASK_CONTEXT_MENU_MARGIN, contextMenu.y - 12),
          window.innerHeight
            - (contextMenu.kind === "project" ? PROJECT_CONTEXT_MENU_HEIGHT : TASK_CONTEXT_MENU_HEIGHT)
            - TASK_CONTEXT_MENU_MARGIN,
        ),
      }}
    >
      {contextMenu.kind === "project" ? (
        <button
          type="button"
          onClick={() => {
            const confirmed = window.confirm(
              `确认从 AgentFlow 中删除 Project「${contextMenu.projectName}」吗？这会同时清理该 Project 的任务记录、.agentflow/ 运行态数据、自定义 Agent 配置，以及相关 Zellij session / OpenCode serve，但不会删除项目源码目录。`,
            );
            const payload = contextMenu;
            setContextMenu(null);
            if (!confirmed) {
              return;
            }
            void onDeleteProject(payload.projectId);
          }}
          className="w-full rounded-[8px] px-3 py-2 text-left text-sm font-medium text-[#8a2f1a] transition hover:bg-[#f7dfd6]"
        >
          删除 Project
        </button>
      ) : (
        <button
          type="button"
          onClick={() => {
            const confirmed = window.confirm(`确认删除 Task「${contextMenu.taskTitle}」吗？对应的 Zellij session 也会一起删除。`);
            const payload = contextMenu;
            setContextMenu(null);
            if (!confirmed) {
              return;
            }
            void onDeleteTask(payload.projectId, payload.taskId);
          }}
          className="w-full rounded-[8px] px-3 py-2 text-left text-sm font-medium text-[#8a2f1a] transition hover:bg-[#f7dfd6]"
        >
          删除 Task
        </button>
      )}
    </div>
  ) : null;

  return (
    <>
      <aside
        className="PANEL-surface mesh-bg relative flex h-full flex-col rounded-[10px] p-4"
        onContextMenu={(event) => {
          if (
            !(event.target instanceof HTMLElement)
            || (!event.target.closest("[data-task-item]") && !event.target.closest("[data-project-item]"))
          ) {
            setContextMenu(null);
          }
        }}
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="font-display text-xl font-bold text-primary">Agent Flow</p>
            <p className="text-sm text-muted-foreground">OpenCode Agent 编排工具</p>
          </div>
          <CreateProjectDialog onCreated={onCreateProject} />
        </div>

        <div className="space-y-4 overflow-y-auto pr-1">
          {projects.map((snapshot) => {
            const activeProject = snapshot.project.id === selectedProjectId;
            return (
              <section
                key={snapshot.project.id}
                data-project-item="true"
                onContextMenu={(event) => {
                  event.preventDefault();
                  onSelectProject(snapshot.project.id);
                  setContextMenu({
                    kind: "project",
                    projectId: snapshot.project.id,
                    projectName: snapshot.project.name,
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
                className={cn(
                  "rounded-[8px] border p-3 transition",
                  activeProject
                    ? "border-primary bg-card shadow-PANEL"
                    : "border-border bg-card/70 hover:border-accent",
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelectProject(snapshot.project.id)}
                  className="w-full text-left"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-foreground">{snapshot.project.name}</p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {snapshot.project.path}
                    </p>
                  </div>
                </button>

                <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
                  <button
                    type="button"
                    onClick={() => onSelectTask(snapshot.project.id, null)}
                    className={cn(
                      "w-full rounded-[8px] px-3 py-2 text-left text-sm transition",
                      activeProject && selectedTaskId === null
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted/60 text-foreground hover:bg-muted",
                    )}
                  >
                    新建 Task
                  </button>

                  {snapshot.tasks.map((task) => {
                    const activeTask =
                      activeProject && selectedTaskId !== null && task.task.id === selectedTaskId;
                    return (
                      <button
                        key={task.task.id}
                        data-task-item="true"
                        type="button"
                        onClick={() => onSelectTask(snapshot.project.id, task.task.id)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onSelectTask(snapshot.project.id, task.task.id);
                          setContextMenu({
                            kind: "task",
                            projectId: snapshot.project.id,
                            taskId: task.task.id,
                            taskTitle: task.task.title,
                            x: event.clientX,
                            y: event.clientY,
                          });
                        }}
                        className={cn(
                          "w-full rounded-[8px] border px-3 py-3 text-left transition",
                          activeTask
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border/60 bg-white/60 hover:border-accent hover:bg-white",
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold">{task.task.title}</p>
                            <p
                              className={cn(
                                "mt-1 truncate text-[11px]",
                                activeTask ? "text-primary-foreground/75" : "text-muted-foreground",
                              )}
                            >
                              {task.task.agentCount} Agents
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1.5">
                            <span
                              className={cn(
                                "rounded-[6px] px-2.5 py-1 text-[11px] font-medium",
                                activeTask
                                  ? "bg-white/15 text-primary-foreground"
                                  : taskStatusStyles[task.task.status] ?? taskStatusStyles.pending,
                              )}
                            >
                              {taskStatusLabels[task.task.status] ?? task.task.status}
                            </span>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </aside>

      {contextMenuNode && typeof document !== "undefined"
        ? createPortal(contextMenuNode, document.body)
        : null}
    </>
  );
}
