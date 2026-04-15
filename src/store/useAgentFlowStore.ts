import { create } from "zustand";
import type { AgentFlowEvent, ProjectSnapshot, TaskAgentRecord, TaskSnapshot } from "@shared/types";

interface AgentStatusPayload {
  taskId: string;
  agentId: string;
  status: TaskAgentRecord["status"];
  runCount: number;
}

interface AgentFlowState {
  projects: ProjectSnapshot[];
  selectedProjectId: string | null;
  selectedTaskId: string | null;
  selectedAgentId: string | null;
  setProjects: (projects: ProjectSnapshot[]) => void;
  selectProject: (projectId: string) => void;
  selectTask: (projectId: string, taskId: string | null) => void;
  selectAgent: (agentId: string | null) => void;
  applyEvent: (event: AgentFlowEvent) => void;
}

function updateTaskAgents(
  agents: TaskAgentRecord[],
  payload: AgentStatusPayload,
): TaskAgentRecord[] {
  return agents.map((agent) =>
    agent.name === payload.agentId
      ? {
          ...agent,
          status: payload.status,
          runCount: payload.runCount,
        }
      : agent,
  );
}

function replaceTask(tasks: TaskSnapshot[], nextTask: TaskSnapshot): TaskSnapshot[] {
  const existing = tasks.some((task) => task.task.id === nextTask.task.id);
  if (!existing) {
    return [nextTask, ...tasks];
  }
  return tasks.map((task) => (task.task.id === nextTask.task.id ? nextTask : task));
}

function mergeMessages(
  current: ProjectSnapshot["messages"],
  incoming: ProjectSnapshot["messages"],
): ProjectSnapshot["messages"] {
  const map = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    map.set(message.id, message);
  }
  return [...map.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function appendProjectMessage(project: ProjectSnapshot, message: ProjectSnapshot["messages"][number]) {
  const projectMessages = mergeMessages(project.messages, [message]);

  if (!message.taskId) {
    return {
      ...project,
      messages: projectMessages,
    };
  }

  return {
    ...project,
    messages: projectMessages,
    tasks: project.tasks.map((task) =>
      task.task.id === message.taskId
        ? {
            ...task,
            messages: mergeMessages(task.messages, [message]),
          }
        : task,
    ),
  };
}

function normalizeProjectSnapshot(snapshot: ProjectSnapshot): ProjectSnapshot {
  return {
    ...snapshot,
    messages: [...snapshot.messages].sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
    tasks: [...snapshot.tasks].sort((left, right) =>
      right.task.createdAt.localeCompare(left.task.createdAt),
    ),
  };
}

function shouldPreserveNewTaskSelection(
  selectedProjectId: string | null,
  nextProject: ProjectSnapshot | undefined,
  selectedTaskId: string | null,
): boolean {
  return selectedTaskId === null && nextProject?.project.id === selectedProjectId;
}

export const useAgentFlowStore = create<AgentFlowState>((set) => ({
  projects: [],
  selectedProjectId: null,
  selectedTaskId: null,
  selectedAgentId: null,
  setProjects: (projects) =>
    set((state) => {
      const normalized = projects.map(normalizeProjectSnapshot);
      const selectedProject =
        normalized.find((project) => project.project.id === state.selectedProjectId) ?? normalized[0];
      const selectedTask = shouldPreserveNewTaskSelection(
        state.selectedProjectId,
        selectedProject,
        state.selectedTaskId,
      )
        ? null
        : selectedProject?.tasks.find((task) => task.task.id === state.selectedTaskId) ??
          selectedProject?.tasks[0];
      const selectedAgent =
        selectedTask?.agents.find((agent) => agent.name === state.selectedAgentId)?.name ??
        selectedTask?.agents[0]?.name ??
        selectedProject?.agentFiles.find((agent) => agent.name === state.selectedAgentId)?.name ??
        selectedProject?.agentFiles[0]?.name ??
        null;

      return {
        projects: normalized,
        selectedProjectId: selectedProject?.project.id ?? null,
        selectedTaskId: selectedTask?.task.id ?? null,
        selectedAgentId: selectedAgent,
      };
    }),
  selectProject: (projectId) =>
    set((state) => {
      const project = state.projects.find((item) => item.project.id === projectId);
      return {
        selectedProjectId: projectId,
        selectedTaskId: project?.tasks[0]?.task.id ?? null,
        selectedAgentId: project?.tasks[0]?.agents[0]?.name ?? project?.agentFiles[0]?.name ?? null,
      };
    }),
  selectTask: (projectId, taskId) =>
    set((state) => {
      const project = state.projects.find((item) => item.project.id === projectId);
      const task = project?.tasks.find((item) => item.task.id === taskId);
      return {
        selectedProjectId: projectId,
        selectedTaskId: taskId,
        selectedAgentId: task?.agents[0]?.name ?? project?.agentFiles[0]?.name ?? null,
      };
    }),
  selectAgent: (agentId) => set({ selectedAgentId: agentId }),
  applyEvent: (event) =>
    set((state) => {
      const replaceProject = (updater: (project: ProjectSnapshot) => ProjectSnapshot) =>
        state.projects.map((project) =>
          project.project.id === event.projectId ? normalizeProjectSnapshot(updater(project)) : project,
        );

      if (event.type === "project-created") {
        const project = normalizeProjectSnapshot(event.payload as ProjectSnapshot);
        return {
          projects: [project, ...state.projects],
          selectedProjectId: project.project.id,
          selectedTaskId: project.tasks[0]?.task.id ?? null,
          selectedAgentId: project.tasks[0]?.agents[0]?.name ?? project.agentFiles[0]?.name ?? null,
        };
      }

      if (event.type === "project-updated") {
        const project = normalizeProjectSnapshot(event.payload as ProjectSnapshot);
        const projects = state.projects.map((item) =>
          item.project.id === project.project.id ? project : item,
        );

        if (state.selectedProjectId !== project.project.id) {
          return {
            projects,
          };
        }

        const preserveNewTaskSelection = shouldPreserveNewTaskSelection(
          state.selectedProjectId,
          project,
          state.selectedTaskId,
        );
        const selectedTaskStillExists = project.tasks.some((task) => task.task.id === state.selectedTaskId);
        const nextSelectedTaskId = preserveNewTaskSelection
          ? null
          : selectedTaskStillExists
            ? state.selectedTaskId
            : project.tasks[0]?.task.id ?? null;
        const nextTask = project.tasks.find((task) => task.task.id === nextSelectedTaskId);
        const nextSelectedAgentId =
          nextTask?.agents.find((agent) => agent.name === state.selectedAgentId)?.name ??
          nextTask?.agents[0]?.name ??
          project.agentFiles.find((agent) => agent.name === state.selectedAgentId)?.name ??
          project.agentFiles[0]?.name ??
          null;

        return {
          projects,
          selectedTaskId: nextSelectedTaskId,
          selectedAgentId: nextSelectedAgentId,
        };
      }

      if (event.type === "task-created") {
        const task = event.payload as TaskSnapshot;
        return {
          projects: replaceProject((project) => ({
            ...project,
            messages: mergeMessages(project.messages, task.messages),
            tasks: replaceTask(project.tasks, task),
          })),
          selectedProjectId: event.projectId,
          selectedTaskId: task.task.id,
          selectedAgentId: task.agents[0]?.name ?? state.selectedAgentId,
        };
      }

      if (event.type === "task-updated") {
        const task = event.payload as TaskSnapshot;
        return {
          projects: replaceProject((project) => ({
            ...project,
            tasks: replaceTask(project.tasks, task),
          })),
        };
      }

      if (event.type === "message-created") {
        const message = event.payload as ProjectSnapshot["messages"][number];
        return {
          projects: replaceProject((project) => appendProjectMessage(project, message)),
        };
      }

      if (event.type === "agent-status-changed") {
        const payload = event.payload as AgentStatusPayload;
        return {
          projects: replaceProject((project) => ({
            ...project,
            tasks: project.tasks.map((task) =>
              task.task.id === payload.taskId
                ? {
                    ...task,
                    agents: updateTaskAgents(task.agents, payload),
                  }
                : task,
            ),
          })),
        };
      }

      return state;
    }),
}));
