import { test } from "bun:test";
import assert from "node:assert/strict";

import { act } from "react";

import {
  createTopologyFlowRecord,
  type MessageRecord,
  type TaskSnapshot,
  type TopologyRecord,
} from "@shared/types";
import { renderTopologyGraphInDom } from "../../test-support/components/topology-graph-dom";
import { toUtcIsoTimestamp } from "@shared/types";

const TASK_ID = "task-runtime-refresh";
const WORKSPACE_CWD = "/tmp/agent-team-topology-runtime-refresh";

const topology: TopologyRecord = {
  nodes: ["线索发现", "误报论证"],
  edges: [],
  flow: createTopologyFlowRecord({
    nodes: ["线索发现", "误报论证"],
    edges: [],
  }),
  nodeRecords: [
    { id: "线索发现", kind: "agent", templateName: "线索发现", initialMessageRouting: { mode: "inherit" } },
    { id: "误报论证", kind: "agent", templateName: "误报论证", initialMessageRouting: { mode: "inherit" } },
    { id: "疑点辩论", kind: "group", templateName: "误报论证", groupRuleId: "group-rule:疑点辩论", initialMessageRouting: { mode: "inherit" } },
  ],
  groupRules: [
    {
      id: "group-rule:疑点辩论",
      groupNodeName: "疑点辩论",
      sourceTemplateName: "线索发现",
      entryRole: "challenge",
      members: [
        { role: "challenge", templateName: "误报论证" },
      ],
      edges: [],
      report: false,
    },
  ],
};

function createTask(input: {
  taskId: string;
  taskStatus: TaskSnapshot["task"]["status"];
  agents: TaskSnapshot["agents"];
  messages: TaskSnapshot["messages"];
}): TaskSnapshot {
  return {
    task: {
      id: input.taskId,
      title: "runtime refresh",
      status: input.taskStatus,
      cwd: WORKSPACE_CWD,
      agentCount: input.agents.length,
      createdAt: "2026-04-29T10:00:00.000Z",
      completedAt: "",
      initializedAt: "2026-04-29T10:00:00.000Z",
    },
    agents: input.agents,
    messages: input.messages,
    topology,
  };
}

function findAttachButton(agentId: string) {
  return document.querySelector(`button[aria-label="打开 ${agentId} 的 attach 终端"]`);
}

function offsetTimestamp(seconds: number) {
  return toUtcIsoTimestamp(new Date(Date.now() + seconds * 1000).toISOString());
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

function createTaskAgent(input: {
  id: string;
  status: TaskSnapshot["agents"][number]["status"];
  sessionId: string;
  attachBaseUrl: string;
}) {
  return {
    id: input.id,
    taskId: TASK_ID,
    opencodeSessionId: input.sessionId,
    opencodeAttachBaseUrl: input.attachBaseUrl,
    status: input.status,
    runCount: 1,
  } satisfies TaskSnapshot["agents"][number];
}

function createFinalMessage(input:
  | {
      id: string;
      sender: string;
      content: string;
      timestamp: string;
      routingKind: "default" | "invalid";
    }
  | {
      id: string;
      sender: string;
      content: string;
      timestamp: string;
      routingKind: "triggered";
      trigger: "<continue>" | "<complete>" | "<default>";
    }): Extract<MessageRecord, { kind: "agent-final" }> {
  const base = {
    id: input.id,
    taskId: TASK_ID,
    sender: input.sender,
    senderDisplayName: input.sender,
    content: input.content,
    timestamp: toUtcIsoTimestamp(input.timestamp),
    kind: "agent-final" as const,
    runCount: 1,
    status: "completed" as const,
    responseNote: "",
    rawResponse: input.content,
  } satisfies Omit<Extract<MessageRecord, { kind: "agent-final" }>, "routingKind" | "trigger">;
  if (input.routingKind === "triggered") {
    return {
      ...base,
      routingKind: "triggered" as const,
      trigger: input.trigger,
    };
  }
  return {
    ...base,
    routingKind: input.routingKind,
  };
}

test("TopologyGraph 会把静态模板节点刷新成最新 runtime agent，并保持 attach 可点击", async () => {
  const firstRoundTask = createTask({
    taskId: TASK_ID,
    taskStatus: "running",
    agents: [
      {
        id: "线索发现",
        taskId: TASK_ID,
        opencodeSessionId: "session-clue",
        opencodeAttachBaseUrl: "http://localhost:4310",
        status: "completed",
        runCount: 1,
      },
      {
        id: "误报论证-1",
        taskId: TASK_ID,
        opencodeSessionId: "session-challenge-1",
        opencodeAttachBaseUrl: "http://localhost:4310",
        status: "completed",
        runCount: 1,
      },
    ],
    messages: [],
  });
  const secondRoundTask = createTask({
    taskId: TASK_ID,
    taskStatus: "running",
    agents: [
      ...firstRoundTask.agents,
      {
        id: "误报论证-2",
        taskId: TASK_ID,
        opencodeSessionId: "session-challenge-2",
        opencodeAttachBaseUrl: "http://localhost:4310",
        status: "running",
        runCount: 1,
      },
    ],
    messages: [],
  });

  const rendered = await renderTopologyGraphInDom({
    task: firstRoundTask,
    onOpenSystemPromptPanel: () => {},
    onToggleMaximize: () => {},
    onOpenAgentTerminal: () => {},
  });

  try {
    await act(async () => {
      await rendered.flushAnimationFrames();
    });

    const firstRoundAttachButton = findAttachButton("误报论证-1");
    assert.ok(firstRoundAttachButton instanceof HTMLButtonElement, "应展示第一轮 runtime agent 的 attach 按钮");
    assert.equal(firstRoundAttachButton.disabled, false);
    assert.equal(findAttachButton("误报论证"), null);

    await rendered.render({
      task: secondRoundTask,
      onOpenSystemPromptPanel: () => {},
      onToggleMaximize: () => {},
      onOpenAgentTerminal: () => {},
    });
    await act(async () => {
      await rendered.flushAnimationFrames();
    });

    const secondRoundAttachButton = findAttachButton("误报论证-2");
    assert.ok(secondRoundAttachButton instanceof HTMLButtonElement, "应切换到最新 runtime agent 的 attach 按钮");
    assert.equal(secondRoundAttachButton.disabled, false);
    assert.equal(secondRoundAttachButton.title, "attach 到 误报论证-2");
    assert.equal(findAttachButton("误报论证"), null);
  } finally {
    await rendered.cleanup();
  }
});

test("task snapshot 尚未带上 session 时，TopologyGraph 不会启用 attach", async () => {
  const task = createTask({
    taskId: TASK_ID,
    taskStatus: "running",
    agents: [
      {
        id: "线索发现",
        taskId: TASK_ID,
        opencodeSessionId: "session-clue",
        opencodeAttachBaseUrl: "http://localhost:4310",
        status: "completed",
        runCount: 1,
      },
      {
        id: "误报论证-2",
        taskId: TASK_ID,
        opencodeSessionId: "",
        opencodeAttachBaseUrl: "",
        status: "running",
        runCount: 1,
      },
    ],
    messages: [],
  });

  const rendered = await renderTopologyGraphInDom({
    task,
    onOpenSystemPromptPanel: () => {},
    onToggleMaximize: () => {},
    onOpenAgentTerminal: () => {},
  });

  try {
    await act(async () => {
      await rendered.flushAnimationFrames();
    });

    const attachButton = findAttachButton("误报论证-2");
    assert.ok(attachButton instanceof HTMLButtonElement, "应展示已运行 agent 的 attach 按钮");
    assert.equal(attachButton.disabled, true);
    assert.equal(attachButton.title, "误报论证-2 当前还没有可 attach 的 OpenCode session。");
  } finally {
    await rendered.cleanup();
  }
});

test("TopologyGraph 在空态与正常态都展示 System Prompt 按钮并可触发回调", async () => {
  let openCount = 0;
  const task = createTask({
    taskId: TASK_ID,
    taskStatus: "running",
    agents: [
      createTaskAgent({
        id: "线索发现",
        status: "completed",
        sessionId: "session-clue",
        attachBaseUrl: "http://localhost:4310",
      }),
    ],
    messages: [],
  });

  const rendered = await renderTopologyGraphInDom({
    task,
    onToggleMaximize: () => {},
    onOpenSystemPromptPanel: () => {
      openCount += 1;
    },
    onOpenAgentTerminal: () => {},
  });

  try {
    const button = document.querySelector('button[aria-label="打开 System Prompt 面板"]');
    assert.ok(button instanceof HTMLButtonElement, "正常拓扑下应展示 System Prompt 按钮");
    button.click();
    assert.equal(openCount, 1);

    await rendered.render({
      task: {
        ...task,
        agents: [],
      },
      onToggleMaximize: () => {},
      onOpenSystemPromptPanel: () => {
        openCount += 1;
      },
      onOpenAgentTerminal: () => {},
    });

    const emptyButton = document.querySelector('button[aria-label="打开 System Prompt 面板"]');
    assert.ok(emptyButton instanceof HTMLButtonElement, "空态拓扑下也应展示 System Prompt 按钮");
    emptyButton.click();
    assert.equal(openCount, 2);
  } finally {
    await rendered.cleanup();
  }
});

test("TopologyGraph 会继续展示刚完成的运行实例", async () => {
  const task = createTask({
    taskId: TASK_ID,
    taskStatus: "running",
    agents: [
      {
        id: "线索发现",
        taskId: TASK_ID,
        opencodeSessionId: "session-clue",
        opencodeAttachBaseUrl: "http://localhost:4310",
        status: "completed",
        runCount: 1,
      },
      {
        id: "误报论证-1",
        taskId: TASK_ID,
        opencodeSessionId: "session-challenge-1",
        opencodeAttachBaseUrl: "http://localhost:4310",
        status: "completed",
        runCount: 1,
      },
    ],
    messages: [
      {
        id: "challenge-final",
        taskId: TASK_ID,
        sender: "误报论证-1",
        content: "误报论证-1 请求继续论证。",
        timestamp: toUtcIsoTimestamp("2026-04-29T10:00:02.000Z"),
        kind: "agent-final",
        runCount: 1,
        status: "completed",
        routingKind: "triggered",
        trigger: "<continue>",
        responseNote: "",
        rawResponse: "误报论证-1 请求继续论证。",
        senderDisplayName: "误报论证-1",
      },
    ],
  });

  const rendered = await renderTopologyGraphInDom({
    task,
    onToggleMaximize: () => {},
    onOpenSystemPromptPanel: () => {},
    onOpenAgentTerminal: () => {},
  });

  try {
    await act(async () => {
      await rendered.flushAnimationFrames();
    });

    const attachButton = findAttachButton("误报论证-1");
    assert.ok(attachButton instanceof HTMLButtonElement, "刚完成的 runtime agent 仍应保留在拓扑里");
    assert.equal(attachButton.disabled, false);
    const pageText = rendered.window.document.body.textContent;
    assert.ok(pageText !== null);
    assert.equal(pageText.includes("<continue>"), true);
    assert.equal(pageText.includes("误报论证-1 请求继续论证。"), true);
  } finally {
    await rendered.cleanup();
  }
});

test("TopologyGraph 展示最终多条历史，不展示过程消息，任务结束后仍保留最终历史", async () => {
  const task = createTask({
    taskId: TASK_ID,
    taskStatus: "finished",
    agents: [
      createTaskAgent({
        id: "线索发现",
        attachBaseUrl: "http://localhost:4310",
        sessionId: "session-clue",
        status: "completed",
      }),
    ],
    messages: [
      {
        id: "runtime-tool",
        taskId: TASK_ID,
        sender: "线索发现",
        content: "读取工具文件",
        timestamp: offsetTimestamp(-2),
        kind: "agent-progress",
        activityKind: "tool",
        label: "read_file",
        detail: "参数: hidden.ts",
        detailState: "complete",
        sessionId: "session-clue",
        runCount: 1,
      },
      createFinalMessage({
        id: "runtime-final-first",
        sender: "线索发现",
        content: "第一条最终结果消息",
        timestamp: offsetTimestamp(-1),
        routingKind: "default",
      }),
      createFinalMessage({
        id: "runtime-final-last",
        sender: "线索发现",
        content: "最后一条最终结果消息",
        timestamp: offsetTimestamp(0),
        routingKind: "default",
      }),
    ],
  });

  const rendered = await renderTopologyGraphInDom({
    task,
    onToggleMaximize: () => {},
    onOpenSystemPromptPanel: () => {},
    onOpenAgentTerminal: () => {},
  });

  try {
    await act(async () => {
      await rendered.flushAnimationFrames();
    });

    const pageText = rendered.window.document.body.textContent;
    assert.ok(pageText !== null);
    assert.equal(pageText.includes("参数: hidden.ts"), false);
    assert.equal(pageText.includes("第一条最终结果消息"), true);
    assert.equal(pageText.includes("最后一条最终结果消息"), true);
    assert.equal(pageText.includes("等待最终结果同步"), false);
  } finally {
    await rendered.cleanup();
  }
});

test("TopologyGraph 运行中且尚无最终历史时展示固定提示", async () => {
  const task = createTask({
    taskId: TASK_ID,
    taskStatus: "running",
    agents: [
      {
        id: "线索发现",
        taskId: TASK_ID,
        opencodeSessionId: "session-clue",
        opencodeAttachBaseUrl: "http://localhost:4310",
        status: "running",
        runCount: 1,
      },
    ],
    messages: [
      {
        id: "runtime-tool-only",
        taskId: TASK_ID,
        sender: "线索发现",
        content: "读取工具文件",
        timestamp: toUtcIsoTimestamp("2026-04-29T10:00:28.000Z"),
        kind: "agent-progress",
        activityKind: "tool",
        label: "read_file",
        detail: "参数: hidden.ts",
        detailState: "complete",
        sessionId: "session-clue",
        runCount: 1,
      },
    ],
  });

  const rendered = await renderTopologyGraphInDom({
    task,
    onToggleMaximize: () => {},
    onOpenSystemPromptPanel: () => {},
    onOpenAgentTerminal: () => {},
  });

  try {
    await act(async () => {
      await rendered.flushAnimationFrames();
    });

    const pageText = rendered.window.document.body.textContent;
    assert.ok(pageText !== null);
    assert.equal(pageText.includes("参数: hidden.ts"), false);
    assert.equal(pageText.includes("正在执行，暂无结果"), true);
  } finally {
    await rendered.cleanup();
  }
});

test("TopologyGraph 会把已完成但尚未同步最终消息的运行中任务标记为等待同步", async () => {
  const task = createTask({
    taskId: TASK_ID,
    taskStatus: "running",
    agents: [
      {
        id: "线索发现",
        taskId: TASK_ID,
        opencodeSessionId: "session-clue",
        opencodeAttachBaseUrl: "http://localhost:4310",
        status: "completed",
        runCount: 1,
      },
    ],
    messages: [],
  });

  const rendered = await renderTopologyGraphInDom({
    task,
    onToggleMaximize: () => {},
    onOpenSystemPromptPanel: () => {},
    onOpenAgentTerminal: () => {},
  });

  try {
    await act(async () => {
      await rendered.flushAnimationFrames();
    });

    const pageText = rendered.window.document.body.textContent;
    assert.ok(pageText !== null);
    assert.equal(pageText.includes("等待最终结果同步"), true);
  } finally {
    await rendered.cleanup();
  }
});

test("TopologyGraph 不再展示节点全屏与详情交互", async () => {
  const task = createTask({
    taskId: TASK_ID,
    taskStatus: "running",
    agents: [
      {
        id: "线索发现",
        taskId: TASK_ID,
        opencodeSessionId: "session-clue",
        opencodeAttachBaseUrl: "http://localhost:4310",
        status: "completed",
        runCount: 1,
      },
    ],
    messages: [
      {
        id: "runtime-final",
        taskId: TASK_ID,
        sender: "线索发现",
        content: "最终结果消息",
        timestamp: toUtcIsoTimestamp("2026-04-29T10:00:30.000Z"),
        kind: "agent-final",
        runCount: 1,
        status: "completed",
        routingKind: "default",
        responseNote: "",
        rawResponse: "最终结果消息",
        senderDisplayName: "线索发现",
      },
    ],
  });

  const rendered = await renderTopologyGraphInDom({
    task,
    onToggleMaximize: () => {},
    onOpenSystemPromptPanel: () => {},
    onOpenAgentTerminal: () => {},
  });

  try {
    await act(async () => {
      await rendered.flushAnimationFrames();
    });

    assert.equal(
      rendered.window.document.querySelector('[aria-label="展开查看 线索发现 详情"]'),
      null,
    );
    assert.equal(
      rendered.window.document.querySelector('[aria-label="线索发现 全屏详情"]'),
      null,
    );
    assert.equal(
      rendered.window.document.querySelector('[aria-label="线索发现 历史详情"]'),
      null,
    );
  } finally {
    await rendered.cleanup();
  }
});

test("TopologyGraph 初始展示最终历史的最后一屏，并在后续刷新时保留卡片内滚动位置", async () => {
  const historyMessages = Array.from({ length: 10 }, (_, index) => ({
    id: `runtime-final-${index + 1}`,
    taskId: TASK_ID,
    sender: "线索发现",
    content: `第 ${index + 1} 条最终结果消息 ${"路径/说明 ".repeat(8)}`,
    timestamp: toUtcIsoTimestamp(`2026-04-29T10:00:${String(index).padStart(2, "0")}.000Z`),
    kind: "agent-final" as const,
    runCount: 1,
    status: "completed" as const,
    routingKind: "default" as const,
    responseNote: "",
    rawResponse: `第 ${index + 1} 条最终结果消息 ${"路径/说明 ".repeat(8)}`,
    senderDisplayName: "线索发现",
  }));
  const task = createTask({
    taskId: TASK_ID,
    taskStatus: "running",
    agents: [
      {
        id: "线索发现",
        taskId: TASK_ID,
        opencodeSessionId: "session-clue",
        opencodeAttachBaseUrl: "http://localhost:4310",
        status: "completed",
        runCount: 1,
      },
      {
        id: "误报论证",
        taskId: TASK_ID,
        opencodeSessionId: "session-challenge",
        opencodeAttachBaseUrl: "http://localhost:4310",
        status: "completed",
        runCount: 1,
      },
    ],
    messages: [
      ...historyMessages,
      {
        id: "runtime-final-summary",
        taskId: TASK_ID,
        sender: "误报论证",
        content: "短消息。",
        timestamp: toUtcIsoTimestamp("2026-04-29T10:00:31.000Z"),
        kind: "agent-final",
        runCount: 1,
        status: "completed",
        routingKind: "default",
        responseNote: "",
        rawResponse: "短消息。",
        senderDisplayName: "误报论证",
      },
    ],
  });

  const rendered = await renderTopologyGraphInDom({
    task,
    onToggleMaximize: () => {},
    onOpenSystemPromptPanel: () => {},
    onOpenAgentTerminal: () => {},
  });

  try {
    const firstCard = rendered.window.document.querySelector('[data-topology-node-card="线索发现"]');
    const secondCard = rendered.window.document.querySelector('[data-topology-node-card="误报论证"]');
    assert.ok(firstCard instanceof HTMLElement);
    assert.ok(secondCard instanceof HTMLElement);

    const firstViewport = rendered.window.document.querySelector('[data-topology-history-viewport="线索发现"]');
    const secondViewport = rendered.window.document.querySelector('[data-topology-history-viewport="误报论证"]');
    assert.ok(firstViewport instanceof HTMLElement);
    assert.ok(secondViewport instanceof HTMLElement);
    const firstScrollToOptions: ScrollToOptions[] = [];
    Object.defineProperty(firstViewport, "clientHeight", { configurable: true, value: 240 });
    Object.defineProperty(firstViewport, "scrollHeight", { configurable: true, value: 720 });
    Object.defineProperty(firstViewport, "scrollTo", {
      configurable: true,
      value: (options: ScrollToOptions) => {
        firstScrollToOptions.push(options);
      },
    });

    await act(async () => {
      await rendered.flushAnimationFrames();
    });

    assert.deepEqual(firstScrollToOptions, [{
      top: 480,
      behavior: "smooth",
    }]);
    firstViewport.scrollTop = 480;
    firstViewport.dispatchEvent(new rendered.window.Event("scroll", { bubbles: true }));

    await rendered.render({
      task: createTask({
        taskId: TASK_ID,
        taskStatus: "running",
        agents: task.agents,
        messages: [
          ...task.messages,
          {
            id: "runtime-final-11",
            taskId: TASK_ID,
            sender: "线索发现",
            content: "第 11 条最终结果消息 路径/说明 路径/说明 路径/说明",
            timestamp: toUtcIsoTimestamp("2026-04-29T10:00:32.000Z"),
            kind: "agent-final",
            runCount: 1,
            status: "completed",
            routingKind: "default",
            responseNote: "",
            rawResponse: "第 11 条最终结果消息 路径/说明 路径/说明 路径/说明",
            senderDisplayName: "线索发现",
          },
        ],
      }),
      onToggleMaximize: () => {},
      onOpenSystemPromptPanel: () => {},
      onOpenAgentTerminal: () => {},
    });
    await act(async () => {
      await rendered.flushAnimationFrames();
    });

    assert.deepEqual(firstScrollToOptions, [{
      top: 480,
      behavior: "smooth",
    }, {
      top: 480,
      behavior: "smooth",
    }]);
    firstViewport.scrollTop = 120;
    firstViewport.dispatchEvent(new rendered.window.Event("scroll", { bubbles: true }));

    await rendered.render({
      task: createTask({
        taskId: TASK_ID,
        taskStatus: "running",
        agents: task.agents,
        messages: [
          ...task.messages,
          {
            id: "runtime-final-11",
            taskId: TASK_ID,
            sender: "线索发现",
            content: "第 11 条最终结果消息 路径/说明 路径/说明 路径/说明",
            timestamp: toUtcIsoTimestamp("2026-04-29T10:00:32.000Z"),
            kind: "agent-final",
            runCount: 1,
            status: "completed",
            routingKind: "default",
            responseNote: "",
            rawResponse: "第 11 条最终结果消息 路径/说明 路径/说明 路径/说明",
            senderDisplayName: "线索发现",
          },
          {
            id: "runtime-final-12",
            taskId: TASK_ID,
            sender: "线索发现",
            content: "第 12 条最终结果消息 路径/说明 路径/说明 路径/说明",
            timestamp: toUtcIsoTimestamp("2026-04-29T10:00:33.000Z"),
            kind: "agent-final",
            runCount: 1,
            status: "completed",
            routingKind: "default",
            responseNote: "",
            rawResponse: "第 12 条最终结果消息 路径/说明 路径/说明 路径/说明",
            senderDisplayName: "线索发现",
          },
        ],
      }),
      onToggleMaximize: () => {},
      onOpenSystemPromptPanel: () => {},
      onOpenAgentTerminal: () => {},
    });
    await act(async () => {
      await rendered.flushAnimationFrames();
    });

    assert.deepEqual(firstScrollToOptions, [{
      top: 480,
      behavior: "smooth",
    }, {
      top: 480,
      behavior: "smooth",
    }]);

    await rendered.render({
      task: createTask({
        taskId: `${TASK_ID}-next`,
        taskStatus: "running",
        agents: task.agents.map((agent) => ({
          ...agent,
          taskId: `${TASK_ID}-next`,
        })),
        messages: task.messages.map((message) => ({
          ...message,
          taskId: `${TASK_ID}-next`,
        })),
      }),
      onToggleMaximize: () => {},
      onOpenSystemPromptPanel: () => {},
      onOpenAgentTerminal: () => {},
    });

    const resetViewport = rendered.window.document.querySelector('[data-topology-history-viewport="线索发现"]');
    assert.ok(resetViewport instanceof HTMLElement);
    const resetScrollToOptions: ScrollToOptions[] = [];
    Object.defineProperty(resetViewport, "clientHeight", { configurable: true, value: 240 });
    Object.defineProperty(resetViewport, "scrollHeight", { configurable: true, value: 720 });
    Object.defineProperty(resetViewport, "scrollTo", {
      configurable: true,
      value: (options: ScrollToOptions) => {
        resetScrollToOptions.push(options);
      },
    });

    await act(async () => {
      await rendered.flushAnimationFrames();
    });

    assert.deepEqual(resetScrollToOptions, [{
      top: 480,
      behavior: "smooth",
    }]);
    await waitForAssertion(() => {
      const resetFirstCard = rendered.window.document.querySelector('[data-topology-node-card="线索发现"]');
      const resetSecondCard = rendered.window.document.querySelector('[data-topology-node-card="误报论证"]');
      assert.ok(resetFirstCard instanceof HTMLElement);
      assert.ok(resetSecondCard instanceof HTMLElement);
    });
    const resetFirstCard = rendered.window.document.querySelector('[data-topology-node-card="线索发现"]');
    const resetSecondCard = rendered.window.document.querySelector('[data-topology-node-card="误报论证"]');
    assert.ok(resetFirstCard instanceof HTMLElement);
    assert.ok(resetSecondCard instanceof HTMLElement);
    const text = resetFirstCard.textContent;
    assert.ok(text !== null);
    assert.equal(text.includes("第 1 条最终结果消息"), true);
    assert.equal(text.includes("第 10 条最终结果消息"), true);
    assert.equal(text.includes("第 11 条最终结果消息"), false);
    const resetSecondCardText = resetSecondCard.textContent;
    assert.ok(resetSecondCardText !== null);
    assert.equal(resetSecondCardText.includes("短消息。"), true);
  } finally {
    await rendered.cleanup();
  }
});

test("TopologyGraph 的单条最终历史消息按文字自然撑高，滚动发生在 agent 历史列表层", async () => {
  const rendered = await renderTopologyGraphInDom({
    task: createTask({
      taskId: TASK_ID,
      taskStatus: "running",
      agents: [
        createTaskAgent({
          id: "线索发现",
          attachBaseUrl: "http://localhost:4310",
          sessionId: "session-clue",
          status: "completed",
        }),
      ],
      messages: [
        createFinalMessage({
          id: "runtime-final-long",
          sender: "线索发现",
          content: "很长的最终结果消息 ".repeat(40),
          timestamp: "2026-04-29T10:00:30.000Z",
          routingKind: "default",
        }),
        createFinalMessage({
          id: "runtime-final-next",
          sender: "线索发现",
          content: "第二条最终结果消息",
          timestamp: "2026-04-29T10:00:31.000Z",
          routingKind: "default",
        }),
      ],
    }),
    onToggleMaximize: () => {},
    onOpenSystemPromptPanel: () => {},
    onOpenAgentTerminal: () => {},
  });

  try {
    await act(async () => {
      await rendered.flushAnimationFrames();
    });

    const viewport = rendered.window.document.querySelector('[data-topology-history-viewport="线索发现"]');
    assert.ok(viewport instanceof HTMLElement);
    const historyItems = [...viewport.querySelectorAll("[data-topology-history-item]")];
    const firstItem = historyItems.find((item) =>
      item.textContent?.includes("很长的最终结果消息"),
    );
    const secondItem = historyItems.find((item) =>
      item.textContent?.includes("第二条最终结果消息"),
    );
    assert.ok(firstItem instanceof HTMLElement);
    assert.ok(secondItem instanceof HTMLElement);
    const viewportParent = viewport.parentElement;
    const historyList = viewport.firstElementChild;
    assert.ok(viewportParent instanceof HTMLElement);
    assert.ok(historyList instanceof HTMLElement);
    assert.equal(viewport.className.includes("overflow-y-auto"), true);
    assert.equal(viewportParent.className.includes("flex"), true);
    assert.equal(viewportParent.className.includes("flex-col"), true);
    assert.equal(historyList.className.includes("space-y-1"), true);
    assert.equal(firstItem.className.includes("flex-none"), true);
    assert.equal(firstItem.className.includes("border-slate-200"), true);
    assert.equal(firstItem.className.includes("bg-slate-50"), true);
    assert.equal(firstItem.className.includes("text-slate-800"), true);
    const firstItemText = firstItem.textContent;
    const secondItemText = secondItem.textContent;
    assert.ok(firstItemText !== null);
    assert.ok(secondItemText !== null);
    assert.equal(firstItemText.includes("很长的最终结果消息"), true);
    assert.equal(secondItemText.includes("第二条最终结果消息"), true);
  } finally {
    await rendered.cleanup();
  }
});

test("TopologyGraph 遇到失败节点但缺少最终消息时展示失败占位文案", async () => {
  const rendered = await renderTopologyGraphInDom({
    task: createTask({
      taskId: TASK_ID,
      taskStatus: "running",
      agents: [
        {
          id: "线索发现",
          taskId: TASK_ID,
          opencodeSessionId: "session-clue",
          opencodeAttachBaseUrl: "http://localhost:4310",
          status: "failed",
          runCount: 1,
        },
      ],
      messages: [],
    }),
    onToggleMaximize: () => {},
    onOpenSystemPromptPanel: () => {},
    onOpenAgentTerminal: () => {},
  });

  try {
    assert.equal(document.body.textContent?.includes("执行失败，暂无可展示的最终结果"), true);
  } finally {
    await rendered.cleanup();
  }
});

test("TopologyGraph 遇到任务已结束但节点仍缺少最终消息时展示通用占位文案", async () => {
  const rendered = await renderTopologyGraphInDom({
    task: createTask({
      taskId: TASK_ID,
      taskStatus: "finished",
      agents: [
        {
          id: "线索发现",
          taskId: TASK_ID,
          opencodeSessionId: "session-clue",
          opencodeAttachBaseUrl: "http://localhost:4310",
          status: "running",
          runCount: 1,
        },
      ],
      messages: [],
    }),
    onToggleMaximize: () => {},
    onOpenSystemPromptPanel: () => {},
    onOpenAgentTerminal: () => {},
  });

  try {
    assert.equal(document.body.textContent?.includes("暂无可展示的最终结果"), true);
  } finally {
    await rendered.cleanup();
  }
});

test("TopologyGraph 遇到相同最终时间戳的多条最终消息时保留全部历史记录", async () => {
  const rendered = await renderTopologyGraphInDom({
    task: createTask({
      taskId: TASK_ID,
      taskStatus: "running",
      agents: [
        createTaskAgent({
          id: "线索发现",
          attachBaseUrl: "http://localhost:4310",
          sessionId: "session-clue",
          status: "completed",
        }),
      ],
      messages: [
        createFinalMessage({
          id: "runtime-final-1",
          sender: "线索发现",
          content: "最终结果一",
          timestamp: "2026-04-29T10:00:30.000Z",
          routingKind: "default",
        }),
        createFinalMessage({
          id: "runtime-final-2",
          sender: "线索发现",
          content: "最终结果二",
          timestamp: "2026-04-29T10:00:30.000Z",
          routingKind: "default",
        }),
      ],
    }),
    onToggleMaximize: () => {},
    onOpenSystemPromptPanel: () => {},
    onOpenAgentTerminal: () => {},
  });

  try {
    await act(async () => {
      await rendered.flushAnimationFrames();
    });

    const pageText = rendered.window.document.body.textContent;
    assert.ok(pageText !== null);
    assert.equal(pageText.includes("最终结果一"), true);
    assert.equal(pageText.includes("最终结果二"), true);
  } finally {
    await rendered.cleanup();
  }
});
