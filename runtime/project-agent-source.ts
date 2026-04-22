import {
  DEFAULT_TOOL_PERMISSIONS,
  RESTRICTED_AGENT_PERMISSION_KEYS,
  type AgentRecord,
  type TopologyRecord,
} from "@shared/types";
import { toOpenCodeAgentName } from "./opencode-agent-name";

export function resolveProjectAgents(input: {
  dslAgents: AgentRecord[] | null;
}): AgentRecord[] {
  if (input.dslAgents && input.dslAgents.length > 0) {
    return input.dslAgents.map((agent) => ({ ...agent }));
  }
  return [];
}

export function validateProjectAgents(_agents: AgentRecord[]): void {
  // 拓扑中的 writable 现在完全由 JSON 显式声明，允许多个 Agent 同时可写。
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
      name: node.templateName,
      prompt: typeof (node as { prompt?: unknown }).prompt === "string" ? (node as { prompt: string }).prompt : "",
      isWritable: typeof (node as { writable?: unknown }).writable === "boolean"
        ? (node as { writable: boolean }).writable
        : undefined,
    }))
    .filter((agent) => topology.nodes.includes(agent.name));

  if (dslAgents.length === 0) {
    return null;
  }

  return dslAgents.map((agent) => ({
    ...agent,
    isWritable: agent.isWritable ?? false,
  }));
}

export function buildInjectedConfigFromAgents(agents: AgentRecord[]): string | null {
  const deniedPermission = {
    write: "deny",
    edit: "deny",
    bash: "deny",
    task: "deny",
    patch: "deny",
  } as const;
  const writablePermission = Object.fromEntries(
    RESTRICTED_AGENT_PERMISSION_KEYS.map((name) => [
      name,
      DEFAULT_TOOL_PERMISSIONS.find((permission) => permission.name === name)?.mode ?? "ask",
    ]),
  );

  const injectedAgents = Object.fromEntries(
    agents.flatMap((agent) => {
      if (agent.name.trim().toLowerCase() === "build") {
        return [];
      }
      return [[
        toOpenCodeAgentName(agent.name),
        {
          mode: "primary",
          prompt: agent.prompt ?? "",
          permission: agent.isWritable ? writablePermission : deniedPermission,
        },
      ]];
    }),
  );

  if (Object.keys(injectedAgents).length === 0) {
    return null;
  }

  return JSON.stringify({ agent: injectedAgents });
}
