import { parseTargetAgentIds } from "@shared/chat-message-format";
import {
  getMessageTargetAgentIds,
  isAgentDispatchMessageRecord,
  isAgentFinalMessageRecord,
  isActionRequiredRequestMessageRecord,
  isTaskCompletedMessageRecord,
  isUserMessageRecord,
  resolveBuildAgentName,
} from "@shared/types";
import type { MessageRecord, TaskAgentRecord, TaskRecord, TopologyRecord } from "@shared/types";

type MinimalMessage = MessageRecord;
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
  const validNames = new Set([
    ...input.topology.nodes,
    ...input.agents.map((agent) => agent.name),
  ]);
  const seeds = new Set<string>();

  for (const agent of input.agents) {
    if (agent.status !== "idle" || agent.runCount > 0) {
      seeds.add(agent.name);
    }
  }

  for (const message of input.messages) {
    const targetAgentIds = parseTargetAgentIds(getMessageTargetAgentIds(message));
    if (isUserMessageRecord(message)) {
      for (const targetAgentId of targetAgentIds) {
        seeds.add(targetAgentId);
      }
    }
    if (isAgentDispatchMessageRecord(message)) {
      for (const targetName of parseTargetAgentIds(getMessageTargetAgentIds(message))) {
        seeds.add(targetName);
      }
    }
    if (isActionRequiredRequestMessageRecord(message)) {
      for (const targetAgentId of targetAgentIds) {
        seeds.add(targetAgentId);
      }
    }
  }

  const defaultEntryAgent = resolveBuildAgentName(input.topology.nodes);
  if (seeds.size === 0 && defaultEntryAgent) {
    seeds.add(defaultEntryAgent);
  }

  return [...seeds].filter((name) => validNames.has(name));
}

function collectReachableTopologyNodes(
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

function referencesMissingActivatedAgent(
  message: MinimalMessage | undefined,
  knownAgentNames: Set<string>,
): boolean {
  if (!message) {
    return false;
  }

  if (isAgentDispatchMessageRecord(message)) {
    return parseTargetAgentIds(getMessageTargetAgentIds(message)).some((targetName) => !knownAgentNames.has(targetName));
  }

  if (isActionRequiredRequestMessageRecord(message)) {
    return parseTargetAgentIds(getMessageTargetAgentIds(message)).some((targetAgentId) => !knownAgentNames.has(targetAgentId));
  }

  return false;
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

  const knownAgentNames = new Set(input.agents.map((agent) => agent.name));
  if (referencesMissingActivatedAgent(latestMessage, knownAgentNames)) {
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

function resolveAgentStatusFromFinalMessage(message: MessageRecord): TaskAgentRecord["status"] {
  if (!isAgentFinalMessageRecord(message)) {
    return "completed";
  }
  if (message.reviewDecision === "continue") {
    return "continue";
  }
  if (message.status === "error") {
    return "failed";
  }
  return "completed";
}

function hasLaterActivationForAgent(
  messages: MessageRecord[],
  agentName: string,
  afterTimestamp: string,
): boolean {
  for (const message of messages) {
    if (message.timestamp <= afterTimestamp) {
      continue;
    }

    if (isUserMessageRecord(message) && parseTargetAgentIds(getMessageTargetAgentIds(message)).includes(agentName)) {
      return true;
    }

    if (isActionRequiredRequestMessageRecord(message) && parseTargetAgentIds(getMessageTargetAgentIds(message)).includes(agentName)) {
      return true;
    }

    if (isAgentDispatchMessageRecord(message) && parseTargetAgentIds(getMessageTargetAgentIds(message)).includes(agentName)) {
      return true;
    }
  }

  return false;
}

export function reconcileTaskSnapshotFromMessages(input: {
  task: TaskRecord;
  agents: TaskAgentRecord[];
  messages: MessageRecord[];
}) {
  const latestCompletionMessage = [...input.messages]
    .reverse()
    .find((message) => isTaskCompletedMessageRecord(message));

  const task: TaskRecord =
    latestCompletionMessage &&
    (latestCompletionMessage.status === "finished" || latestCompletionMessage.status === "failed")
      ? {
          ...input.task,
          status: latestCompletionMessage.status,
          completedAt: latestCompletionMessage.timestamp,
        }
      : input.task;

  const latestAgentFinalByName = new Map<string, MessageRecord>();
  for (const message of input.messages) {
    if (!isAgentFinalMessageRecord(message)) {
      continue;
    }
    latestAgentFinalByName.set(message.sender, message);
  }

  const taskFinished = task.status === "finished";
  const agents = input.agents.map((agent) => {
    if (taskFinished) {
      return {
        ...agent,
        status: "completed" as const,
      };
    }

    const latestFinalMessage = latestAgentFinalByName.get(agent.name);
    if (!latestFinalMessage) {
      return agent;
    }

    if (hasLaterActivationForAgent(input.messages, agent.name, latestFinalMessage.timestamp)) {
      return agent;
    }

    return {
      ...agent,
      status: resolveAgentStatusFromFinalMessage(latestFinalMessage),
    };
  });

  return {
    task,
    agents,
  };
}
