import fs from "node:fs";
import path from "node:path";

import type { TopologyRecord } from "@shared/types";

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

export function createStudioGraph(topology: TopologyRecord) {
  const StudioAnnotation = Annotation.Root({
    activeNode: Annotation<string | null>({
      reducer: (_left, right) => right,
      default: () => null,
    }),
  });

  let builder = new StateGraph(StudioAnnotation)
    .addNode("task_entry", async (state) => state)
    .addEdge(START, "task_entry");

  for (const agentName of topology.nodes) {
    const subgraph = new StateGraph(StudioAnnotation)
      .addNode("agent_enter", async (state) => ({
        ...state,
        activeNode: agentName,
      }))
      .addNode("run_opencode", async (state) => state)
      .addNode("emit_result", async (state) => state)
      .addEdge(START, "agent_enter")
      .addEdge("agent_enter", "run_opencode")
      .addEdge("run_opencode", "emit_result")
      .addEdge("emit_result", END)
      .compile({
        name: `agent:${agentName}`,
      });
    builder = builder.addNode(`agent:${agentName}`, subgraph);
  }

  for (const edge of topology.edges) {
    const sourceNode = edge.source === topology.nodes[0] ? "task_entry" : `agent:${edge.source}`;
    builder = builder.addEdge(sourceNode, `agent:${edge.target}`);
  }

  if (topology.nodes.length > 0) {
    builder = builder.addEdge(`agent:${topology.nodes.at(-1) ?? ""}`, END);
  } else {
    builder = builder.addEdge("task_entry", END);
  }

  return builder.compile({
    name: `agentflow-studio:${topology.projectId}`,
  });
}

export function loadStudioTopologyFromEnv(): TopologyRecord {
  const projectPath = process.env.AGENTFLOW_LANGGRAPH_PROJECT_PATH?.trim();
  if (!projectPath) {
    return {
      projectId: "langgraph-studio-missing-project",
      nodes: [],
      edges: [],
    };
  }

  const statePath = path.join(projectPath, ".agentflow", "state.json");
  const raw = fs.readFileSync(statePath, "utf8");
  const parsed = JSON.parse(raw) as {
    topology?: {
      projectId?: string;
      nodes?: unknown[];
      edges?: Array<{
        source?: unknown;
        target?: unknown;
        triggerOn?: unknown;
      }>;
    };
  };
  const nodes = Array.isArray(parsed.topology?.nodes)
    ? parsed.topology.nodes.filter((node): node is string => typeof node === "string" && node.trim().length > 0)
    : [];
  const edges = Array.isArray(parsed.topology?.edges)
    ? parsed.topology.edges.filter((edge): edge is TopologyRecord["edges"][number] =>
      typeof edge?.source === "string"
      && typeof edge?.target === "string"
      && (
        edge.triggerOn === "association"
        || edge.triggerOn === "review_pass"
        || edge.triggerOn === "review_fail"
      ))
    : [];

  return {
    projectId: parsed.topology?.projectId?.trim() || path.basename(projectPath) || "agentflow-studio",
    nodes,
    edges,
  };
}

export const agentflowStudio = createStudioGraph(loadStudioTopologyFromEnv());
