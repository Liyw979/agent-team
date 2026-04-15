import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "node:react-dom/server";

import { TopologyGraph } from "./TopologyGraph";
import type { ProjectSnapshot, TaskSnapshot, TopologyRecord } from "@shared/types";

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
    topology,
    messages: [],
    tasks: [],
  };
}

function createTaskSnapshot(topology: TopologyRecord): TaskSnapshot {
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
      { id: "task-1:BA", taskId: "task-1", projectId: topology.projectId, name: "BA", opencodeSessionId: null, status: "success", runCount: 1 },
      { id: "task-1:TaskReview", taskId: "task-1", projectId: topology.projectId, name: "TaskReview", opencodeSessionId: null, status: "success", runCount: 1 },
      { id: "task-1:Build", taskId: "task-1", projectId: topology.projectId, name: "Build", opencodeSessionId: null, status: "failed", runCount: 1 },
    ],
    panels: [],
    messages: [],
    topology,
  };
}

function getTopologyHtml() {
  const topology: TopologyRecord = {
    projectId: "project-1",
    startAgentId: "BA",
    agentOrderIds: ["TaskReview", "BA", "Build"],
    nodes: [
      { id: "BA", label: "BA", kind: "agent" },
      { id: "TaskReview", label: "TaskReview", kind: "agent" },
      { id: "Build", label: "Build", kind: "agent" },
    ],
    edges: [
      { id: "BA__Build__association", source: "BA", target: "Build", triggerOn: "association" },
      { id: "Build__TaskReview__association", source: "Build", target: "TaskReview", triggerOn: "association" },
      { id: "TaskReview__BA__review_pass", source: "TaskReview", target: "BA", triggerOn: "review_pass" },
      { id: "TaskReview__Build__review_fail", source: "TaskReview", target: "Build", triggerOn: "review_fail" },
    ],
  };

  return renderToStaticMarkup(
    <TopologyGraph
      project={createProjectSnapshot(topology)}
      task={createTaskSnapshot(topology)}
      selectedAgentId={null}
      onSelectAgent={() => undefined}
      onSaveTopology={async () => undefined}
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
  assert.ok(html.indexOf("TaskReview") < html.indexOf("BA") && html.indexOf("BA") < html.indexOf("Build"));
});
