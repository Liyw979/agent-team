import { test } from "bun:test";
import assert from "node:assert/strict";

import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  QueryClient,
  QueryClientProvider,
  environmentManager,
  notifyManager,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  buildTopologyNodeRecords,
  type TaskSnapshot,
  type UiSnapshotPayload, toUtcIsoTimestamp,
} from "@shared/types";

import App from "./App";
import { resolveAppUiSnapshot, type AppUiSnapshot } from "./lib/app-ui-snapshot";
import { resolveUiSnapshotQueryStructuralSharing } from "./lib/ui-snapshot-refresh-gate";
import { fetchUiSnapshot, submitTask } from "./lib/web-api";

type GlobalPatchKey =
  | "window"
  | "document"
  | "navigator"
  | "HTMLElement"
  | "HTMLDivElement"
  | "HTMLButtonElement"
  | "HTMLFormElement"
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

function createSingleAgentTopology(agentId: string) {
  return {
    nodes: [agentId],
    edges: [],
    flow: {
      start: {
        id: "__start__" as const,
        targets: [agentId],
      },
      end: {
        id: "__end__" as const,
        sources: [],
        incoming: [],
      },
    },
    nodeRecords: buildTopologyNodeRecords({
      nodes: [agentId],
      groupNodeIds: new Set(),
      templateNameByNodeId: new Map(),
      initialMessageRoutingByNodeId: new Map(),
      groupRuleIdByNodeId: new Map(),
      groupEnabledNodeIds: new Set(),
      promptByNodeId: new Map(),
      writableNodeIds: new Set(),
    }),
  };
}

function createUiSnapshot(input: {
  agentSessionId: string;
  messages: TaskSnapshot["messages"];
}): UiSnapshotPayload {
  return {
    kind: "task",
    workspace: {
      cwd: WORKSPACE_CWD,
      name: "app-runtime-refresh",
      agents: [
        {
          id: "误报论证-1",
          prompt: "挑战输入",
          isWritable: false,
        },
      ],
      topology: createSingleAgentTopology("误报论证-1"),
      messages: [],
      tasks: [],
    },
    task: {
      task: {
        id: TASK_ID,
        title: "runtime refresh",
        status: "running",
        cwd: WORKSPACE_CWD,
        agentCount: 1,
        createdAt: "2026-04-29T10:00:00.000Z",
        completedAt: "",
        initializedAt: "2026-04-29T10:00:00.000Z",
      },
      agents: [
        {
          id: "误报论证-1",
          taskId: TASK_ID,
          opencodeSessionId: input.agentSessionId,
          opencodeAttachBaseUrl: input.agentSessionId ? "http://localhost:4310" : "",
          status: "completed",
          runCount: 1,
        },
      ],
      messages: input.messages,
      topology: createSingleAgentTopology("误报论证-1"),
    },
    launchCwd: WORKSPACE_CWD,
    taskLogFilePath: "/tmp/agent-team-app-runtime-refresh/task.log",
    taskUrl: "http://localhost:4310/",
  };
}

function createAgentFinalMessage() {
  return [
    {
      id: "challenge-final-1",
      taskId: TASK_ID,
      sender: "误报论证-1",
      content: "挑战结论：这里的消息应当在轮询拿到全量 snapshot 后立即出现。",
      timestamp: toUtcIsoTimestamp("2026-04-29T10:00:02.000Z"),
      kind: "agent-final" as const,
      runCount: 1,
      status: "completed" as const,
      routingKind: "default" as const,
      rawResponse: "挑战结论：这里的消息应当在轮询拿到全量 snapshot 后立即出现。",
    },
  ];
}

function getRequestUrl(input: RequestInfo | URL) {
  if (typeof input === "string") {
    return new URL(input, "http://localhost");
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url, "http://localhost");
}

function setupDom(fetchImpl: typeof fetch, visibilityState: "visible" | "hidden" = "visible") {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const previousValues = new Map<GlobalPatchKey, GlobalPatch>();
  const intervalCallbacks: Array<() => void | Promise<void>> = [];

  Object.defineProperty(dom.window.document, "visibilityState", {
    configurable: true,
    value: visibilityState,
  });

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
  setGlobal("HTMLFormElement", dom.window.HTMLFormElement);
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
  Object.defineProperty(dom.window.HTMLDivElement.prototype, "scrollTo", {
    configurable: true,
    value() {},
  });

  return {
    dom,
    async tickIntervals() {
      for (const callback of intervalCallbacks) {
        await callback();
      }
      await Promise.resolve();
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

function restoreDefaultNotifyFunction() {
  notifyManager.setNotifyFunction((callback) => {
    callback();
  });
}

function SubmitTaskInvalidationProbe() {
  const queryClient = useQueryClient();
  const uiSnapshotQueryKey = ["ui-snapshot"] as const;
  const uiSnapshotQuery = useQuery<UiSnapshotPayload, Error, AppUiSnapshot>({
    queryKey: uiSnapshotQueryKey,
    retry: false,
    queryFn: fetchUiSnapshot,
    structuralSharing: resolveUiSnapshotQueryStructuralSharing,
    select: resolveAppUiSnapshot,
  });
  const submitTaskMutation = useMutation({
    mutationFn: submitTask,
    retry: false,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: uiSnapshotQueryKey });
    },
  });

  useEffect(() => {
    void submitTaskMutation.mutateAsync({
      content: "请继续推进当前任务",
    });
  }, []);

  const firstMessage =
    uiSnapshotQuery.data?.taskView.kind === "ready"
      ? uiSnapshotQuery.data.taskView.task.messages[0]
      : null;

  return (
    <div>
      {firstMessage ? firstMessage.content : "还没有消息"}
    </div>
  );
}

function setupAppTest(fetchImpl: typeof fetch, visibilityState: "visible" | "hidden" = "visible") {
  const domContext = setupDom(fetchImpl, visibilityState);
  const container = domContext.dom.window.document.createElement("div");
  domContext.dom.window.document.body.append(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
      mutations: {
        retry: false,
      },
    },
  });

  notifyManager.setNotifyFunction((callback) => {
    act(() => {
      callback();
    });
  });
  environmentManager.setIsServer(() => false);

  return {
    async render(element: ReactNode = <App />) {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            {element}
          </QueryClientProvider>,
        );
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    async tickPolling() {
      await act(async () => {
        await domContext.tickIntervals();
      });
    },
    async cleanup() {
      await act(async () => {
        root.unmount();
      });
      queryClient.clear();
      restoreDefaultNotifyFunction();
      environmentManager.setIsServer(() => typeof window === "undefined");
      domContext.cleanup();
    },
  };
}

test("App 在 ui-snapshot 自动轮询后会把新 final 消息展示出来", async () => {
  let uiSnapshotRequestCount = 0;
  const snapshots = [
    createUiSnapshot({
      agentSessionId: "",
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
  }) as unknown as typeof fetch;

  const appTest = setupAppTest(fetchImpl);

  try {
    await appTest.render();

    await waitForAssertion(() => {
      assert.match(document.body.textContent ?? "", /还没有消息/u);
      assert.equal(uiSnapshotRequestCount >= 1, true);
    });

    await appTest.tickPolling();

    await waitForAssertion(() => {
      assert.match(document.body.textContent ?? "", /挑战结论：这里的消息应当在轮询拿到全量 snapshot 后立即出现。/u);
    });
  } finally {
    await appTest.cleanup();
  }
});

test("App 会把自动轮询带回的 attach 状态更新到界面", async () => {
  let uiSnapshotRequestCount = 0;
  const snapshots = [
    createUiSnapshot({
      agentSessionId: "",
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
  }) as unknown as typeof fetch;

  const appTest = setupAppTest(fetchImpl);

  try {
    await appTest.render();

    await waitForAssertion(() => {
      const attachButton = document.querySelector('button[aria-label="打开 误报论证-1 的 attach 终端"]');
      assert.ok(attachButton instanceof HTMLButtonElement);
      assert.equal(attachButton.disabled, true);
    });

    await appTest.tickPolling();

    await waitForAssertion(() => {
      const attachButton = document.querySelector('button[aria-label="打开 误报论证-1 的 attach 终端"]');
      assert.ok(attachButton instanceof HTMLButtonElement);
      assert.equal(attachButton.disabled, false);
    });
  } finally {
    await appTest.cleanup();
  }
});

test("App 在后台标签页也会继续自动轮询", async () => {
  let uiSnapshotRequestCount = 0;
  const snapshots = [
    createUiSnapshot({
      agentSessionId: "",
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
  }) as unknown as typeof fetch;

  const appTest = setupAppTest(fetchImpl, "hidden");

  try {
    await appTest.render();

    await waitForAssertion(() => {
      assert.match(document.body.textContent ?? "", /还没有消息/u);
      assert.equal(uiSnapshotRequestCount >= 1, true);
    });

    await appTest.tickPolling();

    await waitForAssertion(() => {
      assert.equal(uiSnapshotRequestCount >= 2, true);
      assert.match(document.body.textContent ?? "", /挑战结论：这里的消息应当在轮询拿到全量 snapshot 后立即出现。/u);
    });
  } finally {
    await appTest.cleanup();
  }
});

test("submitTaskMutation 成功后会失效 ui-snapshot 查询并立即重拉", async () => {
  let uiSnapshotRequestCount = 0;
  let submitTaskRequestCount = 0;
  let currentSnapshot = createUiSnapshot({
    agentSessionId: "",
    messages: [],
  });
  const refreshedSnapshot = createUiSnapshot({
    agentSessionId: "session-challenge-1",
    messages: createAgentFinalMessage(),
  });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = getRequestUrl(input);
    if (requestUrl.pathname === "/api/ui-snapshot") {
      uiSnapshotRequestCount += 1;
      return new Response(JSON.stringify(currentSnapshot), { status: 200 });
    }
    if (requestUrl.pathname === "/api/tasks/submit") {
      submitTaskRequestCount += 1;
      currentSnapshot = refreshedSnapshot;
      assert.equal(refreshedSnapshot.kind, "task");
      return new Response(JSON.stringify(refreshedSnapshot.task), { status: 200 });
    }
    throw new Error(`unexpected request: ${requestUrl.pathname} ${init?.method ?? "GET"}`);
  }) as unknown as typeof fetch;

  const appTest = setupAppTest(fetchImpl);

  try {
    await appTest.render(<SubmitTaskInvalidationProbe />);

    await waitForAssertion(() => {
      assert.equal(submitTaskRequestCount, 1);
      assert.equal(uiSnapshotRequestCount >= 2, true);
      assert.match(document.body.textContent ?? "", /挑战结论：这里的消息应当在轮询拿到全量 snapshot 后立即出现。/u);
    });
  } finally {
    await appTest.cleanup();
  }
});

test("App 默认隐藏右侧团队栏，并通过拓扑头部按钮打开 System Prompt 抽屉与详情", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(createUiSnapshot({
      agentSessionId: "session-challenge-1",
      messages: createAgentFinalMessage(),
    })), { status: 200 })) as unknown as typeof fetch;

  const appTest = setupAppTest(fetchImpl);

  try {
    await appTest.render();

    await waitForAssertion(() => {
      assert.equal(document.querySelector('aside[aria-label="System Prompt 面板"]'), null);
      assert.equal(document.body.textContent?.includes("团队") ?? false, false);
      const openButton = document.querySelector('button[aria-label="打开 System Prompt 面板"]');
      assert.ok(openButton instanceof HTMLButtonElement);
    });

    const openButton = document.querySelector('button[aria-label="打开 System Prompt 面板"]');
    assert.ok(openButton instanceof HTMLButtonElement);
    await act(async () => {
      openButton.click();
    });

    await waitForAssertion(() => {
      const drawer = document.querySelector('aside[aria-label="System Prompt 面板"]');
      assert.ok(drawer instanceof HTMLElement);
      assert.match(drawer.textContent ?? "", /误报论证-1/u);
    });

    const agentCard = Array.from(document.querySelectorAll('[role="button"]')).find((element) =>
      element.textContent?.includes("误报论证-1"),
    );
    assert.ok(agentCard instanceof HTMLDivElement);
    await act(async () => {
      agentCard.click();
    });

    await waitForAssertion(() => {
      const promptDialog = document.querySelector('[role="dialog"][aria-label="误报论证-1 Prompt 详情"]');
      assert.ok(promptDialog instanceof HTMLElement);
      assert.match(promptDialog.textContent ?? "", /挑战输入/u);
    });

    const closeDrawerButton = document.querySelector('button[aria-label="关闭 System Prompt 面板"]');
    assert.ok(closeDrawerButton instanceof HTMLButtonElement);
    await act(async () => {
      closeDrawerButton.click();
    });

    await waitForAssertion(() => {
      assert.equal(document.querySelector('aside[aria-label="System Prompt 面板"]'), null);
      assert.match(document.body.textContent ?? "", /挑战结论：这里的消息应当在轮询拿到全量 snapshot 后立即出现。/u);
    });
  } finally {
    await appTest.cleanup();
  }
});

test("App 打开 attach 失败时会自动展示 System Prompt 抽屉与错误提示", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const requestUrl = getRequestUrl(input);
    if (requestUrl.pathname === "/api/ui-snapshot") {
      return new Response(JSON.stringify(createUiSnapshot({
        agentSessionId: "session-challenge-1",
        messages: createAgentFinalMessage(),
      })), { status: 200 });
    }
    if (requestUrl.pathname === "/api/tasks/open-agent-terminal") {
      return new Response(JSON.stringify({
        error: "attach 终端打开失败",
      }), { status: 500 });
    }
    throw new Error(`unexpected request: ${requestUrl.pathname}`);
  }) as unknown as typeof fetch;

  const appTest = setupAppTest(fetchImpl);

  try {
    await appTest.render();

    await waitForAssertion(() => {
      const attachButton = document.querySelector('button[aria-label="打开 误报论证-1 的 attach 终端"]');
      assert.ok(attachButton instanceof HTMLButtonElement);
    });

    const attachButton = document.querySelector('button[aria-label="打开 误报论证-1 的 attach 终端"]');
    assert.ok(attachButton instanceof HTMLButtonElement);
    await act(async () => {
      attachButton.click();
      await Promise.resolve();
    });

    await waitForAssertion(() => {
      const drawer = document.querySelector('aside[aria-label="System Prompt 面板"]');
      assert.ok(drawer instanceof HTMLElement);
      assert.match(drawer.textContent ?? "", /attach 终端打开失败/u);
    });
  } finally {
    await appTest.cleanup();
  }
});
