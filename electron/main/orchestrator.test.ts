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

test("审视通过但没有可展示高层结果时返回简洁兜底文案", () => {
  const orchestrator = new Orchestrator({
    userDataPath: createTempDir(),
    enableEventStream: false,
  });

  const displayContent = (
    orchestrator as unknown as {
      createDisplayContent: (
        parsedReview: {
          cleanContent: string;
          decision: "pass" | "needs_revision" | "unknown";
          feedback: string | null;
          rawDecisionBlock: string | null;
        },
        fallbackMessage?: string | null,
      ) => string;
    }
  ).createDisplayContent(
    {
      cleanContent: "",
      decision: "pass",
      feedback: null,
      rawDecisionBlock: "【DECISION】检查通过",
    },
    null,
  );

  assert.equal(displayContent, "通过");
});

test("审视 Agent 执行中止时不会伪造成整改意见", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new Orchestrator({
    userDataPath,
    enableEventStream: false,
    zellijManager: {
      isAvailable: async () => true,
      createTaskSession: async () => "oap-project-task",
      createPanelBindings: ({ projectId, taskId, sessionName, cwd }: {
        projectId: string;
        taskId: string;
        sessionName: string;
        cwd: string;
      }) => [
        {
          id: `${taskId}:CodeReview`,
          taskId,
          projectId,
          sessionName,
          paneId: "pane-1",
          agentName: "CodeReview",
          cwd,
          order: 0,
        },
      ],
      materializePanelBindings: async () => [],
      openTaskSession: async () => undefined,
      deleteTaskSession: async () => undefined,
    } as never,
  });
  const typed = orchestrator as unknown as Orchestrator & {
    runAgent: (
      project: { id: string; path: string },
      task: { id: string },
      agentName: string,
      prompt: {
        mode: "structured";
        from: string;
        agentMessage: string;
      },
    ) => Promise<void>;
    opencodeClient: {
      reloadConfig: () => Promise<void>;
    };
    opencodeRunner: {
      run: () => Promise<{
        status: "error";
        finalMessage: string;
        fallbackMessage: null;
        messageId: string;
        timestamp: string;
        rawMessage: {
          error: string;
          content: string;
        };
      }>;
    };
    ensureTaskPanels: () => Promise<void>;
    ensureAgentSession: () => Promise<string>;
  };

  const project = await orchestrator.createProject({ path: projectPath });
  const topology = {
    ...project.topology,
    edges: [
      ...project.topology.edges.filter((edge) => edge.source !== "CodeReview"),
      {
        id: "Build__CodeReview__association",
        source: "Build",
        target: "CodeReview",
        triggerOn: "association" as const,
      },
      {
        id: "CodeReview__Build__review_fail",
        source: "CodeReview",
        target: "Build",
        triggerOn: "review_fail" as const,
      },
    ],
  };
  await orchestrator.saveTopology({
    projectId: project.project.id,
    topology,
  });
  const task = await orchestrator.initializeTask({ projectId: project.project.id, title: "demo" });

  typed.ensureTaskPanels = async () => undefined;
  typed.ensureAgentSession = async () => "session-code-review";
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async () => ({
    status: "error",
    finalMessage: "Aborted",
    fallbackMessage: null,
    messageId: "msg-aborted",
    timestamp: "2026-04-15T00:00:00.000Z",
    rawMessage: {
      error: "Aborted",
      content: "",
    },
  });

  await typed.runAgent(
    project.project,
    task.task,
    "CodeReview",
    {
      mode: "structured",
      from: "Build",
      agentMessage: "请审查本轮改动",
    },
  );

  const snapshot = await orchestrator.getTaskSnapshot(task.task.id);
  assert.equal(snapshot.task.status, "failed");
  assert.equal(
    snapshot.messages.some(
      (message) =>
        message.sender === "CodeReview" &&
        message.meta?.kind === "revision-request",
    ),
    false,
  );
  assert.equal(
    snapshot.messages.some(
      (message) => message.content.includes("具体修改意见：\nAborted"),
    ),
    false,
  );
  assert.equal(
    snapshot.messages.some(
      (message) => message.content === "[CodeReview] 执行失败：Aborted",
    ),
    true,
  );
});
