import test from "node:test";
import assert from "node:assert/strict";

import { act } from "react";

import type { TaskSnapshot, TopologyRecord, WorkspaceSnapshot } from "@shared/types";

import { renderTopologyGraphInDom } from "./topology-graph.test-helpers";

const TASK_ID = "task-runtime-refresh";
const WORKSPACE_CWD = "/tmp/agent-team-topology-runtime-refresh";

const topology: TopologyRecord = {
  nodes: ["线索发现", "漏洞挑战"],
  edges: [],
  nodeRecords: [
    { id: "线索发现", kind: "agent", templateName: "线索发现" },
    { id: "漏洞挑战", kind: "agent", templateName: "漏洞挑战" },
    { id: "疑点辩论", kind: "spawn", templateName: "漏洞挑战", spawnRuleId: "spawn-rule:疑点辩论" },
  ],
  spawnRules: [
    {
      id: "spawn-rule:疑点辩论",
      spawnNodeName: "疑点辩论",
      sourceTemplateName: "线索发现",
      entryRole: "challenge",
      spawnedAgents: [
        { role: "challenge", templateName: "漏洞挑战" },
      ],
      edges: [],
      exitWhen: "all_completed",
    },
  ],
};

const workspace: WorkspaceSnapshot = {
  cwd: WORKSPACE_CWD,
  name: "topology-runtime-refresh",
  agents: [
    { id: "线索发现", prompt: "发现线索", isWritable: false },
    { id: "漏洞挑战", prompt: "挑战线索", isWritable: false },
  ],
  topology,
  messages: [],
  tasks: [],
};

function createTask(input: {
  agents: TaskSnapshot["agents"];
  messages: TaskSnapshot["messages"];
}): TaskSnapshot {
  return {
    task: {
      id: TASK_ID,
      title: "runtime refresh",
      status: "running",
      cwd: WORKSPACE_CWD,
      opencodeSessionId: null,
      agentCount: input.agents.length,
      createdAt: "2026-04-29T10:00:00.000Z",
      completedAt: null,
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

test("TopologyGraph 会把静态模板节点刷新成最新 runtime agent，并保持 attach 可点击", async () => {
  const firstRoundTask = createTask({
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
        id: "漏洞挑战-1",
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
    agents: [
      ...firstRoundTask.agents,
      {
        id: "漏洞挑战-2",
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
    workspace,
    task: firstRoundTask,
    selectedAgentId: null,
    openingAgentTerminalId: "",
    onSelectAgent: () => {},
    onToggleMaximize: () => {},
    onOpenAgentTerminal: () => {},
  });

  try {
    await act(async () => {
      await rendered.flushAnimationFrames();
    });

    const firstRoundAttachButton = findAttachButton("漏洞挑战-1");
    assert.ok(firstRoundAttachButton instanceof HTMLButtonElement, "应展示第一轮 runtime agent 的 attach 按钮");
    assert.equal(firstRoundAttachButton.disabled, false);
    assert.equal(findAttachButton("漏洞挑战"), null);

    await rendered.render({
      workspace,
      task: secondRoundTask,
      selectedAgentId: null,
      openingAgentTerminalId: "",
      onSelectAgent: () => {},
      onToggleMaximize: () => {},
      onOpenAgentTerminal: () => {},
    });
    await act(async () => {
      await rendered.flushAnimationFrames();
    });

    const secondRoundAttachButton = findAttachButton("漏洞挑战-2");
    assert.ok(secondRoundAttachButton instanceof HTMLButtonElement, "应切换到最新 runtime agent 的 attach 按钮");
    assert.equal(secondRoundAttachButton.disabled, false);
    assert.equal(secondRoundAttachButton.title, "attach 到 漏洞挑战-2");
    assert.equal(findAttachButton("漏洞挑战"), null);
  } finally {
    await rendered.cleanup();
  }
});

test("task snapshot 尚未带上 session 时，TopologyGraph 不会启用 attach", async () => {
  const task = createTask({
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
        id: "漏洞挑战-2",
        taskId: TASK_ID,
        opencodeSessionId: null,
        opencodeAttachBaseUrl: null,
        status: "running",
        runCount: 1,
      },
    ],
    messages: [],
  });

  const rendered = await renderTopologyGraphInDom({
    workspace,
    task,
    selectedAgentId: null,
    openingAgentTerminalId: "",
    onSelectAgent: () => {},
    onToggleMaximize: () => {},
    onOpenAgentTerminal: () => {},
  });

  try {
    await act(async () => {
      await rendered.flushAnimationFrames();
    });

    const attachButton = findAttachButton("漏洞挑战-2");
    assert.ok(attachButton instanceof HTMLButtonElement, "应展示已运行 agent 的 attach 按钮");
    assert.equal(attachButton.disabled, true);
    assert.equal(attachButton.title, "漏洞挑战-2 当前还没有可 attach 的 OpenCode session。");
  } finally {
    await rendered.cleanup();
  }
});

test("TopologyGraph 会继续展示刚完成的运行实例", async () => {
  const task = createTask({
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
        id: "漏洞挑战-1",
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
        sender: "漏洞挑战-1",
        content: "漏洞挑战-1 已经完成本轮回应。",
        timestamp: "2026-04-29T10:00:02.000Z",
        kind: "agent-final",
        runCount: 1,
        status: "completed",
        routingKind: "default",
        responseNote: "",
        rawResponse: "漏洞挑战-1 已经完成本轮回应。",
      },
    ],
  });

  const rendered = await renderTopologyGraphInDom({
    workspace,
    task,
    selectedAgentId: null,
    openingAgentTerminalId: "",
    onSelectAgent: () => {},
    onToggleMaximize: () => {},
    onOpenAgentTerminal: () => {},
  });

  try {
    await act(async () => {
      await rendered.flushAnimationFrames();
    });

    const attachButton = findAttachButton("漏洞挑战-1");
    assert.ok(attachButton instanceof HTMLButtonElement, "刚完成的 runtime agent 仍应保留在拓扑里");
    assert.equal(attachButton.disabled, false);
    assert.equal(rendered.window.document.body.textContent?.includes("漏洞挑战-1 已经完成本轮回应。"), true);
  } finally {
    await rendered.cleanup();
  }
});
