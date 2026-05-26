/**
 * 要求记录：
 * 1. 拓扑中的 writable 完全由 YAML 显式声明决定，允许多个 Agent 同时可写。
 * 2. 设计与修改时先读取本注释，保持最小改动范围，避免回退到隐式默认或兼容性补丁。
 */
import {
  type AgentRecord,
  getTopologyNodeRecords,
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

type OpenCodePermissionValue =
  | PermissionMode
  | Record<string, PermissionMode>;

type OpenCodePermissionConfig = Record<string, OpenCodePermissionValue>;

export type OpenCodeInjectedAgentConfig =
  | {
      mode: "primary";
      prompt: string;
    }
  | {
      mode: "primary";
      prompt: string;
      permission: OpenCodePermissionConfig;
    };

function buildReadonlyAgentPermissionConfig(): OpenCodePermissionConfig {
  return {
    write: "deny",
    edit: "deny",
    bash: "deny",
    task: "deny",
    patch: "deny",
    webfetch: "deny",
    websearch: "deny",
  };
}

export function extractDslAgentsFromTopology(
  topology: TopologyRecord,
): AgentRecord[] | null {
  if (topology.nodes.length === 0) {
    return null;
  }
  const nodeRecords = getTopologyNodeRecords(topology).filter((node) => node.kind === "agent");
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

export function buildInjectedConfigFromAgents(agents: AgentRecord[]): Record<string, OpenCodeInjectedAgentConfig> {
  const injectedAgents = Object.fromEntries(
    agents.flatMap((agent) => {
      if (agent.id.trim().toLowerCase() === "build") {
        return [];
      }
      const config: OpenCodeInjectedAgentConfig = agent.isWritable === true
        ? {
            mode: "primary",
            prompt: agent.prompt,
          }
        : {
            mode: "primary",
            prompt: agent.prompt,
            permission: buildReadonlyAgentPermissionConfig(),
          };
      return [[
        toOpenCodeAgentId(agent.id),
        config,
      ] as const];
    }),
  );

  return injectedAgents;
}
