import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Orchestrator } from "./orchestrator";

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-orchestrator-"));
}

function writeAgentFile(projectPath: string, fileName: string, body: string) {
  const agentsDir = path.join(projectPath, ".opencode", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, fileName), body, "utf8");
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

test("所有 Agent 都已完成时 Task 会切到 finished 并追加结束系统消息", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  writeAgentFile(
    projectPath,
    "QA.md",
    `---
mode: subagent
role: integration_test
permission:
  read: allow
---
你是 QA。
`,
  );

  const orchestrator = new Orchestrator({
    userDataPath,
    enableEventStream: false,
    zellijManager: {
      isAvailable: async () => true,
      createTaskSession: async () => "oap-project-task",
      createPanelBindings: () => [],
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
        mode: "raw";
        content: string;
        from: string;
      },
      behavior?: {
        followTopology?: boolean;
      },
    ) => Promise<void>;
    opencodeClient: {
      createSession: (projectPath: string, title: string) => Promise<string>;
      reloadConfig: () => Promise<void>;
    };
    opencodeRunner: {
      run: (payload: { agent: string }) => Promise<{
        status: "completed";
        finalMessage: string;
        fallbackMessage: null;
        messageId: string;
        timestamp: string;
        rawMessage: {
          content: string;
          error: string | null;
        };
      }>;
    };
    store: {
      updateTaskAgentStatus: (
        taskId: string,
        agentName: string,
        status: "idle" | "success" | "failed" | "running" | "needs_revision",
      ) => void;
    };
  };

  typed.opencodeClient.createSession = async (_projectPath, title) => `session:${title}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async ({ agent }) => ({
    status: "completed",
    finalMessage: `${agent} 已完成`,
    fallbackMessage: null,
    messageId: `message:${agent}`,
    timestamp: "2026-04-15T00:00:00.000Z",
    rawMessage: {
      content: `${agent} 已完成`,
      error: null,
    },
  });

  const project = await orchestrator.createProject({ path: projectPath });
  await orchestrator.saveTopology({
    projectId: project.project.id,
    topology: {
      ...project.topology,
      startAgentId: "Build",
      agentOrderIds: ["Build", "QA"],
      nodes: [
        { id: "Build", label: "Build", kind: "agent" },
        { id: "QA", label: "QA", kind: "agent" },
      ],
      edges: [
        {
          id: "Build__QA__association",
          source: "Build",
          target: "QA",
          triggerOn: "association",
        },
      ],
    },
  });
  const task = await orchestrator.initializeTask({ projectId: project.project.id, title: "demo" });

  await typed.runAgent(
    project.project,
    task.task,
    "Build",
    {
      mode: "raw",
      from: "User",
      content: "先执行 Build",
    },
    {
      followTopology: false,
    },
  );

  let snapshot = await orchestrator.getTaskSnapshot(task.task.id);
  assert.equal(snapshot.task.status, "waiting");

  await typed.runAgent(
    project.project,
    task.task,
    "QA",
    {
      mode: "raw",
      from: "User",
      content: "再执行 QA",
    },
    {
      followTopology: false,
    },
  );

  snapshot = await orchestrator.getTaskSnapshot(task.task.id);
  assert.equal(snapshot.task.status, "finished");
  assert.notEqual(snapshot.task.completedAt, null);
  assert.equal(
    snapshot.messages.some(
      (message) =>
        message.sender === "system" &&
        message.meta?.kind === "task-completed" &&
        message.meta?.status === "finished" &&
        message.content.includes("已结束"),
    ),
    true,
  );
});

test("Build 在收到 UnitTest 回流后再次交付时会重新触发全部 association 下游", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = new Orchestrator({
    userDataPath,
    enableEventStream: false,
    zellijManager: {
      isAvailable: async () => true,
      createTaskSession: async () => "oap-project-task",
      createPanelBindings: () => [],
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
        mode: "raw";
        content: string;
        from: string;
      },
      behavior?: {
        followTopology?: boolean;
        updateTaskStatusOnStart?: boolean;
        completeTaskOnFinish?: boolean;
      },
    ) => Promise<void>;
    opencodeClient: {
      createSession: (projectPath: string, title: string) => Promise<string>;
      reloadConfig: () => Promise<void>;
    };
    opencodeRunner: {
      run: (payload: { agent: string }) => Promise<{
        status: "completed";
        finalMessage: string;
        fallbackMessage: null;
        messageId: string;
        timestamp: string;
        rawMessage: {
          content: string;
          error: null;
        };
      }>;
    };
  };

  const callCount = new Map<string, number>();
  typed.opencodeClient.createSession = async (_projectPath, title) => `session:${title}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async ({ agent }) => {
    const count = (callCount.get(agent) ?? 0) + 1;
    callCount.set(agent, count);

    const finalMessage = agent === "UnitTest"
      ? "【DECISION】检查通过"
      : `${agent} 已完成`;
    return {
      status: "completed",
      finalMessage,
      fallbackMessage: null,
      messageId: `message:${agent}:${count}`,
      timestamp: `2026-04-15T00:00:0${count}.000Z`,
      rawMessage: {
        content: finalMessage,
        error: null,
      },
    };
  };

  const project = await orchestrator.createProject({ path: projectPath });
  await orchestrator.saveTopology({
    projectId: project.project.id,
    topology: {
      ...project.topology,
      startAgentId: "Build",
      agentOrderIds: ["Build", "UnitTest", "CodeReview"],
      nodes: [
        { id: "Build", label: "Build", kind: "agent" },
        { id: "UnitTest", label: "UnitTest", kind: "agent" },
        { id: "CodeReview", label: "CodeReview", kind: "agent" },
      ],
      edges: [
        {
          id: "Build__UnitTest__association",
          source: "Build",
          target: "UnitTest",
          triggerOn: "association",
        },
        {
          id: "Build__CodeReview__association",
          source: "Build",
          target: "CodeReview",
          triggerOn: "association",
        },
      ],
    },
  });
  const task = await orchestrator.initializeTask({ projectId: project.project.id, title: "demo" });

  await typed.runAgent(
    project.project,
    task.task,
    "Build",
    {
      mode: "raw",
      from: "User",
      content: "第一次交付",
    },
  );

  typed.store.updateTaskAgentStatus(task.task.id, "UnitTest", "failed");

  await typed.runAgent(
    project.project,
    task.task,
    "Build",
    {
      mode: "raw",
      from: "User",
      content: "根据意见修复后再次交付",
    },
  );

  const snapshot = await orchestrator.getTaskSnapshot(task.task.id);
  const buildTriggerMessages = snapshot.messages.filter(
    (message) => message.sender === "Build" && message.meta?.kind === "high-level-trigger",
  );

  assert.equal(buildTriggerMessages.length >= 2, true);
  const latestTriggerTargets = (buildTriggerMessages.at(-1)?.meta?.targetAgentIds ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .sort();
  assert.deepEqual(latestTriggerTargets, ["CodeReview", "UnitTest"]);
});

test("旧运行数据里悬空 idle Agent 不会阻止 Task 自动收口", async () => {
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

  const typed = orchestrator as unknown as Orchestrator & {
    store: {
      updateTaskStatus: (taskId: string, status: "running" | "finished" | "waiting" | "failed", completedAt: string | null) => void;
      updateTaskAgentStatus: (taskId: string, agentName: string, status: "idle" | "success" | "failed" | "running" | "needs_revision") => void;
    };
  };

  const project = await orchestrator.createProject({ path: projectPath });
  await orchestrator.saveTopology({
    projectId: project.project.id,
    topology: {
      ...project.topology,
      edges: project.topology.edges.filter(
        (edge) => edge.source !== "IntegrationTest" && edge.target !== "IntegrationTest",
      ),
    },
  });
  const task = await orchestrator.initializeTask({ projectId: project.project.id, title: "demo" });

  typed.store.updateTaskStatus(task.task.id, "running", null);
  typed.store.updateTaskAgentStatus(task.task.id, "BA", "success");
  typed.store.updateTaskAgentStatus(task.task.id, "Build", "success");
  typed.store.updateTaskAgentStatus(task.task.id, "UnitTest", "success");
  typed.store.updateTaskAgentStatus(task.task.id, "TaskReview", "success");
  typed.store.updateTaskAgentStatus(task.task.id, "CodeReview", "success");
  typed.store.updateTaskAgentStatus(task.task.id, "IntegrationTest", "idle");

  const snapshot = await orchestrator.getTaskSnapshot(task.task.id);
  assert.equal(snapshot.task.status, "finished");
  assert.notEqual(snapshot.task.completedAt, null);
  assert.equal(
    snapshot.messages.some(
      (message) =>
        message.sender === "system" &&
        message.meta?.kind === "task-completed" &&
        message.meta?.status === "finished",
    ),
    true,
  );
});
