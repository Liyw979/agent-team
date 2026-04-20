import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";

import { TopologyGraph } from "./TopologyGraph";
import type { AgentRuntimeSnapshot, TaskSnapshot, TopologyRecord, WorkspaceSnapshot } from "@shared/types";

const TOPOLOGY_GRAPH_SOURCE = fs.readFileSync(
  path.join(import.meta.dirname, "TopologyGraph.tsx"),
  "utf8",
);

function createWorkspaceSnapshot(topology: TopologyRecord): WorkspaceSnapshot {
  return {
    cwd: "/tmp/demo",
    name: "demo",
    agents: [
      { name: "BA", prompt: "" },
      { name: "Build", prompt: "" },
      { name: "TaskReview", prompt: "" },
    ],
    topology,
    messages: [],
    tasks: [],
  };
}

function createTaskSnapshot(topology: TopologyRecord): TaskSnapshot {
  return {
    task: {
      id: "task-1",
      title: "demo task",
      status: "running",
      cwd: "/tmp/demo",
      opencodeSessionId: null,
      agentCount: 3,
      createdAt: "2026-04-14T00:00:00.000Z",
      completedAt: null,
      initializedAt: "2026-04-14T00:00:01.000Z",
    },
    agents: [
      { id: "task-1:BA", taskId: "task-1", name: "BA", opencodeSessionId: null, status: "completed", runCount: 1 },
      { id: "task-1:Build", taskId: "task-1", name: "Build", opencodeSessionId: null, status: "running", runCount: 2 },
      { id: "task-1:TaskReview", taskId: "task-1", name: "TaskReview", opencodeSessionId: null, status: "idle", runCount: 0 },
    ],
    messages: [
      {
        id: "message-build",
        taskId: "task-1",
        sender: "Build",
        content: "Build 第一轮完成",
        timestamp: "2026-04-14T00:00:02.000Z",
        meta: {
          kind: "agent-final",
          finalMessage: "Build 第一轮完成",
        },
      },
    ],
    topology,
  };
}

function renderTopologyHtml() {
  const topology: TopologyRecord = {
    nodes: ["BA", "Build", "TaskReview"],
    edges: [
      { source: "BA", target: "Build", triggerOn: "association" },
      { source: "Build", target: "TaskReview", triggerOn: "approved" },
      { source: "TaskReview", target: "Build", triggerOn: "needs_revision" },
    ],
  };

  const runtimeSnapshots: Record<string, AgentRuntimeSnapshot> = {
    Build: {
      taskId: "task-1",
      agentId: "Build",
      sessionId: "session-build",
      status: "running",
      messageCount: 1,
      updatedAt: "2026-04-14T00:00:03.000Z",
      headline: "Build 正在继续处理 reviewer 意见",
      activeToolNames: ["read_file"],
      activities: [
        {
          id: "activity-build",
          kind: "tool",
          label: "read_file",
          detail: "参数: src/App.tsx",
          timestamp: "2026-04-14T00:00:03.000Z",
        },
      ],
    },
  };

  return renderToStaticMarkup(
    <TopologyGraph
      workspace={createWorkspaceSnapshot(topology)}
      task={createTaskSnapshot(topology)}
      selectedAgentId={null}
      onSelectAgent={() => undefined}
      runtimeSnapshots={runtimeSnapshots}
    />,
  );
}

test("TopologyGraph 纯展示渲染包含节点状态与边关系", () => {
  const html = renderTopologyHtml();

  assert.match(html, /运行中/);
  assert.match(html, /已完成/);
  assert.match(html, /未启动/);
  assert.match(html, /传递/);
  assert.match(html, /审视通过/);
  assert.match(html, /审视不通过/);
  assert.match(html, /纯展示模式，拓扑与 Prompt 全部来自 JSON 文件/);
  assert.match(html, /Build 第一轮完成/);
  assert.match(html, /read_file · 参数: src\/App\.tsx/);
});

test("TopologyGraph 不再包含拓扑编辑与保存入口", () => {
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /onSaveTopology/);
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /setDownstreamMode/);
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /spawn/i);
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /openLangGraphStudio/);
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /LangGraph UI/);
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /ReactFlow/);
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /@xyflow\/react/);
});
