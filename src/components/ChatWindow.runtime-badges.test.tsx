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
    nodes: [
      "Build",
      "QA",
      "线索发现",
      "漏洞挑战",
      "漏洞论证",
      "讨论总结",
      "疑点辩论",
    ],
    edges: [
      {
        source: "线索发现",
        target: "疑点辩论",
        trigger: "<continue>",
        messageMode: "last-all" as const,
      },
    ],
    nodeRecords: [
      { id: "Build", kind: "agent" as const, templateName: "Build" },
      { id: "QA", kind: "agent" as const, templateName: "QA" },
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
    cwd: "/tmp/agent-team-chat-window",
    name: "agent-team-chat-window",
    agents: [
      { id: "Build", prompt: "实现", isWritable: true },
      { id: "QA", prompt: "验证", isWritable: false },
      { id: "线索发现", prompt: "发现", isWritable: false },
    ],
    topology,
    messages: [],
    tasks: [],
  };

  const task: TaskSnapshot = {
    task: {
      id: "task-chat-window-runtime-badges",
      title: "runtime badges",
      status: "running",
      cwd: workspace.cwd,
      opencodeSessionId: null,
      agentCount: 5,
      createdAt: "2026-04-29T10:00:00.000Z",
      completedAt: null,
      initializedAt: "2026-04-29T10:00:00.000Z",
    },
    agents: [
      {
        id: "Build",
        taskId: "task-chat-window-runtime-badges",
        opencodeSessionId: "session-build",
        opencodeAttachBaseUrl: "http://localhost:4310",
        status: "running",
        runCount: 1,
      },
      {
        id: "QA",
        taskId: "task-chat-window-runtime-badges",
        opencodeSessionId: "session-qa",
        opencodeAttachBaseUrl: "http://localhost:4310",
        status: "failed",
        runCount: 1,
      },
      {
        id: "漏洞挑战-1",
        taskId: "task-chat-window-runtime-badges",
        opencodeSessionId: "session-challenge-1",
        opencodeAttachBaseUrl: "http://localhost:4310",
        status: "action_required",
        runCount: 1,
      },
      {
        id: "漏洞论证-1",
        taskId: "task-chat-window-runtime-badges",
        opencodeSessionId: "session-argument-1",
        opencodeAttachBaseUrl: "http://localhost:4310",
        status: "completed",
        runCount: 1,
      },
    ],
    messages: [
      {
        id: "user-dispatch",
        taskId: "task-chat-window-runtime-badges",
        sender: "user",
        content: "@Build @QA 请处理本轮问题",
        timestamp: "2026-04-29T10:00:00.000Z",
        kind: "user",
        scope: "task",
        taskTitle: "runtime badges",
        targetAgentIds: ["Build", "QA"],
        targetRunCounts: [1, 1],
      },
      {
        id: "clue-final",
        taskId: "task-chat-window-runtime-badges",
        sender: "线索发现",
        content: "发现第 1 个可疑点：这里需要进入对抗讨论。",
        timestamp: "2026-04-29T10:00:10.000Z",
        kind: "agent-final",
        runCount: 1,
        status: "completed",
        routingKind: "default",
        responseNote: "",
        rawResponse: "发现第 1 个可疑点：这里需要进入对抗讨论。",
      },
    ],
    topology,
  };

  return { workspace, task };
}

test("ChatWindow 只根据消息流展示运行中面板与最终消息", async () => {
  const domContext = setupDom();
  const container = domContext.dom.window.document.createElement("div");
  domContext.dom.window.document.body.append(container);
  const root = createRoot(container);
  const { workspace, task } = createWorkspaceAndTask();
  const nextTask: TaskSnapshot = {
    ...task,
    messages: [
      ...task.messages,
      {
        id: "build-progress",
        taskId: task.task.id,
        sender: "Build",
        content: "Build 正在继续处理",
        timestamp: "2026-04-29T10:00:01.000Z",
        kind: "agent-progress",
        activityKind: "thinking",
        label: "思考",
        detail: "Build 正在继续处理",
        detailState: "not_applicable",
        sessionId: "session-build",
        runCount: 1,
      },
      {
        id: "qa-final",
        taskId: task.task.id,
        sender: "QA",
        content: "QA 校验失败",
        timestamp: "2026-04-29T10:00:02.000Z",
        kind: "agent-final",
        runCount: 1,
        status: "error",
        routingKind: "invalid",
        responseNote: "",
        rawResponse: "QA 校验失败",
      },
    ],
  };

  try {
    await act(async () => {
      root.render(
        <ChatWindow
          workspace={workspace}
          task={nextTask}
          availableAgents={["Build", "QA", "线索发现"]}
          taskLogFilePath={null}
          taskUrl={null}
          openingAgentTerminalId=""
          onSubmit={async () => undefined}
        />,
      );
    });

    const text = container.textContent ?? "";
    assert.equal(container.querySelectorAll('[aria-label="运行中"]').length, 1);
    assert.match(text, /Build 正在继续处理/);
    assert.match(text, /QA 校验失败/);
  } finally {
    await act(async () => {
      root.unmount();
    });
    domContext.cleanup();
  }
});
