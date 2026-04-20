import { parseTargetAgentIds } from "@shared/chat-message-format";
import { resolveBuildAgentName } from "@shared/types";
import type { MessageRecord, TaskAgentRecord, TaskRecord, TopologyRecord } from "@shared/types";

type MinimalMessage = Pick<MessageRecord, "sender" | "content" | "meta">;
type MinimalAgent = Pick<TaskAgentRecord, "name" | "status" | "runCount">;

export function resolveStandaloneTaskStatusAfterAgentRun(input: {
  latestAgentStatus: Pick<TaskAgentRecord, "status">["status"];
  agentStatuses: Array<Pick<TaskAgentRecord, "status">>;
}): Extract<TaskRecord["status"], "waiting" | "finished" | "failed"> {
  if (input.latestAgentStatus === "failed") {
    return "failed";
  }

  const allCompleted =
    input.agentStatuses.length > 0 &&
    input.agentStatuses.every((agent) => agent.status === "completed");
  return allCompleted ? "finished" : "waiting";
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

  const defaultEntryAgent = resolveBuildAgentName(input.topology.nodes);
  if (seeds.size === 0 && defaultEntryAgent) {
    seeds.add(defaultEntryAgent);
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
