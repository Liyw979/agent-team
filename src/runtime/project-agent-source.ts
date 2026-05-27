/**
 * 要求记录：
 * 1. 拓扑中的 writable 完全由 YAML 显式声明决定，允许多个 Agent 同时可写。
 * 2. 设计与修改时先读取本注释，保持最小改动范围，避免回退到隐式默认或兼容性补丁。
 * 3. 本文件内部禁止用 null、undefined 表达 Agent 列表或 Agent 可写状态缺失，统一使用完整 AgentRecord 与空数组。
 */
import {
  type AgentRecord,
  getTopologyNodeRecords,
  type PermissionMode,
  type TopologyNodeRecord,
  type TopologyRecord,
} from "@shared/types";
import { toOpenCodeAgentId } from "./opencode-agent-id";

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

function readNodePrompt(node: TopologyNodeRecord): string {
  return typeof node.prompt === "string" ? node.prompt : "";
}

function readNodeWritable(node: TopologyNodeRecord): boolean {
  return node.writable === true;
}

export function extractDslAgentsFromTopology(
  topology: TopologyRecord,
): AgentRecord[] {
  if (topology.nodes.length === 0) {
    return [];
  }
  // 要求记录：
  // 1. agent 与 group 是不同类型，禁止复用字段模型。
  // 2. 节点记录禁止可空字段，必须在构建阶段写实完整值。
  const nodeRecords = getTopologyNodeRecords(topology).filter((node) => node.kind === "agent");
  const hasDslPromptMetadata = nodeRecords.some((node) =>
    typeof node.prompt === "string" || typeof node.writable === "boolean",
  );
  if (nodeRecords.length === 0 || !hasDslPromptMetadata) {
    return [];
  }

  const dslAgents = nodeRecords
    .map((node) => ({
      id: node.templateName,
      prompt: readNodePrompt(node),
      isWritable: readNodeWritable(node),
    }))
    .filter((agent) => topology.nodes.includes(agent.id));

  if (dslAgents.length === 0) {
    return [];
  }

  return dslAgents;
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
