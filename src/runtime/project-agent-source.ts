import {
  type AgentRecord,
  type PermissionMode,
  type TopologyRecord,
} from "@shared/types";
import { toOpenCodeAgentId } from "./opencode-agent-id";

export function resolveProjectAgents(input: {
  dslAgents: AgentRecord[] | null;
}): AgentRecord[] {
  if (input.dslAgents && input.dslAgents.length > 0) {
    return input.dslAgents.map((agent) => ({ ...agent }));
  }
  return [];
}

export function validateProjectAgents(): void {
  // 拓扑中的 writable 现在完全由 JSON 显式声明，允许多个 Agent 同时可写。
}

type OpenCodePermissionValue =
  | PermissionMode
  | Record<string, PermissionMode>;

type OpenCodePermissionConfig = Record<string, OpenCodePermissionValue>;

function buildReadonlyAgentPermissionConfig(): OpenCodePermissionConfig {
  return {
    write: "deny",
    edit: "deny",
    bash: "deny",
    task: "deny",
    patch: "deny",
  };
}

export function extractDslAgentsFromTopology(
  topology: TopologyRecord,
): AgentRecord[] | null {
  const nodeRecords = topology.nodeRecords?.filter((node) => node.kind === "agent") ?? [];
  const hasDslPromptMetadata = nodeRecords.some((node) =>
    typeof node.prompt === "string" || typeof node.writable === "boolean",
  );
  if (nodeRecords.length === 0 || !hasDslPromptMetadata) {
    return null;
  }

  const dslAgents = nodeRecords
    .map((node) => ({
      id: node.templateName,
      prompt: typeof (node as { prompt?: unknown }).prompt === "string" ? (node as { prompt: string }).prompt : "",
      isWritable: typeof (node as { writable?: unknown }).writable === "boolean"
        ? (node as { writable: boolean }).writable
        : undefined,
    }))
    .filter((agent) => topology.nodes.includes(agent.id));

  if (dslAgents.length === 0) {
    return null;
  }

  return dslAgents.map((agent) => ({
    ...agent,
    isWritable: agent.isWritable ?? false,
  }));
}

export function buildInjectedConfigFromAgents(agents: AgentRecord[]): string | null {
  const injectedAgents = Object.fromEntries(
    agents.flatMap((agent) => {
      if (agent.id.trim().toLowerCase() === "build") {
        return [];
      }
      return [[
        toOpenCodeAgentId(agent.id),
        agent.isWritable === true
          ? {
              mode: "primary",
              prompt: agent.prompt,
            }
          : {
              mode: "primary",
              prompt: agent.prompt,
              permission: buildReadonlyAgentPermissionConfig(),
            },
      ]];
    }),
  );

  if (Object.keys(injectedAgents).length === 0) {
    return null;
  }

  return JSON.stringify({ agent: injectedAgents });
}
