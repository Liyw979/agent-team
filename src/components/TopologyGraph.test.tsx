import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";

import { TopologyGraph } from "./TopologyGraph";
import type { ProjectSnapshot, TaskSnapshot, TopologyRecord } from "@shared/types";
import { REVIEW_NEEDS_REVISION_END_LABEL, REVIEW_NEEDS_REVISION_LABEL } from "@shared/review-response";

const TOPOLOGY_GRAPH_SOURCE = fs.readFileSync(
  path.join(import.meta.dirname, "TopologyGraph.tsx"),
  "utf8",
);

function createProjectSnapshot(topology: TopologyRecord): ProjectSnapshot {
  return {
    project: {
      id: topology.projectId,
      name: "demo",
      path: "/tmp/demo",
      createdAt: "2026-04-14T00:00:00.000Z",
    },
    agentFiles: [
      {
        name: "BA",
        prompt: "",
      },
      {
        name: "TaskReview",
        prompt: "",
      },
      {
        name: "Build",
        prompt: "",
      },
    ],
    builtinAgentTemplates: [],
    topology,
    messages: [],
    tasks: [],
  };
}

function createTaskSnapshot(
  topology: TopologyRecord,
  messages: TaskSnapshot["messages"] = [],
): TaskSnapshot {
  return {
    task: {
      id: "task-1",
      projectId: topology.projectId,
      title: "demo task",
      status: "running",
      cwd: "/tmp/demo",
      zellijSessionId: "oap-demo-task",
      opencodeSessionId: null,
      agentCount: 3,
      createdAt: "2026-04-14T00:00:00.000Z",
      completedAt: null,
      initializedAt: "2026-04-14T00:00:01.000Z",
    },
    agents: [
      { id: "task-1:BA", taskId: "task-1", projectId: topology.projectId, name: "BA", opencodeSessionId: null, status: "completed", runCount: 1 },
      { id: "task-1:TaskReview", taskId: "task-1", projectId: topology.projectId, name: "TaskReview", opencodeSessionId: null, status: "completed", runCount: 1 },
      { id: "task-1:Build", taskId: "task-1", projectId: topology.projectId, name: "Build", opencodeSessionId: null, status: "failed", runCount: 1 },
    ],
    panels: [],
    messages,
    topology,
  };
}

function getTopologyHtml(messages: TaskSnapshot["messages"] = []) {
  const topology: TopologyRecord = {
    projectId: "project-1",
    nodes: ["TaskReview", "BA", "Build"],
    edges: [
      { source: "BA", target: "Build", triggerOn: "association" },
      { source: "Build", target: "TaskReview", triggerOn: "association" },
      { source: "TaskReview", target: "BA", triggerOn: "approved" },
      { source: "TaskReview", target: "Build", triggerOn: "needs_revision", maxRevisionRounds: 6 },
    ],
  };

  return renderToStaticMarkup(
    <TopologyGraph
      project={createProjectSnapshot(topology)}
      task={createTaskSnapshot(topology, messages)}
      selectedAgentId={null}
      onSelectAgent={() => undefined}
      onSaveTopology={async () => undefined}
      onOpenLangGraphStudio={async () => undefined}
      compact={false}
      showEdgeList={true}
      runtimeSnapshots={{}}
    />,
  );
}

test("TopologyGraph 真实渲染包含状态徽标和边关系", () => {
  const html = getTopologyHtml();

  assert.match(html, /审视通过/);
  assert.match(html, /已完成/);
  assert.match(html, /执行失败/);
  assert.match(html, /传递/);
  assert.match(html, /审视通过/);
  assert.match(html, /审视不通过/);
  assert.match(html, /TaskReview/);
  assert.match(html, /BA/);
  assert.match(html, /Build/);
});

test("布局顺序直接跟随 topology.nodes，不再被边关系和角色启发式改写", () => {
  assert.match(TOPOLOGY_GRAPH_SOURCE, /const sortedNodeIds = \[\.\.\.draft\.nodes\];/);
  assert.doesNotMatch(TOPOLOGY_GRAPH_SOURCE, /resolveBuildAgentName|getRoleRank|getRoleRowOrder/);
});

test("TopologyGraph 历史记录会去掉 needs_revision 标签", () => {
  const html = getTopologyHtml([
    {
      id: "message-1",
      projectId: "project-1",
      taskId: "task-1",
      sender: "TaskReview",
      timestamp: "2026-04-14T00:05:00.000Z",
      content: `审视不通过。\n\n${REVIEW_NEEDS_REVISION_LABEL}请继续补充实现依据。${REVIEW_NEEDS_REVISION_END_LABEL}`,
      meta: {
        kind: "agent-final",
        status: "failed",
        reviewDecision: "needs_revision",
        finalMessage: `审视不通过。\n\n${REVIEW_NEEDS_REVISION_LABEL}请继续补充实现依据。${REVIEW_NEEDS_REVISION_END_LABEL}`,
      },
    },
  ]);

  assert.match(html, /审视不通过。/);
  assert.match(html, /请继续补充实现依据。/);
  assert.doesNotMatch(html, /&lt;needs_revision&gt;/);
  assert.doesNotMatch(html, /&lt;\/needs_revision&gt;/);
});

test("TopologyGraph 顶部会渲染 LangGraph UI 按钮", () => {
  const html = getTopologyHtml();

  assert.match(html, /LangGraph UI/);
});

test("TopologyGraph 源码包含 needs_revision 单独配置最大反驳次数的输入控件", () => {
  assert.match(TOPOLOGY_GRAPH_SOURCE, /maxRevisionRounds/);
  assert.match(TOPOLOGY_GRAPH_SOURCE, /最大反驳次数/);
  assert.match(TOPOLOGY_GRAPH_SOURCE, /type="number"/);
});

test("TopologyGraph 边关系列表会展示 needs_revision 的最大反驳次数", () => {
  const html = getTopologyHtml();

  assert.match(html, /审视不通过/);
  assert.match(html, /最大反驳次数 6/);
});
