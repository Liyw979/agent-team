import test from "node:test";
import assert from "node:assert/strict";

import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { TopologyGraph } from "./TopologyGraph";
import type { MessageRecord, TaskSnapshot, TopologyRecord, WorkspaceSnapshot } from "@shared/types";

const WORKSPACE_CWD = "/tmp/agent-team-topology-graph";
const TASK_ID = "task-1";
const AGENT_ID = "Build";

const topology: TopologyRecord = {
  nodes: [AGENT_ID],
  edges: [],
};

function createAgentFinalMessage(input: {
  id: string;
  content: string;
  timestamp: string;
}): MessageRecord {
  return {
    id: input.id,
    taskId: TASK_ID,
    sender: AGENT_ID,
    content: input.content,
    timestamp: input.timestamp,
    kind: "agent-final",
    runCount: 1,
    status: "completed",
    routingKind: "default",
    responseNote: "",
    rawResponse: input.content,
  };
}

function createTask(messages: MessageRecord[]): TaskSnapshot {
  return {
    task: {
      id: TASK_ID,
      title: "TopologyGraph fullscreen scroll test",
      status: "running",
      cwd: WORKSPACE_CWD,
      opencodeSessionId: null,
      agentCount: 1,
      createdAt: "2026-04-28T10:00:00.000Z",
      completedAt: null,
      initializedAt: "2026-04-28T10:00:00.000Z",
    },
    agents: [
      {
        id: AGENT_ID,
        taskId: TASK_ID,
        opencodeSessionId: null,
        opencodeAttachBaseUrl: null,
        status: "running",
        runCount: messages.length,
      },
    ],
    messages,
    topology,
  };
}

const workspace: WorkspaceSnapshot = {
  cwd: WORKSPACE_CWD,
  name: "agent-team-topology-graph",
  agents: [
    {
      id: AGENT_ID,
      prompt: "负责提交构建结果。",
      isWritable: true,
    },
  ],
  topology,
  messages: [],
  tasks: [],
};

type GlobalDomPatchKey =
  | "window"
  | "document"
  | "navigator"
  | "HTMLElement"
  | "HTMLDivElement"
  | "HTMLButtonElement"
  | "Node"
  | "Event"
  | "MouseEvent"
  | "KeyboardEvent"
  | "ResizeObserver"
  | "requestAnimationFrame"
  | "cancelAnimationFrame"
  | "getComputedStyle"
  | "IS_REACT_ACT_ENVIRONMENT";

type GlobalDomPatch = {
  existed: boolean;
  value: unknown;
};

function setupDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const previousValues = new Map<GlobalDomPatchKey, GlobalDomPatch>();
  let nextAnimationFrameId = 1;
  const pendingAnimationFrames = new Map<number, FrameRequestCallback>();

  function setGlobal(key: GlobalDomPatchKey, value: unknown) {
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

  class MockResizeObserver {
    observe() {}
    disconnect() {}
    unobserve() {}
  }

  setGlobal("window", window);
  setGlobal("document", window.document);
  setGlobal("navigator", window.navigator);
  setGlobal("HTMLElement", window.HTMLElement);
  setGlobal("HTMLDivElement", window.HTMLDivElement);
  setGlobal("HTMLButtonElement", window.HTMLButtonElement);
  setGlobal("Node", window.Node);
  setGlobal("Event", window.Event);
  setGlobal("MouseEvent", window.MouseEvent);
  setGlobal("KeyboardEvent", window.KeyboardEvent);
  setGlobal("ResizeObserver", MockResizeObserver);
  setGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const frameId = nextAnimationFrameId;
    nextAnimationFrameId += 1;
    pendingAnimationFrames.set(frameId, callback);
    return frameId;
  });
  setGlobal("cancelAnimationFrame", (handle: number) => {
    pendingAnimationFrames.delete(handle);
  });
  setGlobal("getComputedStyle", window.getComputedStyle.bind(window));
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  return {
    window,
    async flushAnimationFrames() {
      const callbacks = Array.from(pendingAnimationFrames.values());
      pendingAnimationFrames.clear();
      for (const callback of callbacks) {
        callback(window.performance.now());
      }
      await Promise.resolve();
    },
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

function findButton(label: string): HTMLButtonElement {
  const button = document.querySelector(`button[aria-label="${label}"]`);
  assert.ok(button instanceof HTMLButtonElement, `未找到按钮：${label}`);
  return button;
}

function findFullscreenHistoryViewport(): HTMLDivElement {
  const viewport = document.querySelector('[data-testid="topology-fullscreen-history-viewport"]');
  assert.ok(viewport instanceof HTMLDivElement, "未找到全屏历史滚动容器");
  return viewport;
}

function attachScrollMetrics(
  viewport: HTMLDivElement,
  metrics: {
    scrollHeight: number;
    clientHeight: number;
    scrollTop: number;
  },
) {
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    get: () => metrics.scrollHeight,
  });
  Object.defineProperty(viewport, "clientHeight", {
    configurable: true,
    get: () => metrics.clientHeight,
  });
  Object.defineProperty(viewport, "scrollTop", {
    configurable: true,
    get: () => metrics.scrollTop,
    set: (value: number) => {
      metrics.scrollTop = value;
    },
  });
}

async function renderTopologyGraph(task: TaskSnapshot) {
  const dom = setupDom();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  async function render(nextTask: TaskSnapshot) {
    await act(async () => {
      root.render(
        <TopologyGraph
          workspace={workspace}
          task={nextTask}
          selectedAgentId={null}
          onSelectAgent={() => {}}
          onToggleMaximize={() => {}}
        />,
      );
    });
  }

  async function cleanup() {
    await act(async () => {
      root.unmount();
    });
    dom.cleanup();
  }

  await render(task);

  return {
    flushAnimationFrames: dom.flushAnimationFrames,
    window: dom.window,
    root,
    render,
    cleanup,
  };
}

test("单个 agent 全屏详情首次打开会贴到底部，后续追加消息会继续向下滚动，用户离开底部后不会被强行拉回", async () => {
  const initialTask = createTask([
    createAgentFinalMessage({
      id: "message-1",
      content: "第一版输出",
      timestamp: "2026-04-28T10:00:00.000Z",
    }),
    createAgentFinalMessage({
      id: "message-2",
      content: "第二版输出",
      timestamp: "2026-04-28T10:02:00.000Z",
    }),
  ]);
  const rendered = await renderTopologyGraph(initialTask);

  try {
    await act(async () => {
      findButton(`进入全屏 ${AGENT_ID} 详情`).dispatchEvent(
        new rendered.window.MouseEvent("click", { bubbles: true }),
      );
    });

    const viewport = findFullscreenHistoryViewport();
    const metrics = {
      scrollHeight: 480,
      clientHeight: 120,
      scrollTop: 0,
    };
    attachScrollMetrics(viewport, metrics);

    await act(async () => {
      await rendered.flushAnimationFrames();
    });
    assert.equal(metrics.scrollTop, metrics.scrollHeight, "首次打开全屏后应自动贴底");

    metrics.scrollHeight = 720;
    await rendered.render(createTask([
      ...initialTask.messages,
      createAgentFinalMessage({
        id: "message-3",
        content: "第三版输出",
        timestamp: "2026-04-28T10:05:00.000Z",
      }),
    ]));
    await act(async () => {
      await rendered.flushAnimationFrames();
    });
    assert.equal(metrics.scrollTop, metrics.scrollHeight, "追加新消息后应继续追随到底部");

    metrics.scrollTop = 120;
    await act(async () => {
      viewport.dispatchEvent(new rendered.window.Event("scroll", { bubbles: true }));
    });

    metrics.scrollHeight = 960;
    await rendered.render(createTask([
      ...initialTask.messages,
      createAgentFinalMessage({
        id: "message-3",
        content: "第三版输出",
        timestamp: "2026-04-28T10:05:00.000Z",
      }),
      createAgentFinalMessage({
        id: "message-4",
        content: "第四版输出",
        timestamp: "2026-04-28T10:08:00.000Z",
      }),
    ]));
    await act(async () => {
      await rendered.flushAnimationFrames();
    });
    assert.equal(metrics.scrollTop, 120, "用户已离开底部时不应强制拉回");
  } finally {
    await rendered.cleanup();
  }
});
