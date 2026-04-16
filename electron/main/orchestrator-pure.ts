import { parseTargetAgentIds } from "@shared/chat-message-format";
import type { MessageRecord, TaskAgentRecord, TaskRecord, TopologyRecord } from "@shared/types";

type MinimalMessage = Pick<MessageRecord, "sender" | "content" | "meta">;
type MinimalAgent = Pick<TaskAgentRecord, "name" | "status" | "runCount">;

export function extractMention(content: string): string | undefined {
  const match = content.match(/@([^\s]+)/u);
  return match?.[1];
}

export function buildUserHistoryContent(content: string, targetAgentId: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return `@${targetAgentId}`;
  }
  if (extractMention(trimmed)) {
    return content;
  }
  return `@${targetAgentId} ${trimmed}`;
}

export function stripTargetMention(content: string, targetAgentName: string): string {
  const trimmed = stripLeadingTargetMention(content, targetAgentName);
  if (!trimmed) {
    return "";
  }

  const mentionToken = `@${targetAgentName}`;
  const trailingPattern = new RegExp(`(?:^|\\s)${escapeRegExp(mentionToken)}\\s*$`, "u");
  const strippedTrailing = trimmed.replace(trailingPattern, "").trimEnd();
  return strippedTrailing || trimmed;
}

export function normalizeContentForDedup(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function contentContainsNormalized(content: string, candidate: string): boolean {
  const normalizedContent = normalizeContentForDedup(content);
  const normalizedCandidate = normalizeContentForDedup(candidate);
  if (!normalizedContent || !normalizedCandidate) {
    return false;
  }
  return normalizedContent.includes(normalizedCandidate);
}

export function getInitialUserMessageContent(messages: MinimalMessage[]): string {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.sender !== "user") {
      continue;
    }
    const rawContent = message.content.trim();
    const targetAgentName = message.meta?.targetAgentId?.trim();
    if (!targetAgentName) {
      return rawContent;
    }
    return stripTargetMention(rawContent, targetAgentName);
  }
  return "";
}

export function buildDownstreamForwardedContextFromMessages(
  messages: MinimalMessage[],
  sourceContent: string,
  includeInitialTask = true,
): { userMessage?: string; agentMessage: string } {
  const initialUserContent = getInitialUserMessageContent(messages);
  const latestSourceContent = sourceContent.trim();
  return {
    userMessage:
      includeInitialTask
      && initialUserContent
      && !contentContainsNormalized(latestSourceContent, initialUserContent)
        ? initialUserContent
        : undefined,
    agentMessage: latestSourceContent || "（该上游 Agent 未返回可继续流转的正文。）",
  };
}

export function getPersistedCompletionSeedAgentNames(input: {
  topology: TopologyRecord;
  agents: MinimalAgent[];
  messages: MinimalMessage[];
}): string[] {
  const validNames = new Set(input.topology.nodes);
  const seeds = new Set<string>();

  for (const agent of input.agents) {
    if (agent.status !== "idle" || agent.runCount > 0) {
      seeds.add(agent.name);
    }
  }

  for (const message of input.messages) {
    const targetAgentId = message.meta?.targetAgentId;
    if (message.sender === "user" && typeof targetAgentId === "string" && targetAgentId.trim()) {
      seeds.add(targetAgentId.trim());
    }
    if (message.meta?.kind === "agent-dispatch") {
      for (const targetName of parseTargetAgentIds(message.meta.targetAgentIds)) {
        seeds.add(targetName);
      }
    }
    if (message.meta?.kind === "revision-request" && typeof targetAgentId === "string" && targetAgentId.trim()) {
      seeds.add(targetAgentId.trim());
    }
  }

  if (seeds.size === 0 && input.topology.startAgentId) {
    seeds.add(input.topology.startAgentId);
  }

  return [...seeds].filter((name) => validNames.has(name));
}

export function collectReachableTopologyNodes(
  topology: TopologyRecord,
  startNames: Iterable<string>,
): Set<string> {
  const queue = [...startNames];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const edge of topology.edges) {
      if (edge.source === current && !visited.has(edge.target)) {
        queue.push(edge.target);
      }
    }
  }

  return visited;
}

export function shouldFinishTaskFromPersistedState(input: {
  taskStatus: TaskRecord["status"];
  topology: TopologyRecord;
  agents: MinimalAgent[];
  messages: MinimalMessage[];
}): boolean {
  if (input.taskStatus !== "running" && input.taskStatus !== "waiting") {
    return false;
  }

  const latestMessage = input.messages.at(-1);
  if (latestMessage?.sender === "user") {
    return false;
  }

  if (input.agents.some((agent) => agent.status === "running")) {
    return false;
  }

  const participatingAgents = new Set(getPersistedCompletionSeedAgentNames(input));
  if (participatingAgents.size === 0) {
    return false;
  }

  const participatingSucceeded = input.agents
    .filter((agent) => participatingAgents.has(agent.name))
    .every((agent) => agent.status === "completed");
  if (!participatingSucceeded) {
    return false;
  }

  const reachableFromParticipating = collectReachableTopologyNodes(input.topology, participatingAgents);
  for (const agent of input.agents) {
    if (agent.status !== "idle" || participatingAgents.has(agent.name)) {
      continue;
    }
    if (!reachableFromParticipating.has(agent.name)) {
      continue;
    }

    const reachableFromIdle = collectReachableTopologyNodes(input.topology, [agent.name]);
    const reconnectsToParticipating = [...participatingAgents].some(
      (participant) => participant !== agent.name && reachableFromIdle.has(participant),
    );
    if (!reconnectsToParticipating) {
      return false;
    }
  }

  return true;
}

function stripLeadingTargetMention(content: string, targetAgentName: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }

  const mentionToken = `@${targetAgentName}`;
  if (!trimmed.startsWith(mentionToken)) {
    return trimmed;
  }

  const nextChar = trimmed.charAt(mentionToken.length);
  if (nextChar && !/\s/u.test(nextChar)) {
    return trimmed;
  }

  const stripped = trimmed.slice(mentionToken.length).trimStart();
  return stripped || trimmed;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
