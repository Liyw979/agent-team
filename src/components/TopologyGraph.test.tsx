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
        id: `${topology.projectId}:BA`,
        projectId: topology.projectId,
        name: "BA",
        relativePath: "BA.md",
        absolutePath: "/tmp/demo/.opencode/agents/BA.md",
        mode: "primary",
        role: "business_analyst",
        tools: [],
        prompt: "",
        content: "",
      },
      {
        id: `${topology.projectId}:DocsReview`,
        projectId: topology.projectId,
        name: "DocsReview",
        relativePath: "DocsReview.md",
        absolutePath: "/tmp/demo/.opencode/agents/DocsReview.md",
        mode: "subagent",
        role: "docs_review",
        tools: [],
        prompt: "",
        content: "",
      },
      {
        id: `${topology.projectId}:Build`,
        projectId: topology.projectId,
        name: "Build",
        relativePath: "builtin://Build",
        absolutePath: "builtin://Build",
        mode: "primary",
        role: "implementation",
        tools: [],
        prompt: "",
        content: "",
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
      { id: "task-1:DocsReview", taskId: "task-1", projectId: topology.projectId, name: "DocsReview", opencodeSessionId: null, status: "failed", runCount: 1 },
      { id: "task-1:Build", taskId: "task-1", projectId: topology.projectId, name: "Build", opencodeSessionId: null, status: "needs_revision", runCount: 1 },
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
    agentOrderIds: ["DocsReview", "BA", "Build"],
    nodes: [
      { id: "BA", label: "BA", kind: "agent" },
      { id: "DocsReview", label: "DocsReview", kind: "agent" },
      { id: "Build", label: "Build", kind: "agent" },
    ],
    edges: [
      { id: "BA__DocsReview__association", source: "BA", target: "DocsReview", triggerOn: "association" },
      { id: "DocsReview__Build__review", source: "DocsReview", target: "Build", triggerOn: "review" },
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

  assert.match(html, /审查通过/);
  assert.match(html, /审查不通过/);
  assert.match(html, /已完成/);
  assert.match(html, /执行失败/);
  assert.match(html, /needs_revision/);
  assert.match(html, /关联/);
  assert.match(html, /审视/);
  assert.ok(html.indexOf("DocsReview") < html.indexOf("BA") && html.indexOf("BA") < html.indexOf("Build"));
});
