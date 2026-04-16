import test from "node:test";
import assert from "node:assert/strict";

import type { ProjectSnapshot, TaskSnapshot, TopologyRecord } from "@shared/types";

import { useAgentFlowStore } from "./useAgentFlowStore";

function createTopology(projectId: string): TopologyRecord {
  return {
    projectId,
    startAgentId: "BA",
    nodes: ["BA", "Build"],
    edges: [],
  };
}

function createTaskSnapshot(projectId: string, taskId: string, createdAt: string): TaskSnapshot {
  return {
    task: {
      id: taskId,
      projectId,
      title: `Task ${taskId}`,
      status: "finished",
      cwd: "D:/agent-flow",
      zellijSessionId: null,
      opencodeSessionId: null,
      agentCount: 2,
      createdAt,
      completedAt: createdAt,
      initializedAt: createdAt,
    },
    agents: [
      {
        id: `${taskId}:BA`,
        taskId,
        projectId,
        name: "BA",
        opencodeSessionId: null,
        status: "completed",
        runCount: 1,
      },
      {
        id: `${taskId}:Build`,
        taskId,
        projectId,
        name: "Build",
        opencodeSessionId: null,
        status: "completed",
        runCount: 1,
      },
    ],
    panels: [],
    messages: [],
    topology: createTopology(projectId),
  };
}

function createProjectSnapshot(projectId = "project-1"): ProjectSnapshot {
  return {
    project: {
      id: projectId,
      name: "demo",
      path: "D:/agent-flow",
      createdAt: "2026-04-16T09:00:00.000Z",
    },
    agentFiles: [
      {
        name: "BA",
        prompt: "You are BA",
      },
      {
        name: "Build",
        prompt: "",
      },
    ],
    builtinAgentTemplates: [],
    topology: createTopology(projectId),
    messages: [],
    tasks: [
      createTaskSnapshot(projectId, "task-newer", "2026-04-16T09:10:00.000Z"),
      createTaskSnapshot(projectId, "task-older", "2026-04-16T09:00:00.000Z"),
    ],
  };
}

function resetStore() {
  useAgentFlowStore.setState({
    projects: [],
    selectedProjectId: null,
    selectedTaskId: null,
    selectedAgentId: null,
  });
}

test("setProjects keeps the new-task selection during polling refresh", () => {
  resetStore();
  const project = createProjectSnapshot();
  const store = useAgentFlowStore.getState();

  store.setProjects([project]);
  store.selectTask(project.project.id, null);
  useAgentFlowStore.getState().setProjects([createProjectSnapshot()]);

  const nextState = useAgentFlowStore.getState();
  assert.equal(nextState.selectedProjectId, project.project.id);
  assert.equal(nextState.selectedTaskId, null);
  assert.equal(nextState.selectedAgentId, "Build");
});

test("project-updated keeps the new-task selection for the active project", () => {
  resetStore();
  const project = createProjectSnapshot();
  const store = useAgentFlowStore.getState();

  store.setProjects([project]);
  store.selectTask(project.project.id, null);
  store.applyEvent({
    type: "project-updated",
    projectId: project.project.id,
    payload: createProjectSnapshot(),
  });

  const nextState = useAgentFlowStore.getState();
  assert.equal(nextState.selectedProjectId, project.project.id);
  assert.equal(nextState.selectedTaskId, null);
  assert.equal(nextState.selectedAgentId, "Build");
});
