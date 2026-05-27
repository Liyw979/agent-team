import { test } from "bun:test";
import assert from "node:assert/strict";

import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import {
  createTopologyFlowRecord,
  type TaskSnapshot,
  type WorkspaceSnapshot,
} from "@shared/types";

import { ChatWindow } from "./ChatWindow";
import { toUtcIsoTimestamp } from "@shared/types";

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
  const scrollToOptions: ScrollToOptions[] = [];

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
  Object.defineProperty(dom.window.HTMLDivElement.prototype, "scrollTo", {
    configurable: true,
    value(options: ScrollToOptions) {
      scrollToOptions.push(options);
    },
  });

  return {
    dom,
    scrollToOptions,
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

async function flushAsyncFrames() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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
      "误报论证",
      "漏洞论证",
      "讨论总结",
      "疑点辩论",
    ],
    edges: [
      {
        source: "线索发现",
        target: "疑点辩论",
        trigger: "<continue>",
        messageMode: "last" as const,
        maxTriggerRounds: 4,
      },
    ],
    flow: createTopologyFlowRecord({
      nodes: [
        "Build",
        "QA",
        "线索发现",
        "误报论证",
        "漏洞论证",
        "讨论总结",
        "疑点辩论",
      ],
      edges: [
        {
          source: "线索发现",
          target: "疑点辩论",
          trigger: "<continue>",
          messageMode: "last" as const,
          maxTriggerRounds: 4,
        },
      ],
    }),
    nodeRecords: [
      { id: "Build", kind: "agent" as const, templateName: "Build", initialMessageRouting: { mode: "inherit" } },
      { id: "QA", kind: "agent" as const, templateName: "QA", initialMessageRouting: { mode: "inherit" } },
      { id: "线索发现", kind: "agent" as const, templateName: "线索发现", initialMessageRouting: { mode: "inherit" } },
      {
        id: "疑点辩论",
        kind: "group" as const,
        templateName: "疑点辩论",
        groupRuleId: "group-rule:疑点辩论",
        initialMessageRouting: { mode: "inherit" },
      },
      { id: "误报论证", kind: "agent" as const, templateName: "误报论证", initialMessageRouting: { mode: "inherit" } },
      { id: "漏洞论证", kind: "agent" as const, templateName: "漏洞论证", initialMessageRouting: { mode: "inherit" } },
      { id: "讨论总结", kind: "agent" as const, templateName: "讨论总结", initialMessageRouting: { mode: "inherit" } },
    ],
    groupRules: [
      {
        id: "group-rule:疑点辩论",
        groupNodeName: "疑点辩论",
        sourceTemplateName: "线索发现",
        entryRole: "误报论证",
        members: [
          { role: "误报论证", templateName: "误报论证" },
          { role: "漏洞论证", templateName: "漏洞论证" },
          { role: "讨论总结", templateName: "讨论总结" },
        ],
        edges: [
          {
            sourceRole: "误报论证",
            targetRole: "漏洞论证",
            trigger: "<continue>",
            messageMode: "last" as const,
            maxTriggerRounds: 4,
          },
          {
            sourceRole: "漏洞论证",
            targetRole: "误报论证",
            trigger: "<continue>",
            messageMode: "last" as const,
            maxTriggerRounds: 4,
          },
          {
            sourceRole: "误报论证",
            targetRole: "讨论总结",
            trigger: "<complete>",
            messageMode: "last" as const,
            maxTriggerRounds: 4,
          },
          {
            sourceRole: "漏洞论证",
            targetRole: "讨论总结",
            trigger: "<complete>",
            messageMode: "last" as const,
            maxTriggerRounds: 4,
          },
        ],
        report: {
          sourceRole: "summary",
          templateName: "线索发现",
          trigger: "<default>" as const,
          messageMode: "none" as const,
          maxTriggerRounds: -1,
        },
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
      agentCount: 5,
      createdAt: "2026-04-29T10:00:00.000Z",
      completedAt: "",
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
        id: "误报论证-1",
        taskId: "task-chat-window-runtime-badges",
        opencodeSessionId: "session-challenge-1",
        opencodeAttachBaseUrl: "http://localhost:4310",
        status: "failed",
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
        timestamp: toUtcIsoTimestamp("2026-04-29T10:00:00.000Z"),
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
        timestamp: toUtcIsoTimestamp("2026-04-29T10:00:10.000Z"),
        kind: "agent-final",
        runCount: 1,
        status: "completed",
        routingKind: "default",
        responseNote: "",
        rawResponse: "发现第 1 个可疑点：这里需要进入对抗讨论。",
        senderDisplayName: "线索发现",
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
        content: "Build 正在执行中",
        timestamp: toUtcIsoTimestamp("2026-04-29T10:00:01.000Z"),
        kind: "agent-progress",
        activityKind: "thinking",
        label: "思考",
        detail: "Build 正在执行中",
        detailState: "not_applicable",
        sessionId: "session-build",
        runCount: 1,
      },
      {
        id: "qa-final",
        taskId: task.task.id,
        sender: "QA",
        content: "QA 校验失败",
        timestamp: toUtcIsoTimestamp("2026-04-29T10:00:02.000Z"),
        kind: "agent-final",
        runCount: 1,
        status: "error",
        routingKind: "invalid",
        responseNote: "",
        rawResponse: "QA 校验失败",
        senderDisplayName: "QA",
      },
    ],
  };
  let copiedTranscript = "";
  Object.defineProperty(domContext.dom.window.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        copiedTranscript = value;
      },
    },
  });

  try {
    await act(async () => {
      root.render(
        <ChatWindow
          workspace={workspace}
          task={nextTask}
          availableAgents={["Build", "QA", "线索发现"]}
          taskLogFilePath=""
          taskUrl=""
          onSubmit={async () => undefined}
        />,
      );
    });

    const textContent = container.textContent;
    if (textContent === null) {
      assert.fail("缺少消息面板文本内容");
    }
    const text = textContent;
    assert.equal(container.querySelectorAll('[aria-label="运行中"]').length, 1);
    assert.match(text, /Build 正在执行中/);
    assert.match(text, /QA 校验失败/);
    await flushAsyncFrames();
    assert.equal(
      domContext.scrollToOptions.some((options) => options.behavior === "smooth"),
      true,
    );

    const copyButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "复制对话记录",
    );
    if (!copyButton) {
      assert.fail("缺少复制对话记录按钮");
    }

    await act(async () => {
      copyButton.dispatchEvent(new domContext.dom.window.MouseEvent("click", {
        bubbles: true,
      }));
    });

    assert.match(copiedTranscript, /@Build @QA 请处理本轮问题/);
    assert.match(copiedTranscript, /发现第 1 个可疑点：这里需要进入对抗讨论。/);
    assert.match(copiedTranscript, /QA 校验失败/);
    assert.doesNotMatch(copiedTranscript, /Build 正在执行中/);
  } finally {
    await act(async () => {
      root.unmount();
    });
    domContext.cleanup();
  }
});

test("ChatWindow 消息面板只渲染最近 30 条展示项", async () => {
  const domContext = setupDom();
  const container = domContext.dom.window.document.createElement("div");
  domContext.dom.window.document.body.append(container);
  const root = createRoot(container);
  const { workspace, task } = createWorkspaceAndTask();
  const messages = Array.from({ length: 35 }, (_, index) => {
    const messageNumber = index + 1;
    return {
      id: `visible-limit-${messageNumber}`,
      taskId: task.task.id,
      sender: "user" as const,
      content: `可见限制测试消息 [${messageNumber}]`,
      timestamp: toUtcIsoTimestamp(`2026-04-29T10:${String(messageNumber).padStart(2, "0")}:00.000Z`),
      kind: "user" as const,
      scope: "task" as const,
      taskTitle: task.task.title,
      targetAgentIds: [],
      targetRunCounts: [],
    };
  });
  const nextTask: TaskSnapshot = {
    ...task,
    messages,
  };

  try {
    await act(async () => {
      root.render(
        <ChatWindow
          workspace={workspace}
          task={nextTask}
          availableAgents={["Build", "QA", "线索发现"]}
          taskLogFilePath=""
          taskUrl=""
          onSubmit={async () => undefined}
        />,
      );
    });

    const textContent = container.textContent;
    if (textContent === null) {
      assert.fail("缺少消息面板文本内容");
    }
    const text = textContent;
    for (const messageNumber of [1, 2, 3, 4, 5]) {
      assert.doesNotMatch(text, new RegExp(`可见限制测试消息 \\[${messageNumber}\\]`));
    }
    for (const messageNumber of Array.from({ length: 30 }, (_, index) => index + 6)) {
      assert.match(text, new RegExp(`可见限制测试消息 \\[${messageNumber}\\]`));
    }
  } finally {
    await act(async () => {
      root.unmount();
    });
    domContext.cleanup();
  }
});
