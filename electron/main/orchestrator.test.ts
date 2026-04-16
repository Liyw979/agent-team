import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_BUILTIN_AGENT_TEMPLATES } from "@shared/types";
import {
  REVIEW_RESPONSE_END_LABEL,
  REVIEW_RESPONSE_LABEL,
} from "@shared/review-response";
import { Orchestrator } from "./orchestrator";

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-orchestrator-"));
}

const activeOrchestrators = new Set<Orchestrator>();

function createTestOrchestrator(
  options: ConstructorParameters<typeof Orchestrator>[0],
): Orchestrator {
  const orchestrator = new Orchestrator(options);
  activeOrchestrators.add(orchestrator);
  return orchestrator;
}

function forceCleanupCurrentProcessOpenCodeChildren() {
  try {
    const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const childrenByParent = new Map<number, Array<{ pid: number; command: string }>>();
    for (const line of output.split(/\r?\n/)) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) {
        continue;
      }
      const pid = Number(match[1]);
      const parentPid = Number(match[2]);
      const command = match[3] ?? "";
      if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || pid <= 0 || parentPid <= 0) {
        continue;
      }
      const current = childrenByParent.get(parentPid) ?? [];
      current.push({ pid, command });
      childrenByParent.set(parentPid, current);
    }

    const descendants: Array<{ pid: number; command: string }> = [];
    const pending = [...(childrenByParent.get(process.pid) ?? [])];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current || descendants.some((item) => item.pid === current.pid)) {
        continue;
      }
      descendants.push(current);
      for (const child of childrenByParent.get(current.pid) ?? []) {
        pending.push(child);
      }
    }

    for (const child of descendants.reverse()) {
      if (!child.command.includes("opencode") || !child.command.includes("serve")) {
        continue;
      }
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        continue;
      }
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore cleanup errors in tests
  }
}

afterEach(async () => {
  const orchestrators = [...activeOrchestrators];
  activeOrchestrators.clear();
  await Promise.allSettled(orchestrators.map((orchestrator) => orchestrator.dispose()));
  forceCleanupCurrentProcessOpenCodeChildren();
});

async function addBuiltinAgents(
  orchestrator: Orchestrator,
  projectId: string,
  agentNames: string[],
  writableAgentName?: string | null,
) {
  let latestProject = await orchestrator.getProjectSnapshot(projectId);
  for (const agentName of agentNames) {
    const template = DEFAULT_BUILTIN_AGENT_TEMPLATES.find((item) => item.name === agentName);
    assert.notEqual(template, undefined, `缺少内置模板：${agentName}`);
    latestProject = await orchestrator.saveAgentPrompt({
      projectId,
      currentAgentName: "",
      nextAgentName: agentName,
      prompt: template.prompt,
      isWritable: writableAgentName === agentName,
    });
  }
  return latestProject;
}

async function addCustomAgent(
  orchestrator: Orchestrator,
  projectId: string,
  agentName: string,
  prompt: string,
  isWritable = false,
) {
  return orchestrator.saveAgentPrompt({
    projectId,
    currentAgentName: "",
    nextAgentName: agentName,
    prompt,
    isWritable,
  });
}

async function waitForTaskSnapshot(
  orchestrator: Orchestrator,
  taskId: string,
  predicate: (snapshot: Awaited<ReturnType<Orchestrator["getTaskSnapshot"]>>) => boolean,
  timeoutMs = 5000,
): Promise<Awaited<ReturnType<Orchestrator["getTaskSnapshot"]>>> {
  const startedAt = Date.now();
  let latestSnapshot = await orchestrator.getTaskSnapshot(taskId);
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate(latestSnapshot)) {
      return latestSnapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    latestSnapshot = await orchestrator.getTaskSnapshot(taskId);
  }

  throw new Error(
    `Task ${taskId} did not reach the expected state in ${timeoutMs}ms. `
      + `Latest status=${latestSnapshot.task.status}, messageCount=${latestSnapshot.messages.length}.`,
  );
}

test("task init 会写入 Zellij session 信息并补齐运行态", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const panelRecords: Array<{ projectId: string; taskId: string; sessionName: string; cwd: string }> = [];
  const orchestrator = createTestOrchestrator({
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
      setOpenCodeAttachBaseUrl: () => undefined,
    } as never,
  });

  let project = await orchestrator.createProject({ path: projectPath });
  project = await addBuiltinAgents(orchestrator, project.project.id, ["Build"]);
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
  const orchestrator = createTestOrchestrator({
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
      setOpenCodeAttachBaseUrl: () => undefined,
    } as never,
  });

  let project = await orchestrator.createProject({ path: projectPath });
  project = await addBuiltinAgents(orchestrator, project.project.id, ["Build"]);
  const task = await orchestrator.initializeTask({ projectId: project.project.id, title: "demo" });

  assert.equal(task.messages.some((message) => message.meta?.kind === "zellij-missing"), true);
});

test("buildProjectGitDiffSummary 在系统没有 git 时返回空字符串", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const originalPath = process.env.PATH;
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  process.env.PATH = createTempDir();

  try {
    const summary = await (
      orchestrator as unknown as {
        buildProjectGitDiffSummary(cwd: string): Promise<string>;
      }
    ).buildProjectGitDiffSummary(projectPath);

    assert.equal(summary, "");
  } finally {
    process.env.PATH = originalPath;
  }
});

test("OpenCode 事件会触发 runtime-updated 前端事件", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: true,
  });
  const sentEvents: unknown[] = [];
  orchestrator.attachWindow({
    webContents: {
      send: (_channel: string, event: unknown) => {
        sentEvents.push(event);
      },
    },
  } as never);

  let eventHandler: ((event: unknown) => void) | null = null;
  const typed = orchestrator as unknown as Orchestrator & {
    opencodeClient: {
      connectEvents: (projectPath: string, onEvent: (event: unknown) => void) => Promise<void>;
    };
  };
  typed.opencodeClient.connectEvents = async (_projectPath, onEvent) => {
    eventHandler = onEvent;
  };

  const project = await orchestrator.createProject({ path: projectPath });
  assert.notEqual(eventHandler, null);

  eventHandler?.({
    type: "session.updated",
    properties: {
      sessionID: "session-build-1",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 220));

  const runtimeUpdatedEvent = sentEvents.find(
    (event) =>
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      (event as { type?: string }).type === "runtime-updated",
  ) as {
    type: string;
    projectId: string;
    payload?: { sessionId?: string | null };
  } | undefined;

  assert.notEqual(runtimeUpdatedEvent, undefined);
  assert.equal(runtimeUpdatedEvent?.projectId, project.project.id);
  assert.equal(runtimeUpdatedEvent?.payload?.sessionId, "session-build-1");
});

test("内置模板可按 Project 单独覆盖且不会直接写入 agentFiles", async () => {
  const userDataPath = createTempDir();
  const projectAPath = createTempDir();
  const projectBPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  const defaultBaPrompt = DEFAULT_BUILTIN_AGENT_TEMPLATES.find((template) => template.name === "BA")?.prompt;
  assert.notEqual(defaultBaPrompt, undefined);

  const projectA = await orchestrator.createProject({ path: projectAPath });
  assert.equal(projectA.agentFiles.some((agent) => agent.name === "BA"), false);
  assert.equal(
    projectA.builtinAgentTemplates.find((template) => template.name === "BA")?.prompt,
    defaultBaPrompt,
  );

  const updatedProjectA = await orchestrator.saveBuiltinAgentTemplate({
    projectId: projectA.project.id,
    templateName: "BA",
    prompt: "你是 BA（项目 A 定制版）。\n请把需求拆到开发可以直接执行。",
  });
  assert.equal(
    updatedProjectA.builtinAgentTemplates.find((template) => template.name === "BA")?.prompt,
    "你是 BA（项目 A 定制版）。\n请把需求拆到开发可以直接执行。",
  );
  assert.equal(updatedProjectA.agentFiles.some((agent) => agent.name === "BA"), false);

  const projectB = await orchestrator.createProject({ path: projectBPath });
  assert.equal(
    projectB.builtinAgentTemplates.find((template) => template.name === "BA")?.prompt,
    defaultBaPrompt,
  );
  assert.equal(projectB.agentFiles.some((agent) => agent.name === "BA"), false);
});

test("Build 作为内置模板可按需写入 Project，并可像其他 Agent 一样删除", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  const project = await orchestrator.createProject({ path: projectPath });
  assert.equal(project.agentFiles.some((agent) => agent.name === "Build"), false);
  assert.equal(project.builtinAgentTemplates.some((template) => template.name === "Build"), true);

  const withBuild = await addBuiltinAgents(orchestrator, project.project.id, ["Build"]);
  assert.equal(withBuild.agentFiles.some((agent) => agent.name === "Build"), true);
  assert.equal(withBuild.agentFiles.find((agent) => agent.name === "Build")?.isWritable, true);

  const typed = orchestrator as unknown as Orchestrator & {
    customAgentConfig: {
      buildInjectedConfigContent: (projectPath: string) => string | null;
    };
  };
  assert.equal(
    typed.customAgentConfig.buildInjectedConfigContent(projectPath),
    null,
  );

  const withoutBuild = await orchestrator.deleteAgent({
    projectId: project.project.id,
    agentName: "Build",
  });
  assert.equal(withoutBuild.agentFiles.some((agent) => agent.name === "Build"), false);
});

test("删除 Project 会清理运行态与配置，但不会删除项目源码目录", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const deletedSessions: Array<string | null | undefined> = [];
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
    zellijManager: {
      isAvailable: async () => true,
      listSessionNames: async () => new Set<string>(),
      createTaskSession: async (_projectId: string, taskId: string) => `session-${taskId}`,
      createPanelBindings: () => [],
      materializePanelBindings: async () => [],
      openTaskSession: async () => undefined,
      deleteTaskSession: async (sessionName: string | null | undefined) => {
        deletedSessions.push(sessionName);
      },
      setOpenCodeAttachBaseUrl: () => undefined,
    } as never,
  });

  let project = await orchestrator.createProject({ path: projectPath });
  project = await addBuiltinAgents(orchestrator, project.project.id, ["Build"]);
  project = await addCustomAgent(orchestrator, project.project.id, "BA", "你是 BA。");
  const firstTask = await orchestrator.initializeTask({ projectId: project.project.id, title: "task-1" });
  const secondTask = await orchestrator.initializeTask({ projectId: project.project.id, title: "task-2" });

  const typed = orchestrator as unknown as Orchestrator & {
    opencodeClient: {
      setInjectedConfigContent: (projectPath: string, content: string | null) => void;
      servers: Map<string, { runtimeDir: string }>;
    };
  };
  typed.opencodeClient.setInjectedConfigContent(projectPath, "{\"agent\":{}}");
  const runtimeDir = typed.opencodeClient.servers.get(projectPath)?.runtimeDir ?? null;
  assert.notEqual(runtimeDir, null);
  assert.equal(fs.existsSync(runtimeDir), true);

  const statePath = path.join(projectPath, ".agentflow", "state.json");
  const projectDataDir = path.join(projectPath, ".agentflow");
  const customAgentsPath = path.join(userDataPath, "custom-agents.json");
  const customAgentRegistry = JSON.parse(fs.readFileSync(customAgentsPath, "utf8")) as {
    projects?: Record<string, unknown>;
  };
  assert.equal(fs.existsSync(statePath), true);
  assert.equal(
    Object.prototype.hasOwnProperty.call(customAgentRegistry.projects ?? {}, path.resolve(projectPath)),
    true,
  );

  const remainingProjects = await orchestrator.deleteProject({
    projectId: project.project.id,
  });

  assert.equal(remainingProjects.some((snapshot) => snapshot.project.id === project.project.id), false);
  assert.deepEqual(
    deletedSessions.sort(),
    [firstTask.task.zellijSessionId, secondTask.task.zellijSessionId].sort(),
  );
  assert.equal(fs.existsSync(statePath), false);
  assert.equal(fs.existsSync(projectDataDir), false);
  const nextCustomAgentRegistry = JSON.parse(fs.readFileSync(customAgentsPath, "utf8")) as {
    projects?: Record<string, unknown>;
  };
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      nextCustomAgentRegistry.projects ?? {},
      path.resolve(projectPath),
    ),
    false,
  );
  assert.equal(fs.existsSync(runtimeDir), false);
  assert.equal(fs.existsSync(projectPath), true);
  assert.equal(
    (await orchestrator.bootstrap()).some((snapshot) => snapshot.project.id === project.project.id),
    false,
  );
});

test("Build 模板不允许在 AgentFlow 中覆盖 prompt", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  const project = await orchestrator.createProject({ path: projectPath });

  await assert.rejects(
    () =>
      orchestrator.saveBuiltinAgentTemplate({
        projectId: project.project.id,
        templateName: "Build",
        prompt: "不要生效",
      }),
    /Build 使用 OpenCode 内置 prompt，不支持在 AgentFlow 中覆盖模板内容。/,
  );
});

test("为不同 Project 初始化 Task 时会切换 OpenCode 注入配置", async () => {
  const userDataPath = createTempDir();
  const projectAPath = createTempDir();
  const projectBPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
    zellijManager: {
      isAvailable: async () => true,
      createTaskSession: async (_projectId: string, taskId: string) => `oap-${taskId}`,
      createPanelBindings: () => [],
      materializePanelBindings: async () => [],
      openTaskSession: async () => undefined,
      deleteTaskSession: async () => undefined,
      setOpenCodeAttachBaseUrl: () => undefined,
    } as never,
  });

  const typed = orchestrator as unknown as Orchestrator & {
    opencodeClient: {
      setInjectedConfigContent: (projectPath: string, content: string | null) => void;
      createSession: (projectPath: string, title: string) => Promise<string>;
      getAttachBaseUrl: (projectPath: string) => Promise<string>;
    };
  };

  const injectedConfigs: string[] = [];
  typed.opencodeClient.setInjectedConfigContent = (_projectPath, content) => {
    injectedConfigs.push(content ?? "null");
  };
  typed.opencodeClient.createSession = async (_projectPath, title) => `session:${title}`;
  typed.opencodeClient.getAttachBaseUrl = async () => "http://127.0.0.1:4096";

  const projectA = await orchestrator.createProject({ path: projectAPath });
  await addCustomAgent(orchestrator, projectA.project.id, "BA", "你是 BA。\n只做需求分析。");
  let projectB = await orchestrator.createProject({ path: projectBPath });
  projectB = await addBuiltinAgents(orchestrator, projectB.project.id, ["Build"]);

  await orchestrator.initializeTask({ projectId: projectB.project.id, title: "project-b" });
  await orchestrator.initializeTask({ projectId: projectA.project.id, title: "project-a" });

  assert.equal(injectedConfigs.length >= 2, true);
  assert.equal(
    injectedConfigs.includes(
      "null",
    ),
    true,
  );
  assert.equal(
    injectedConfigs.at(-1),
    "{\"agent\":{\"BA\":{\"mode\":\"primary\",\"prompt\":\"你是 BA。\\n只做需求分析。\",\"permission\":{\"write\":\"deny\",\"edit\":\"deny\",\"bash\":\"deny\",\"task\":\"deny\",\"patch\":\"deny\"}}}}",
  );
});

test("未写入 Build 时当前 Project 可以没有可写 Agent", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  const project = await orchestrator.createProject({ path: projectPath });
  await addCustomAgent(orchestrator, project.project.id, "BA", "你是 BA。");

  const typed = orchestrator as unknown as Orchestrator & {
    customAgentConfig: {
      buildInjectedConfigContent: (projectPath: string) => string | null;
    };
  };

  assert.equal(
    typed.customAgentConfig.buildInjectedConfigContent(projectPath),
    "{\"agent\":{\"BA\":{\"mode\":\"primary\",\"prompt\":\"你是 BA。\",\"permission\":{\"write\":\"deny\",\"edit\":\"deny\",\"bash\":\"deny\",\"task\":\"deny\",\"patch\":\"deny\"}}}}",
  );
});

test("Build 写入后会固定为唯一可写 Agent", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  let project = await orchestrator.createProject({ path: projectPath });
  project = await addBuiltinAgents(orchestrator, project.project.id, ["Build"]);
  project = await addCustomAgent(orchestrator, project.project.id, "BA", "你是 BA。", true);

  assert.deepEqual(
    project.agentFiles.map((agent) => [agent.name, agent.isWritable === true]),
    [
      ["Build", true],
      ["BA", false],
    ],
  );

  const typed = orchestrator as unknown as Orchestrator & {
    customAgentConfig: {
      buildInjectedConfigContent: (projectPath: string) => string | null;
    };
  };

  assert.equal(
    typed.customAgentConfig.buildInjectedConfigContent(projectPath),
    "{\"agent\":{\"BA\":{\"mode\":\"primary\",\"prompt\":\"你是 BA。\",\"permission\":{\"write\":\"deny\",\"edit\":\"deny\",\"bash\":\"deny\",\"task\":\"deny\",\"patch\":\"deny\"}}}}",
  );
});

test("把自定义 Agent 设为可写时会自动取消其他自定义 Agent 的可写标记", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
  });

  let project = await orchestrator.createProject({ path: projectPath });
  project = await addCustomAgent(orchestrator, project.project.id, "BA", "你是 BA。", true);
  project = await addCustomAgent(orchestrator, project.project.id, "QA", "你是 QA。", true);

  assert.deepEqual(
    project.agentFiles.map((agent) => [agent.name, agent.isWritable === true]),
    [
      ["BA", false],
      ["QA", true],
    ],
  );
});

test("下游结构化 prompt 会使用 Initial Task 与真实来源 Agent 段标题", async () => {
  const orchestrator = createTestOrchestrator({
    userDataPath: createTempDir(),
    enableEventStream: false,
  });

  const typed = orchestrator as unknown as Orchestrator & {
    buildAgentExecutionPrompt: (prompt: {
      mode: "structured";
      from: string;
      userMessage?: string;
      agentMessage?: string;
      gitDiffSummary?: string;
    }) => string;
  };

  const prompt = typed.buildAgentExecutionPrompt({
    mode: "structured",
    from: "BA",
    userMessage: "在当前项目的一个临时文件中实现一个加法工具，调用后传入 a 和 b，返回 c",
    agentMessage: "这里应该是真实的 AGENT 名称，而不是 at 一个来源，要换成真实的名称。",
    gitDiffSummary: "当前项目 Git Diff 精简摘要：\n工作区状态：\nM electron/main/orchestrator.ts",
  });

  assert.match(prompt, /\[Initial Task\]/);
  assert.match(prompt, /\[From BA Agent\]/);
  assert.doesNotMatch(prompt, /\[@来源 Agent Message\]/);
  assert.match(prompt, /\[Project Git Diff Summary\]/);
  assert.doesNotMatch(prompt, /\[Requeirement\]/);
});

test("下游结构化 prompt 的 [Initial Task] 使用首条用户任务而不是最新用户消息", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
    zellijManager: {
      isAvailable: async () => true,
      createTaskSession: async () => "oap-project-task",
      createPanelBindings: () => [],
      materializePanelBindings: async () => [],
      openTaskSession: async () => undefined,
      deleteTaskSession: async () => undefined,
      setOpenCodeAttachBaseUrl: () => undefined,
    } as never,
  });

  const typed = orchestrator as unknown as Orchestrator & {
    opencodeClient: {
      createSession: (projectPath: string, title: string) => Promise<string>;
      reloadConfig: () => Promise<void>;
    };
    createUserMessage: (
      projectId: string,
      taskId: string,
      taskTitle: string,
      content: string,
      targetAgentId: string,
    ) => {
      id: string;
      projectId: string;
      taskId: string;
      content: string;
      sender: string;
      timestamp: string;
      meta?: Record<string, string>;
    };
    buildDownstreamForwardedContext: (
      taskId: string,
      sourceContent: string,
    ) => { userMessage?: string; agentMessage: string };
    store: {
      insertMessage: (record: {
        id: string;
        projectId: string;
        taskId: string;
        content: string;
        sender: string;
        timestamp: string;
        meta?: Record<string, string>;
      }) => void;
    };
  };

  typed.opencodeClient.createSession = async (_projectPath, title) => `session:${title}`;
  typed.opencodeClient.reloadConfig = async () => undefined;

  let project = await orchestrator.createProject({ path: projectPath });
  project = await addBuiltinAgents(orchestrator, project.project.id, ["Build"]);
  const task = await orchestrator.initializeTask({ projectId: project.project.id, title: "demo" });

  typed.store.insertMessage(
    typed.createUserMessage(
      project.project.id,
      task.task.id,
      task.task.title,
      "@Build 初始任务：实现加法工具",
      "Build",
    ),
  );
  typed.store.insertMessage(
    typed.createUserMessage(
      project.project.id,
      task.task.id,
      task.task.title,
      "@Build 追问：顺便补一份使用说明",
      "Build",
    ),
  );

  const forwarded = typed.buildDownstreamForwardedContext(task.task.id, "Build 已完成实现，等待下游继续处理。");

  assert.equal(forwarded.userMessage, "初始任务：实现加法工具");
  assert.equal(forwarded.agentMessage, "Build 已完成实现，等待下游继续处理。");
});

test("只有第一次 Agent 间传递会携带 [Initial Task]", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
    zellijManager: {
      isAvailable: async () => true,
      createTaskSession: async () => "oap-project-task",
      createPanelBindings: () => [],
      materializePanelBindings: async () => [],
      openTaskSession: async () => undefined,
      deleteTaskSession: async () => undefined,
      setOpenCodeAttachBaseUrl: () => undefined,
    } as never,
  });

  const typed = orchestrator as unknown as Orchestrator & {
    opencodeClient: {
      createSession: (projectPath: string, title: string) => Promise<string>;
      reloadConfig: () => Promise<void>;
    };
    opencodeRunner: {
      run: (payload: { agent: string; content: string }) => Promise<{
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

  const promptByAgent = new Map<string, string[]>();
  const recordPrompt = (agent: string, content: string) => {
    const current = promptByAgent.get(agent) ?? [];
    current.push(content);
    promptByAgent.set(agent, current);
  };
  const completedResponse = (agent: string, content: string) => ({
    status: "completed" as const,
    finalMessage: content,
    fallbackMessage: null,
    messageId: `message:${agent}:${(promptByAgent.get(agent) ?? []).length}`,
    timestamp: "2026-04-15T00:00:00.000Z",
    rawMessage: {
      content,
      error: null,
    },
  });

  typed.opencodeClient.createSession = async (_projectPath, title) => `session:${title}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async ({ agent, content }) => {
    recordPrompt(agent, content);
    if (agent === "BA") {
      return completedResponse(agent, "需求已澄清，交给 Build 继续实现。");
    }
    if (agent === "Build") {
      return completedResponse(agent, "构建已完成，交给 QA 继续验证。");
    }
    return completedResponse(agent, "验证已完成。");
  };

  let project = await orchestrator.createProject({ path: projectPath });
  project = await addBuiltinAgents(orchestrator, project.project.id, ["BA", "Build"]);
  project = await addCustomAgent(orchestrator, project.project.id, "QA", "你是 QA。");
  await orchestrator.saveTopology({
    projectId: project.project.id,
    topology: {
      ...project.topology,
      startAgentId: "BA",
      agentOrderIds: ["BA", "Build", "QA"],
      nodes: [
        { id: "BA", label: "BA", kind: "agent" },
        { id: "Build", label: "Build", kind: "agent" },
        { id: "QA", label: "QA", kind: "agent" },
      ],
      edges: [
        {
          id: "BA__Build__association",
          source: "BA",
          target: "Build",
          triggerOn: "association",
        },
        {
          id: "Build__QA__association",
          source: "Build",
          target: "QA",
          triggerOn: "association",
        },
      ],
    },
  });

  const submittedTask = await orchestrator.submitTask({
    projectId: project.project.id,
    content: "@BA 请实现 add 方法，并补充验证说明。",
  });

  await waitForTaskSnapshot(
    orchestrator,
    submittedTask.task.id,
    (current) =>
      current.task.status === "finished"
      && current.agents.every((agent) => agent.runCount === 1),
  );

  assert.match(promptByAgent.get("Build")?.[0] ?? "", /\[Initial Task\]/u);
  assert.match(promptByAgent.get("Build")?.[0] ?? "", /\[From BA Agent\]/u);
  assert.match(promptByAgent.get("QA")?.[0] ?? "", /\[From Build Agent\]/u);
  assert.doesNotMatch(promptByAgent.get("QA")?.[0] ?? "", /\[Initial Task\]/u);
});

test("审查回流再次派发时不会重复携带 [Initial Task]", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
    zellijManager: {
      isAvailable: async () => true,
      createTaskSession: async () => "oap-project-task",
      createPanelBindings: () => [],
      materializePanelBindings: async () => [],
      openTaskSession: async () => undefined,
      deleteTaskSession: async () => undefined,
      setOpenCodeAttachBaseUrl: () => undefined,
    } as never,
  });

  const typed = orchestrator as unknown as Orchestrator & {
    opencodeClient: {
      createSession: (projectPath: string, title: string) => Promise<string>;
      reloadConfig: () => Promise<void>;
    };
    opencodeRunner: {
      run: (payload: { agent: string; content: string }) => Promise<{
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

  const promptByAgent = new Map<string, string[]>();
  const recordPrompt = (agent: string, content: string) => {
    const current = promptByAgent.get(agent) ?? [];
    current.push(content);
    promptByAgent.set(agent, current);
    return current.length;
  };
  const completedResponse = (agent: string, count: number, content: string) => ({
    status: "completed" as const,
    finalMessage: content,
    fallbackMessage: null,
    messageId: `message:${agent}:${count}`,
    timestamp: `2026-04-15T00:00:0${count}.000Z`,
    rawMessage: {
      content,
      error: null,
    },
  });

  typed.opencodeClient.createSession = async (_projectPath, title) => `session:${title}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async ({ agent, content }) => {
    const count = recordPrompt(agent, content);
    if (agent === "BA") {
      return completedResponse(agent, count, "需求已澄清，交给 Build 继续实现。");
    }
    if (agent === "Build") {
      return count === 1
        ? completedResponse(agent, count, "构建已完成，交给 CodeReview 审查。")
        : completedResponse(agent, count, "已根据审查意见修复完成。");
    }
    return count === 1
      ? completedResponse(
          agent,
          count,
          "审查未通过。\n\n<revision_request> 请修复构建结果。</revision_request>",
        )
      : completedResponse(agent, count, "审查通过。");
  };

  let project = await orchestrator.createProject({ path: projectPath });
  project = await addBuiltinAgents(orchestrator, project.project.id, ["BA", "Build", "CodeReview"]);
  await orchestrator.saveTopology({
    projectId: project.project.id,
    topology: {
      ...project.topology,
      startAgentId: "BA",
      agentOrderIds: ["BA", "Build", "CodeReview"],
      nodes: [
        { id: "BA", label: "BA", kind: "agent" },
        { id: "Build", label: "Build", kind: "agent" },
        { id: "CodeReview", label: "CodeReview", kind: "agent" },
      ],
      edges: [
        {
          id: "BA__Build__association",
          source: "BA",
          target: "Build",
          triggerOn: "association",
        },
        {
          id: "Build__CodeReview__association",
          source: "Build",
          target: "CodeReview",
          triggerOn: "association",
        },
        {
          id: "CodeReview__Build__review_fail",
          source: "CodeReview",
          target: "Build",
          triggerOn: "review_fail",
        },
      ],
    },
  });

  const submittedTask = await orchestrator.submitTask({
    projectId: project.project.id,
    content: "@BA 请实现 add 方法，并准备审查修复。",
  });

  await waitForTaskSnapshot(
    orchestrator,
    submittedTask.task.id,
    () =>
      (promptByAgent.get("Build")?.length ?? 0) >= 2
      && (promptByAgent.get("CodeReview")?.length ?? 0) >= 1,
  );

  assert.match(promptByAgent.get("Build")?.[0] ?? "", /\[Initial Task\]/u);
  assert.doesNotMatch(promptByAgent.get("CodeReview")?.[0] ?? "", /\[Initial Task\]/u);
  assert.match(promptByAgent.get("CodeReview")?.[0] ?? "", /\[From Build Agent\]/u);
  assert.doesNotMatch(promptByAgent.get("Build")?.[1] ?? "", /\[Initial Task\]/u);
  assert.match(promptByAgent.get("Build")?.[1] ?? "", /\[From CodeReview Agent\]/u);
  assert.doesNotMatch(promptByAgent.get("Build")?.[1] ?? "", new RegExp(REVIEW_RESPONSE_LABEL, "u"));
  assert.doesNotMatch(promptByAgent.get("Build")?.[1] ?? "", new RegExp(REVIEW_RESPONSE_END_LABEL, "u"));
});

test("审视类 system prompt 会使用真实来源 Agent 名称", () => {
  const orchestrator = createTestOrchestrator({
    userDataPath: createTempDir(),
    enableEventStream: false,
  });

  const typed = orchestrator as unknown as Orchestrator & {
    createSystemPrompt: (
      agent: { name: string },
      topology: { edges: Array<{ source: string; target: string; triggerOn: "association" | "review_fail" | "review_pass" }> },
      prompt: {
        mode: "structured";
        from: string;
        userMessage?: string;
        agentMessage?: string;
        gitDiffSummary?: string;
      },
    ) => string;
  };

  const systemPrompt = typed.createSystemPrompt(
    { name: "TaskReview" },
    {
      edges: [
        {
          source: "Build",
          target: "TaskReview",
          triggerOn: "association",
        },
        {
          source: "TaskReview",
          target: "Build",
          triggerOn: "review_fail",
        },
      ],
    },
    {
      mode: "structured",
      from: "BA",
      agentMessage: "这里应该替换成真实来源 Agent。",
    },
  );

  assert.match(systemPrompt, /你需要对 `\[From BA Agent\]` 做出回应。/);
  assert.doesNotMatch(systemPrompt, /\[@来源 Agent Message\]/);
});

test("Task 启动后不允许再修改 Agent 配置或内置模板", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
    zellijManager: {
      isAvailable: async () => true,
      createTaskSession: async () => "oap-project-task",
      createPanelBindings: () => [],
      materializePanelBindings: async () => [],
      openTaskSession: async () => undefined,
      deleteTaskSession: async () => undefined,
      setOpenCodeAttachBaseUrl: () => undefined,
    } as never,
  });

  let project = await orchestrator.createProject({ path: projectPath });
  project = await addCustomAgent(orchestrator, project.project.id, "BA", "你是 BA。");
  await orchestrator.initializeTask({ projectId: project.project.id, title: "demo" });

  await assert.rejects(
    () =>
      orchestrator.saveAgentPrompt({
        projectId: project.project.id,
        currentAgentName: "BA",
        nextAgentName: "BA",
        prompt: "你是新的 BA。",
      }),
    /当前 Project 已有 Task 启动记录，不允许再修改 Agent 配置。/,
  );

  await assert.rejects(
    () =>
      orchestrator.saveBuiltinAgentTemplate({
        projectId: project.project.id,
        templateName: "BA",
        prompt: "你是模板 BA。",
      }),
    /当前 Project 已有 Task 启动记录，不允许再修改内置模板。/,
  );

  await assert.rejects(
    () =>
      orchestrator.resetBuiltinAgentTemplate({
        projectId: project.project.id,
        templateName: "BA",
      }),
    /当前 Project 已有 Task 启动记录，不允许再修改内置模板。/,
  );
});

test("审视通过但没有可展示结果正文时返回简洁兜底文案", () => {
  const orchestrator = createTestOrchestrator({
    userDataPath: createTempDir(),
    enableEventStream: false,
  });

  const displayContent = (
    orchestrator as unknown as {
      createDisplayContent: (
        parsedReview: {
          cleanContent: string;
          decision: "pass" | "needs_revision" | "unknown";
          opinion: string | null;
          rawDecisionBlock: string | null;
        },
        fallbackMessage?: string | null,
      ) => string;
    }
  ).createDisplayContent(
    {
      cleanContent: "",
      decision: "pass",
      opinion: null,
      rawDecisionBlock: null,
    },
    null,
  );

  assert.equal(displayContent, "通过");
});

test("审视不通过且只返回 revision_request 标签时，群聊展示会去掉标签", () => {
  const orchestrator = createTestOrchestrator({
    userDataPath: createTempDir(),
    enableEventStream: false,
  });

  const displayContent = (
    orchestrator as unknown as {
      createDisplayContent: (
        parsedReview: {
          cleanContent: string;
          decision: "pass" | "needs_revision" | "unknown";
          opinion: string | null;
          rawDecisionBlock: string | null;
        },
        fallbackMessage?: string | null,
      ) => string;
    }
  ).createDisplayContent(
    {
      cleanContent: "",
      decision: "needs_revision",
      opinion: "请继续补充实现依据。",
      rawDecisionBlock: "<revision_request> 请继续补充实现依据。",
    },
    null,
  );

  assert.equal(displayContent, "请继续补充实现依据。");
});

test("群聊保留 @Agent，但下游转发读取的用户消息会去掉寻址 @Agent", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
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
          id: `${taskId}:BA`,
          taskId,
          projectId,
          sessionName,
          paneId: "pane-1",
          agentName: "BA",
          cwd,
          order: 0,
        },
      ],
      materializePanelBindings: async () => [],
      openTaskSession: async () => undefined,
      deleteTaskSession: async () => undefined,
      setOpenCodeAttachBaseUrl: () => undefined,
    } as never,
  });

  const project = await orchestrator.createProject({ path: projectPath });
  await addBuiltinAgents(orchestrator, project.project.id, ["BA"]);
  const task = await orchestrator.initializeTask({ projectId: project.project.id, title: "demo" });

  const typed = orchestrator as unknown as Orchestrator & {
    store: {
      insertMessage: (message: {
        id: string;
        projectId: string;
        taskId: string | null;
        content: string;
        sender: "user" | "system" | string;
        timestamp: string;
        meta?: Record<string, string>;
      }) => void;
    };
    getInitialUserMessageContent: (taskId: string) => string;
  };

  typed.store.insertMessage({
    id: "user-message-1",
    projectId: project.project.id,
    taskId: task.task.id,
    content: "在当前项目的一个临时文件中实现一个加法工具，调用后传入a和b，返回c @BA",
    sender: "user",
    timestamp: new Date().toISOString(),
    meta: {
      scope: "task",
      taskTitle: task.task.title,
      targetAgentId: "BA",
    },
  });

  const forwardedUserContent = typed.getInitialUserMessageContent(task.task.id);
  assert.equal(forwardedUserContent.includes("@BA"), false);
  assert.equal(forwardedUserContent.includes("返回c"), true);

  const snapshot = await orchestrator.getTaskSnapshot(task.task.id);
  const latestUserMessage = snapshot.messages.filter((message) => message.sender === "user").at(-1);
  assert.equal(latestUserMessage?.content.includes("@BA"), true);
});

test("审视 Agent 执行中止时不会伪造成整改意见", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
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
      setOpenCodeAttachBaseUrl: () => undefined,
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

  let project = await orchestrator.createProject({ path: projectPath });
  project = await addBuiltinAgents(orchestrator, project.project.id, ["Build", "CodeReview"]);
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
      (message) => message.content.includes("<revision_request> Aborted"),
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

test("Task 进入 finished 状态时会统一把所有 Agent 节点显示为已完成，并追加结束系统消息", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();

  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
    zellijManager: {
      isAvailable: async () => true,
      createTaskSession: async () => "oap-project-task",
      createPanelBindings: () => [],
      materializePanelBindings: async () => [],
      openTaskSession: async () => undefined,
      deleteTaskSession: async () => undefined,
      setOpenCodeAttachBaseUrl: () => undefined,
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
        status: "idle" | "completed" | "failed" | "running" | "needs_revision",
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

  let project = await orchestrator.createProject({ path: projectPath });
  project = await addBuiltinAgents(orchestrator, project.project.id, ["Build"]);
  project = await addCustomAgent(orchestrator, project.project.id, "QA", "你是 QA。");
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
        message.content.includes("所有Agent任务已完成"),
    ),
    true,
  );
});

test("Build 在收到 UnitTest 回流后再次交付时会重新触发全部 association 下游", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
    zellijManager: {
      isAvailable: async () => true,
      createTaskSession: async () => "oap-project-task",
      createPanelBindings: () => [],
      materializePanelBindings: async () => [],
      openTaskSession: async () => undefined,
      deleteTaskSession: async () => undefined,
      setOpenCodeAttachBaseUrl: () => undefined,
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
      ? "单元测试覆盖与结构检查完成，未发现阻塞问题。"
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

  let project = await orchestrator.createProject({ path: projectPath });
  project = await addBuiltinAgents(orchestrator, project.project.id, ["Build", "UnitTest", "CodeReview"]);
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
  assert.equal(callCount.get("Build"), 2);
  assert.equal(callCount.get("UnitTest"), 2);
  assert.equal(callCount.get("CodeReview"), 2);
  assert.deepEqual(
    snapshot.agents.map((agent) => [agent.name, agent.runCount]),
    [
      ["Build", 2],
      ["CodeReview", 2],
      ["UnitTest", 2],
    ],
  );
});

test("旧运行数据里悬空 idle Agent 不会阻止 Task 自动结束", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
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
      setOpenCodeAttachBaseUrl: () => undefined,
    } as never,
  });

  const typed = orchestrator as unknown as Orchestrator & {
    store: {
      updateTaskStatus: (taskId: string, status: "running" | "finished" | "waiting" | "failed", completedAt: string | null) => void;
      updateTaskAgentStatus: (taskId: string, agentName: string, status: "idle" | "completed" | "failed" | "running" | "needs_revision") => void;
    };
  };

  let project = await orchestrator.createProject({ path: projectPath });
  project = await addBuiltinAgents(
    orchestrator,
    project.project.id,
    ["Build", "BA", "UnitTest", "TaskReview", "CodeReview"],
  );
  project = await addCustomAgent(
    orchestrator,
    project.project.id,
    "IntegrationTest",
    "你是集成测试角色，负责验证跨模块集成与关键路径。",
  );
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
  typed.store.updateTaskAgentStatus(task.task.id, "BA", "completed");
  typed.store.updateTaskAgentStatus(task.task.id, "Build", "completed");
  typed.store.updateTaskAgentStatus(task.task.id, "UnitTest", "completed");
  typed.store.updateTaskAgentStatus(task.task.id, "TaskReview", "completed");
  typed.store.updateTaskAgentStatus(task.task.id, "CodeReview", "completed");
  typed.store.updateTaskAgentStatus(task.task.id, "IntegrationTest", "idle");

  const snapshot = await orchestrator.getTaskSnapshot(task.task.id);
  assert.equal(snapshot.task.status, "finished");
  assert.notEqual(snapshot.task.completedAt, null);
  assert.deepEqual(
    snapshot.agents.map((agent) => [agent.name, agent.status]),
    [
      ["BA", "completed"],
      ["Build", "completed"],
      ["CodeReview", "completed"],
      ["IntegrationTest", "completed"],
      ["TaskReview", "completed"],
      ["UnitTest", "completed"],
    ],
  );
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

test("最新一条仍是用户 @Agent 追问时，持久化补偿逻辑不会提前把 Task 判 finished", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
    zellijManager: {
      isAvailable: async () => true,
      createTaskSession: async () => "oap-project-task",
      createPanelBindings: () => [],
      materializePanelBindings: async () => [],
      openTaskSession: async () => undefined,
      deleteTaskSession: async () => undefined,
      setOpenCodeAttachBaseUrl: () => undefined,
    } as never,
  });

  const typed = orchestrator as unknown as Orchestrator & {
    store: {
      updateTaskStatus: (taskId: string, status: "running" | "finished" | "waiting" | "failed", completedAt: string | null) => void;
      updateTaskAgentStatus: (taskId: string, agentName: string, status: "idle" | "completed" | "failed" | "running" | "needs_revision") => void;
      insertMessage: (record: MessageRecord) => void;
    };
    opencodeClient: {
      createSession: (projectPath: string, title: string) => Promise<string>;
      reloadConfig: () => Promise<void>;
    };
  };
  typed.opencodeClient.createSession = async (_projectPath, title) => `session:${title}`;
  typed.opencodeClient.reloadConfig = async () => undefined;

  let project = await orchestrator.createProject({ path: projectPath });
  project = await addBuiltinAgents(orchestrator, project.project.id, ["UnitTest"]);
  const task = await orchestrator.initializeTask({ projectId: project.project.id, title: "demo" });

  typed.store.updateTaskStatus(task.task.id, "running", null);
  typed.store.updateTaskAgentStatus(task.task.id, "UnitTest", "completed");
  typed.store.insertMessage({
    id: "user-follow-up",
    projectId: project.project.id,
    taskId: task.task.id,
    sender: "user",
    content: "@UnitTest 你的指责呢",
    timestamp: "2099-04-16T07:37:07.938Z",
    meta: {
      scope: "task",
      taskTitle: task.task.title,
      targetAgentId: "UnitTest",
    },
  });

  const snapshot = await orchestrator.getTaskSnapshot(task.task.id);
  assert.equal(snapshot.task.status, "running");
  assert.equal(snapshot.messages.at(-1)?.sender, "user");
  assert.equal(
    snapshot.messages.some(
      (message) =>
        message.sender === "system" &&
        message.meta?.kind === "task-completed" &&
        message.timestamp > "2099-04-16T07:37:07.938Z",
    ),
    false,
  );
});

test("bootstrap does not delete unfinished tasks when zellij sessions are missing", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const zellijManager = {
    isAvailable: async () => true,
    listSessionNames: async () => new Set<string>(),
    createTaskSession: async (_projectId: string, taskId: string) => `session-${taskId}`,
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
    setOpenCodeAttachBaseUrl: () => undefined,
  } as never;

  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
    zellijManager,
  });
  let project = await orchestrator.createProject({ path: projectPath });
  project = await addBuiltinAgents(orchestrator, project.project.id, ["Build"]);
  const task = await orchestrator.initializeTask({ projectId: project.project.id, title: "demo" });

  const reloaded = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
    zellijManager,
  });
  const snapshots = await reloaded.bootstrap();
  const reloadedProject = snapshots.find((snapshot) => snapshot.project.id === project.project.id);

  assert.notEqual(reloadedProject, undefined);
  assert.equal(reloadedProject?.tasks.some((item) => item.task.id === task.task.id), true);
});

test("BA dispatches Build through three review passes before the task can finish", async () => {
  const userDataPath = createTempDir();
  const projectPath = createTempDir();
  const orchestrator = createTestOrchestrator({
    userDataPath,
    enableEventStream: false,
    zellijManager: {
      isAvailable: async () => true,
      createTaskSession: async () => "oap-project-task",
      createPanelBindings: () => [],
      materializePanelBindings: async () => [],
      openTaskSession: async () => undefined,
      deleteTaskSession: async () => undefined,
      setOpenCodeAttachBaseUrl: () => undefined,
    } as never,
  });

  const typed = orchestrator as unknown as Orchestrator & {
    opencodeClient: {
      createSession: (projectPath: string, title: string) => Promise<string>;
      reloadConfig: () => Promise<void>;
    };
    opencodeRunner: {
      run: (payload: { agent: string; content: string }) => Promise<{
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

  const addFilePath = path.join(projectPath, "add.js");
  const callCount = new Map<string, number>();

  const readBuildAttemptFromFile = () => {
    if (!fs.existsSync(addFilePath)) {
      return 0;
    }
    const content = fs.readFileSync(addFilePath, "utf8");
    const matched = content.match(/build attempt (\d+)/u);
    return matched ? Number(matched[1]) : 0;
  };

  const completedResponse = (agent: string, count: number, finalMessage: string) => ({
    status: "completed" as const,
    finalMessage,
    fallbackMessage: null,
    messageId: `message:${agent}:${count}`,
    timestamp: `2026-04-15T00:00:${String(count).padStart(2, "0")}.000Z`,
    rawMessage: {
      content: finalMessage,
      error: null,
    },
  });

  typed.opencodeClient.createSession = async (_projectPath, title) => `session:${title}`;
  typed.opencodeClient.reloadConfig = async () => undefined;
  typed.opencodeRunner.run = async ({ agent, content }) => {
    const count = (callCount.get(agent) ?? 0) + 1;
    callCount.set(agent, count);

    if (agent === "BA") {
      return completedResponse(
        agent,
        count,
        [
          "# 实现要求",
          "",
          "1. 在工作区根目录创建 add.js。",
          "2. 导出一个 add(a, b) 方法。",
          "3. 每次修复都要覆盖写回 add.js。",
        ].join("\n"),
      );
    }

    if (agent === "Build") {
      if (count === 1) {
        assert.match(content, /\[Initial Task\]/u);
        assert.match(content, /\[From BA Agent\]/u);
      }
      fs.writeFileSync(
        addFilePath,
        [
          `// build attempt ${count}`,
          "function add(a, b) {",
          "  return a + b;",
          "}",
          "",
          "module.exports = add;",
          "",
        ].join("\n"),
        "utf8",
      );
      return completedResponse(
        agent,
        count,
        `已将 add.js 写入工作区，第 ${count} 次构建完成。`,
      );
    }

    const buildAttempt = readBuildAttemptFromFile();
    if (agent === "UnitTest") {
      return buildAttempt >= 2
        ? completedResponse(agent, count, "单元测试通过，进入下一段审查。")
        : completedResponse(
            agent,
            count,
            "单元测试未通过，缺少稳定交付版本。\n\n<revision_request> 请继续修复 add.js 并重新提交。",
          );
    }

    if (agent === "CodeReview") {
      return buildAttempt >= 3
        ? completedResponse(agent, count, "代码审查通过，进入最终交付审查。")
        : completedResponse(
            agent,
            count,
            "代码审查未通过，当前实现还不够稳定。\n\n<revision_request> 请继续完善 add.js 的最终实现。",
          );
    }

    if (agent === "TaskReview") {
      return buildAttempt >= 4
        ? completedResponse(agent, count, "任务交付通过，当前结果可以结束。")
        : completedResponse(
            agent,
            count,
            "最终交付未通过，需要再补一轮稳定交付。\n\n<revision_request> 请继续修复并重新交付。",
          );
    }

    return completedResponse(agent, count, `${agent} 已完成。`);
  };

  let project = await orchestrator.createProject({ path: projectPath });
  project = await addBuiltinAgents(
    orchestrator,
    project.project.id,
    ["BA", "Build", "UnitTest", "CodeReview", "TaskReview"],
    "Build",
  );
  await orchestrator.saveTopology({
    projectId: project.project.id,
    topology: {
      ...project.topology,
      startAgentId: "BA",
      agentOrderIds: ["BA", "Build", "UnitTest", "CodeReview", "TaskReview"],
      nodes: [
        { id: "BA", label: "BA", kind: "agent" },
        { id: "Build", label: "Build", kind: "agent" },
        { id: "UnitTest", label: "UnitTest", kind: "agent" },
        { id: "CodeReview", label: "CodeReview", kind: "agent" },
        { id: "TaskReview", label: "TaskReview", kind: "agent" },
      ],
      edges: [
        {
          id: "BA__Build__association",
          source: "BA",
          target: "Build",
          triggerOn: "association",
        },
        {
          id: "Build__UnitTest__association",
          source: "Build",
          target: "UnitTest",
          triggerOn: "association",
        },
        {
          id: "UnitTest__Build__review_fail",
          source: "UnitTest",
          target: "Build",
          triggerOn: "review_fail",
        },
        {
          id: "UnitTest__CodeReview__review_pass",
          source: "UnitTest",
          target: "CodeReview",
          triggerOn: "review_pass",
        },
        {
          id: "CodeReview__Build__review_fail",
          source: "CodeReview",
          target: "Build",
          triggerOn: "review_fail",
        },
        {
          id: "CodeReview__TaskReview__review_pass",
          source: "CodeReview",
          target: "TaskReview",
          triggerOn: "review_pass",
        },
        {
          id: "TaskReview__Build__review_fail",
          source: "TaskReview",
          target: "Build",
          triggerOn: "review_fail",
        },
      ],
    },
  });

  const submittedTask = await orchestrator.submitTask({
    projectId: project.project.id,
    content: "@BA 请实现 add 方法，并把结果写入 add.js。",
  });

  const snapshot = await waitForTaskSnapshot(
    orchestrator,
    submittedTask.task.id,
    (current) => current.task.status === "finished",
  );

  assert.equal(snapshot.task.status, "finished");
  assert.notEqual(snapshot.task.completedAt, null);
  assert.equal(fs.existsSync(addFilePath), true);
  assert.equal(readBuildAttemptFromFile(), 4);
  assert.match(fs.readFileSync(addFilePath, "utf8"), /module\.exports = add;/u);
  assert.equal(callCount.get("BA"), 1);
  assert.equal(callCount.get("Build"), 4);
  assert.equal(callCount.get("UnitTest"), 4);
  assert.equal(callCount.get("CodeReview"), 3);
  assert.equal(callCount.get("TaskReview"), 2);
  assert.equal(
    snapshot.messages.some(
      (message) =>
        message.sender === "BA"
        && message.meta?.kind === "agent-dispatch"
        && message.meta?.targetAgentIds === "Build",
    ),
    true,
  );
  assert.equal(
    snapshot.messages.filter(
      (message) =>
        message.meta?.kind === "revision-request"
        && message.meta?.targetAgentId === "Build",
    ).length,
    3,
  );
  assert.equal(
    snapshot.messages
      .filter(
        (message) =>
          message.meta?.kind === "revision-request"
          && message.meta?.targetAgentId === "Build",
      )
      .every(
        (message) =>
          !message.content.includes(REVIEW_RESPONSE_LABEL)
          && !message.content.includes(REVIEW_RESPONSE_END_LABEL),
      ),
    true,
  );
  assert.equal(
    snapshot.messages
      .filter(
        (message) =>
          message.meta?.kind === "revision-request"
          && message.meta?.targetAgentId === "Build",
      )
      .every((message) => !message.content.includes("审视不通过，请回应以下内容")),
    true,
  );
  assert.deepEqual(
    snapshot.agents.map((agent) => [agent.name, agent.runCount, agent.status]),
    [
      ["BA", 1, "completed"],
      ["Build", 4, "completed"],
      ["CodeReview", 3, "completed"],
      ["TaskReview", 2, "completed"],
      ["UnitTest", 4, "completed"],
    ],
  );
});
