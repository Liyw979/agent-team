import test from "node:test";
import assert from "node:assert/strict";

import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { TaskSnapshot, UiSnapshotPayload } from "@shared/types";

import App from "./App";

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
  | "setInterval"
  | "clearInterval"
  | "getComputedStyle"
  | "fetch"
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

const TASK_ID = "task-app-runtime-refresh";
const WORKSPACE_CWD = "/tmp/agent-team-app-runtime-refresh";

function createUiSnapshot(input: {
  agentSessionId: string | null;
  messages: TaskSnapshot["messages"];
}): UiSnapshotPayload {
  return {
    workspace: {
      cwd: WORKSPACE_CWD,
      name: "app-runtime-refresh",
      agents: [
        {
          id: "漏洞挑战-1",
          prompt: "挑战输入",
          isWritable: false,
        },
      ],
      topology: {
        nodes: ["漏洞挑战-1"],
        edges: [],
      },
      messages: [],
      tasks: [],
    },
    task: {
      task: {
        id: TASK_ID,
        title: "runtime refresh",
        status: "running",
        cwd: WORKSPACE_CWD,
        opencodeSessionId: null,
        agentCount: 1,
        createdAt: "2026-04-29T10:00:00.000Z",
        completedAt: null,
        initializedAt: "2026-04-29T10:00:00.000Z",
      },
      agents: [
        {
          id: "漏洞挑战-1",
          taskId: TASK_ID,
          opencodeSessionId: input.agentSessionId,
          opencodeAttachBaseUrl: input.agentSessionId ? "http://localhost:4310" : null,
          status: "completed",
          runCount: 1,
        },
      ],
      messages: input.messages,
      topology: {
        nodes: ["漏洞挑战-1"],
        edges: [],
      },
    },
    launchTaskId: TASK_ID,
    launchCwd: WORKSPACE_CWD,
    taskLogFilePath: null,
    taskUrl: "http://localhost:4310/?taskId=task-app-runtime-refresh",
  };
}

function createAgentFinalMessage() {
  return [
    {
      id: "challenge-final-1",
      taskId: TASK_ID,
      sender: "漏洞挑战-1",
      content: "挑战结论：这里的消息应当在轮询拿到全量 snapshot 后立即出现。",
      timestamp: "2026-04-29T10:00:02.000Z",
      kind: "agent-final" as const,
      runCount: 1,
      status: "completed" as const,
      routingKind: "default" as const,
      responseNote: "",
      rawResponse: "挑战结论：这里的消息应当在轮询拿到全量 snapshot 后立即出现。",
    },
  ];
}

function setupDom(fetchImpl: typeof fetch) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: `http://localhost/?taskId=${TASK_ID}`,
    pretendToBeVisual: true,
  });
  const previousValues = new Map<GlobalPatchKey, GlobalPatch>();
  const intervalCallbacks: Array<() => void | Promise<void>> = [];

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
  setGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(dom.window.performance.now()), 0));
  setGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  setGlobal("setInterval", (handler: TimerHandler) => {
    if (typeof handler === "function") {
      intervalCallbacks.push(handler as () => void | Promise<void>);
    }
    return intervalCallbacks.length;
  });
  setGlobal("clearInterval", (_id: ReturnType<typeof setInterval>) => undefined);
  setGlobal("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
  setGlobal("fetch", fetchImpl);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  return {
    dom,
    async tickIntervals() {
      for (const callback of intervalCallbacks) {
        await callback();
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

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

test("App 只靠 ui-snapshot 轮询也会把新 final 消息展示出来", async () => {
  let uiSnapshotRequestCount = 0;
  const snapshots = [
    createUiSnapshot({
      agentSessionId: null,
      messages: [],
    }),
    createUiSnapshot({
      agentSessionId: "session-challenge-1",
      messages: createAgentFinalMessage(),
    }),
  ];
  const fetchImpl = (async () => {
    const next = snapshots[Math.min(uiSnapshotRequestCount, snapshots.length - 1)]!;
    uiSnapshotRequestCount += 1;
    return new Response(JSON.stringify(next), { status: 200 });
  }) as typeof fetch;

  const domContext = setupDom(fetchImpl);
  const container = domContext.dom.window.document.createElement("div");
  domContext.dom.window.document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(<App />);
    });

    await waitForAssertion(() => {
      assert.match(document.body.textContent ?? "", /还没有消息/u);
      assert.equal(uiSnapshotRequestCount >= 1, true);
    });

    await act(async () => {
      await domContext.tickIntervals();
    });

    await waitForAssertion(() => {
      assert.match(document.body.textContent ?? "", /挑战结论：这里的消息应当在轮询拿到全量 snapshot 后立即出现。/u);
    });
  } finally {
    await act(async () => {
      root.unmount();
    });
    domContext.cleanup();
  }
});

test("App 会把 snapshot 里的 attach 状态更新到界面", async () => {
  let uiSnapshotRequestCount = 0;
  const snapshots = [
    createUiSnapshot({
      agentSessionId: null,
      messages: createAgentFinalMessage(),
    }),
    createUiSnapshot({
      agentSessionId: "session-challenge-1",
      messages: createAgentFinalMessage(),
    }),
  ];
  const fetchImpl = (async () => {
    const next = snapshots[Math.min(uiSnapshotRequestCount, snapshots.length - 1)]!;
    uiSnapshotRequestCount += 1;
    return new Response(JSON.stringify(next), { status: 200 });
  }) as typeof fetch;

  const domContext = setupDom(fetchImpl);
  const container = domContext.dom.window.document.createElement("div");
  domContext.dom.window.document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(<App />);
    });

    await waitForAssertion(() => {
      const attachButton = document.querySelector('button[aria-label="打开 漏洞挑战-1 的 attach 终端"]');
      assert.ok(attachButton instanceof HTMLButtonElement);
      assert.equal(attachButton.disabled, true);
    });

    await act(async () => {
      await domContext.tickIntervals();
    });

    await waitForAssertion(() => {
      const attachButton = document.querySelector('button[aria-label="打开 漏洞挑战-1 的 attach 终端"]');
      assert.ok(attachButton instanceof HTMLButtonElement);
      assert.equal(attachButton.disabled, false);
    });
  } finally {
    await act(async () => {
      root.unmount();
    });
    domContext.cleanup();
  }
});
