import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Orchestrator } from "./orchestrator";

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-orchestrator-"));
}

test("task init 会写入 Zellij session 信息并补齐运行态", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const panelRecords: Array<{ projectId: string; taskId: string; sessionName: string; cwd: string }> = [];
  const orchestrator = new Orchestrator({
    userDataPath,
    enableEventStream: false,
    zellijManager: {
      isAvailable: async () => true,
      createTaskSession: async () => "oap-project-task",
      createPanelBindings: (options: {
        projectId: string;
        taskId: string;
        sessionName: string;
        cwd: string;
      }) => {
        panelRecords.push(options);
        return [
          {
            id: `${options.taskId}:Build`,
            taskId: options.taskId,
            projectId: options.projectId,
            sessionName: options.sessionName,
            paneId: "pane-1",
            agentName: "Build",
            cwd: options.cwd,
            order: 0,
          },
        ];
      },
      materializePanelBindings: async ({ projectId, taskId, sessionName, cwd }: {
        projectId: string;
        taskId: string;
        sessionName: string;
        cwd: string;
      }) => [
        {
          id: `${taskId}:Build`,
          taskId,
          projectId,
          sessionName,
          paneId: "pane-1",
          agentName: "Build",
          cwd,
          order: 0,
        },
      ],
      openTaskSession: async () => undefined,
      deleteTaskSession: async () => undefined,
    } as never,
  });

  const project = await orchestrator.createProject({ path: projectPath });
  const task = await orchestrator.initializeTask({ projectId: project.project.id, title: "demo" });

  assert.equal(task.task.zellijSessionId, "oap-project-task");
  assert.equal(task.task.projectId, project.project.id);
  assert.equal(task.messages.some((message) => message.content.includes("Zellij Session")), true);
  assert.equal(panelRecords[0]?.projectId, project.project.id);
  assert.equal(panelRecords[0]?.cwd, projectPath);
});

test("zellij 不可用时会追加系统提醒", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new Orchestrator({
    userDataPath,
    enableEventStream: false,
    zellijManager: {
      isAvailable: async () => false,
      createTaskSession: async () => "oap-project-task",
      createPanelBindings: ({ projectId, taskId, sessionName, cwd }: {
        projectId: string;
        taskId: string;
        sessionName: string;
        cwd: string;
      }) => [
        {
          id: `${taskId}:Build`,
          taskId,
          projectId,
          sessionName,
          paneId: "pane-1",
          agentName: "Build",
          cwd,
          order: 0,
        },
      ],
      materializePanelBindings: async () => [],
      openTaskSession: async () => undefined,
      deleteTaskSession: async () => undefined,
    } as never,
  });

  const project = await orchestrator.createProject({ path: projectPath });
  const task = await orchestrator.initializeTask({ projectId: project.project.id, title: "demo" });

  assert.equal(task.messages.some((message) => message.meta?.kind === "zellij-missing"), true);
});
