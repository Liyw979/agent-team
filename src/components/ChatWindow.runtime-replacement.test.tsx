import test from "node:test";
import assert from "node:assert/strict";

import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { TaskSnapshot, WorkspaceSnapshot } from "@shared/types";

import { ChatWindow } from "./ChatWindow";

type GlobalPatchKey =
  | "window"
  | "document"
  | "navigator"
  | "HTMLElement"
  | "HTMLDivElement"
  | "HTMLButtonElement"
  | "HTMLTextAreaElement"
  | "Node"
  | "Event"
  | "MouseEvent"
  | "KeyboardEvent"
  | "ResizeObserver"
  | "requestAnimationFrame"
  | "cancelAnimationFrame"
  | "getComputedStyle"
  | "IS_REACT_ACT_ENVIRONMENT";

type GlobalPatch = {
  existed: boolean;
  value: unknown;
};

class MockResizeObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function setupDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const previousValues = new Map<GlobalPatchKey, GlobalPatch>();

  function setGlobal(key: GlobalPatchKey, value: unknown) {
    previousValues.set(key, {
      existed: key in globalThis,
      value: (globalThis as Record<string, unknown>)[key],
    });
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  setGlobal("window", dom.window);
  setGlobal("document", dom.window.document);
  setGlobal("navigator", dom.window.navigator);
  setGlobal("HTMLElement", dom.window.HTMLElement);
  setGlobal("HTMLDivElement", dom.window.HTMLDivElement);
  setGlobal("HTMLButtonElement", dom.window.HTMLButtonElement);
  setGlobal("HTMLTextAreaElement", dom.window.HTMLTextAreaElement);
  setGlobal("Node", dom.window.Node);
  setGlobal("Event", dom.window.Event);
  setGlobal("MouseEvent", dom.window.MouseEvent);
  setGlobal("KeyboardEvent", dom.window.KeyboardEvent);
  setGlobal("ResizeObserver", MockResizeObserver);
  setGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(dom.window.performance.now()), 0),
  );
  setGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) =>
    clearTimeout(id),
  );
  setGlobal("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  return {
    dom,
    cleanup() {
      for (const [key, patch] of previousValues) {
        if (patch.existed) {
          Object.defineProperty(globalThis, key, {
            configurable: true,
            writable: true,
            value: patch.value,
          });
          continue;
        }
        delete (globalThis as Record<string, unknown>)[key];
      }
      dom.window.close();
    },
  };
}

function createWorkspaceAndTask(): {
  workspace: WorkspaceSnapshot;
  task: TaskSnapshot;
} {
  const topology: WorkspaceSnapshot["topology"] = {
    nodes: ["线索发现", "漏洞挑战", "漏洞论证", "讨论总结", "疑点辩论"],
    edges: [
      {
        source: "线索发现",
        target: "疑点辩论",
        trigger: "<continue>",
        messageMode: "last-all" as const,
      },
    ],
    nodeRecords: [
      { id: "线索发现", kind: "agent" as const, templateName: "线索发现" },
      {
        id: "疑点辩论",
        kind: "spawn" as const,
        templateName: "疑点辩论",
        spawnRuleId: "spawn-rule:疑点辩论",
      },
      { id: "漏洞挑战", kind: "agent" as const, templateName: "漏洞挑战" },
      { id: "漏洞论证", kind: "agent" as const, templateName: "漏洞论证" },
      { id: "讨论总结", kind: "agent" as const, templateName: "讨论总结" },
    ],
    spawnRules: [
      {
        id: "spawn-rule:疑点辩论",
        spawnNodeName: "疑点辩论",
        sourceTemplateName: "线索发现",
        entryRole: "漏洞挑战",
        spawnedAgents: [
          { role: "漏洞挑战", templateName: "漏洞挑战" },
          { role: "漏洞论证", templateName: "漏洞论证" },
          { role: "讨论总结", templateName: "讨论总结" },
        ],
        edges: [
          {
            sourceRole: "漏洞挑战",
            targetRole: "漏洞论证",
            trigger: "<continue>",
            messageMode: "last" as const,
            maxTriggerRounds: 4,
          },
          {
            sourceRole: "漏洞论证",
            targetRole: "漏洞挑战",
            trigger: "<continue>",
            messageMode: "last" as const,
            maxTriggerRounds: 4,
          },
          {
            sourceRole: "漏洞挑战",
            targetRole: "讨论总结",
            trigger: "<complete>",
            messageMode: "last-all" as const,
          },
          {
            sourceRole: "漏洞论证",
            targetRole: "讨论总结",
            trigger: "<complete>",
            messageMode: "last-all" as const,
          },
        ],
        exitWhen: "all_completed",
        reportToTemplateName: "线索发现",
        reportToTrigger: "<default>" as const,
        reportToMessageMode: "none" as const,
      },
    ],
  };

  const workspace: WorkspaceSnapshot = {
    cwd: "/tmp/agent-team-chat-window-runtime-replacement",
    name: "agent-team-chat-window-runtime-replacement",
    agents: [
      { id: "线索发现", prompt: "发现", isWritable: false },
      { id: "漏洞挑战", prompt: "挑战", isWritable: false },
      { id: "漏洞论证", prompt: "论证", isWritable: false },
      { id: "讨论总结", prompt: "总结", isWritable: true },
    ],
    topology,
    messages: [],
    tasks: [],
  };

  const task: TaskSnapshot = {
    task: {
      id: "task-chat-window-runtime-replacement",
      title: "runtime replacement",
      status: "running",
      cwd: workspace.cwd,
      opencodeSessionId: null,
      agentCount: 4,
      createdAt: "2026-04-30T10:00:00.000Z",
      completedAt: null,
      initializedAt: "2026-04-30T10:00:00.000Z",
    },
    agents: [
      {
        id: "线索发现",
        taskId: "task-chat-window-runtime-replacement",
        opencodeSessionId: "session-clue",
        opencodeAttachBaseUrl: "http://localhost:4310",
        status: "completed",
        runCount: 1,
      },
      {
        id: "漏洞挑战-1",
        taskId: "task-chat-window-runtime-replacement",
        opencodeSessionId: "session-challenge-1",
        opencodeAttachBaseUrl: "http://localhost:4310",
        status: "running",
        runCount: 1,
      },
    ],
    messages: [
      {
        id: "clue-final",
        taskId: "task-chat-window-runtime-replacement",
        sender: "线索发现",
        content: "发现第 1 个可疑点：上传文件名可能被直接拼进目标路径。",
        timestamp: "2026-04-30T10:00:00.000Z",
        kind: "agent-final",
        runCount: 1,
        status: "completed",
        routingKind: "default",
        responseNote: "",
        rawResponse: "发现第 1 个可疑点：上传文件名可能被直接拼进目标路径。",
      },
      {
        id: "clue-dispatch",
        taskId: "task-chat-window-runtime-replacement",
        sender: "线索发现",
        content: "@漏洞挑战-1",
        timestamp: "2026-04-30T10:00:00.500Z",
        kind: "agent-dispatch",
        targetAgentIds: ["漏洞挑战-1"],
        targetRunCounts: [1],
        dispatchDisplayContent: "@漏洞挑战-1",
      },
    ],
    topology,
  };

  return { workspace, task };
}

test("ChatWindow 会在 agent 结束后移除动态面板，并由最终消息接管原位置", async () => {
  const domContext = setupDom();
  const container = domContext.dom.window.document.createElement("div");
  domContext.dom.window.document.body.append(container);
  const root = createRoot(container);
  const { workspace, task } = createWorkspaceAndTask();

  const runningTask: TaskSnapshot = {
    ...task,
    messages: [
      ...task.messages,
      {
        id: "challenge-progress",
        taskId: task.task.id,
        sender: "漏洞挑战-1",
        content: "正在检查上传路径的约束条件",
        timestamp: "2026-04-30T10:00:01.000Z",
        kind: "agent-progress",
        activityKind: "thinking",
        label: "思考",
        detail: "正在检查上传路径的约束条件",
        detailState: "not_applicable",
        sessionId: "session-challenge-1",
        runCount: 1,
      },
    ],
  };

  const settledTask: TaskSnapshot = {
    ...task,
    agents: [
      task.agents[0]!,
      {
        id: "漏洞挑战-1",
        taskId: task.task.id,
        opencodeSessionId: "session-challenge-1",
        opencodeAttachBaseUrl: "http://localhost:4310",
        status: "completed",
        runCount: 1,
      },
      {
        id: "漏洞论证-1",
        taskId: task.task.id,
        opencodeSessionId: "session-argument-1",
        opencodeAttachBaseUrl: "http://localhost:4310",
        status: "running",
        runCount: 1,
      },
    ],
    messages: [
      ...task.messages,
      {
        id: "challenge-final",
        taskId: task.task.id,
        sender: "漏洞挑战-1",
        content: "当前证据不足以证明这里一定能越界写入。\n\n@漏洞论证-1",
        timestamp: "2026-04-30T10:00:02.000Z",
        kind: "agent-final",
        runCount: 1,
        status: "completed",
        routingKind: "labeled",
        trigger: "<continue>",
        responseNote: "当前证据不足以证明这里一定能越界写入。",
        rawResponse: "<continue> 当前证据不足以证明这里一定能越界写入。",
      },
      {
        id: "challenge-request",
        taskId: task.task.id,
        sender: "漏洞挑战-1",
        content: "当前证据不足以证明这里一定能越界写入。\n\n@漏洞论证-1",
        timestamp: "2026-04-30T10:00:03.000Z",
        kind: "action-required-request",
        followUpMessageId: "challenge-final",
        targetAgentIds: ["漏洞论证-1"],
        targetRunCounts: [1],
      },
    ],
  };
  const nextTask: TaskSnapshot = {
    ...settledTask,
    messages: [
      ...settledTask.messages,
      {
        id: "argument-progress",
        taskId: task.task.id,
        sender: "漏洞论证-1",
        content: "正在补充漏洞成立所需的代码证据",
        timestamp: "2026-04-30T10:00:04.000Z",
        kind: "agent-progress",
        activityKind: "thinking",
        label: "思考",
        detail: "正在补充漏洞成立所需的代码证据",
        detailState: "not_applicable",
        sessionId: "session-argument-1",
        runCount: 1,
      },
    ],
  };

  try {
    await act(async () => {
      root.render(
        <ChatWindow
          workspace={workspace}
          task={runningTask}
          availableAgents={["线索发现", "漏洞挑战", "漏洞论证", "讨论总结"]}
          taskLogFilePath={null}
          taskUrl={null}
          openingAgentTerminalId=""
          onSubmit={async () => undefined}
        />,
      );
    });

    let text = container.textContent ?? "";
    assert.match(text, /正在检查上传路径的约束条件/);
    assert.equal(container.querySelectorAll('[aria-label="运行中"]').length, 1);

    await act(async () => {
      root.render(
        <ChatWindow
          workspace={workspace}
          task={nextTask}
          availableAgents={["线索发现", "漏洞挑战", "漏洞论证", "讨论总结"]}
          taskLogFilePath={null}
          taskUrl={null}
          openingAgentTerminalId=""
          onSubmit={async () => undefined}
        />,
      );
    });

    text = container.textContent ?? "";
    assert.doesNotMatch(text, /正在检查上传路径的约束条件/);
    assert.equal(container.querySelectorAll('[aria-label="运行中"]').length, 1);
    assert.match(text, /当前证据不足以证明这里一定能越界写入/);
    assert.match(text, /@漏洞论证-1/);
    assert.match(text, /正在补充漏洞成立所需的代码证据/);
    const senderLabels = Array.from(container.querySelectorAll("span"))
      .map((element) => element.textContent?.trim() ?? "")
      .filter(Boolean);
    assert.equal(
      senderLabels.filter((label) => label === "漏洞挑战-1").length,
      1,
    );
    assert.equal(
      senderLabels.filter((label) => label === "漏洞论证-1").length,
      1,
    );
    const challengeFinalIndex =
      text.indexOf("当前证据不足以证明这里一定能越界写入");
    const argumentRuntimeIndex = text.indexOf("正在补充漏洞成立所需的代码证据");
    assert.equal(challengeFinalIndex >= 0, true);
    assert.equal(argumentRuntimeIndex > challengeFinalIndex, true);
  } finally {
    await act(async () => {
      root.unmount();
    });
    domContext.cleanup();
  }
});
