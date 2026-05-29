import {
  extractAgentFinalDisplayContent,
} from "../lib/chat-messages";
import { extractMentionAgentId } from "@shared/agent-id";
import {
  getMessageTargetAgentIds,
  getMessageSenderDisplayName,
  isAgentFinalMessageRecord,
  type InitialMessageRouting,
  type MessageRecord,
  type TopologyEdgeMessageMode,
} from "@shared/types";

type MinimalMessage = MessageRecord;
export const NONE_MODE_PLACEHOLDER_MESSAGE = "continue";

type DownstreamForwardedContext =
  | {
      kind: "empty";
    }
  | {
      kind: "forwarded";
      agentMessage: string;
    };

export function buildUserHistoryContent(content: string, targetAgentId: string): string {
  // 2026-05-29: 用户要求消息转发入口只接受确定的 mention 结果；是否存在 mention 必须在这里一次判定完成。
  const trimmed = content.trim();
  if (!trimmed) {
    return `@${targetAgentId}`;
  }
  if (extractMentionAgentId(trimmed)) {
    return content;
  }
  return `@${targetAgentId} ${trimmed}`;
}

export function buildSourceAgentMessageSectionLabel(sourceAgentId: string): string {
  const displayName = sourceAgentId.trim() || "来源 Agent";
  return `[From ${displayName} Agent]`;
}

export function stripTargetMention(content: string, targetAgentId: string): string {
  const trimmed = stripLeadingTargetMention(content, targetAgentId);
  if (!trimmed) {
    return "";
  }

  const mentionToken = `@${targetAgentId}`;
  const trailingPattern = new RegExp(`(?:^|\\s)${escapeRegExp(mentionToken)}\\s*$`, "u");
  const strippedTrailing = trimmed.replace(trailingPattern, "").trimEnd();
  return strippedTrailing || trimmed;
}

function normalizeContentForDedup(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function buildDownstreamForwardedContextFromMessages(
  messages: MinimalMessage[],
  sourceContent: string,
  options: {
    messageMode: TopologyEdgeMessageMode;
    initialMessageRouting: InitialMessageRouting;
    sourceAgentId: string;
    initialMessageSourceAliasesByAgentId: Record<string, string[]>;
    globalSourceOrder: string[];
  },
): DownstreamForwardedContext {
  const messageMode = options.messageMode;
  const latestSourceContent = sourceContent.trim();
  const agentMessage = resolveForwardedAgentMessage(
    messages,
    latestSourceContent,
    messageMode,
    options.initialMessageRouting,
    options.sourceAgentId,
    options.initialMessageSourceAliasesByAgentId,
    options.globalSourceOrder,
  );
  if (!agentMessage) {
    return { kind: "empty" };
  }
  return {
    kind: "forwarded",
    agentMessage,
  };
}

function resolveForwardedAgentMessage(
  messages: MinimalMessage[],
  latestSourceContent: string,
  messageMode: TopologyEdgeMessageMode,
  initialMessageRouting: InitialMessageRouting,
  sourceAgentId: string,
  initialMessageSourceAliasesByAgentId: Record<string, string[]>,
  globalSourceOrder: string[],
): string {
  const orderedEntries = buildOrderedForwardingEntries(
    messages,
    latestSourceContent,
    messageMode,
    initialMessageRouting,
    sourceAgentId,
    initialMessageSourceAliasesByAgentId,
    globalSourceOrder,
  );
  const aggregatedSections = aggregateForwardingEntries(orderedEntries);
  if (aggregatedSections.length === 0) {
    return "";
  }
  return aggregatedSections.join("\n\n");
}

type ForwardingEntry = {
  sourceAgentId: string;
  content: string;
};

type InitialMessageEntryResolution =
  | {
      kind: "found";
      entry: ForwardingEntry;
    }
  | {
      kind: "missing";
    };

type ForwardableInitialSourceMessageResolution =
  | {
      kind: "found";
      message: MessageRecord;
      index: number;
    }
  | {
      kind: "missing";
    };

function findLastForwardableInitialSourceMessage(
  messages: MinimalMessage[],
  agentId: string,
  aliases: string[],
): ForwardableInitialSourceMessageResolution {
  const candidates = new Set<string>([
    ...aliases.map((value) => value.trim()).filter(Boolean),
    agentId.trim(),
  ]);
  return messages.reduce<ForwardableInitialSourceMessageResolution>(
    (current, message, index) => {
      if (
        !isForwardableInitialSourceMessage(message)
        || ![...candidates].some((candidate) => matchesForwardingMessageAgentAlias(message, candidate))
      ) {
        return current;
      }
      if (current.kind === "missing") {
        return { kind: "found", message, index };
      }
      if (message.timestamp > current.message.timestamp) {
        return { kind: "found", message, index };
      }
      if (message.timestamp < current.message.timestamp) {
        return current;
      }
      return index > current.index ? { kind: "found", message, index } : current;
    },
    { kind: "missing" },
  );
}

function buildDefaultForwardingEntries(
  latestSourceContent: string,
  messageMode: TopologyEdgeMessageMode,
  sourceAgentId: string,
): ForwardingEntry[] {
  if (messageMode === "none") {
    return [];
  }

  const content = latestSourceContent || "（该上游 Agent 未返回可继续流转的正文。）";
  return [{ sourceAgentId, content }];
}

function buildOrderedForwardingEntries(
  messages: MinimalMessage[],
  latestSourceContent: string,
  messageMode: TopologyEdgeMessageMode,
  initialMessageRouting: InitialMessageRouting,
  sourceAgentId: string,
  initialMessageSourceAliasesByAgentId: Record<string, string[]>,
  globalSourceOrder: string[],
): ForwardingEntry[] {
  const defaultEntries = buildDefaultForwardingEntries(
    latestSourceContent,
    messageMode,
    sourceAgentId,
  );
  const initialEntries = buildInitialMessageEntries(
    messages,
    initialMessageRouting,
    initialMessageSourceAliasesByAgentId,
  );
  return sortForwardingEntriesByGlobalOrder(
    [...defaultEntries, ...initialEntries],
    globalSourceOrder,
    initialMessageSourceAliasesByAgentId,
  );
}

function buildInitialMessageEntries(
  messages: MinimalMessage[],
  initialMessageRouting: InitialMessageRouting,
  initialMessageSourceAliasesByAgentId: Record<string, string[]>,
): ForwardingEntry[] {
  if (initialMessageRouting.mode !== "list") {
    return [];
  }

  return initialMessageRouting.agentIds.flatMap((agentId) => {
    const aliases = initialMessageSourceAliasesByAgentId[agentId];
    if (!aliases) {
      throw new Error(`initialMessage 指定的来源 Agent 缺少别名解析结果：${agentId}`);
    }
    const resolution = resolveInitialMessageEntryByAgentId(
      messages,
      agentId,
      aliases,
    );
    if (resolution.kind === "missing") {
      return [];
    }
    return [resolution.entry];
  });
}

function sortForwardingEntriesByGlobalOrder(
  entries: ForwardingEntry[],
  globalSourceOrder: string[],
  initialMessageSourceAliasesByAgentId: Record<string, string[]>,
): ForwardingEntry[] {
  const sourceOrderIndex = new Map<string, number>();
  globalSourceOrder.forEach((agentId, index) => {
    if (!sourceOrderIndex.has(agentId)) {
      sourceOrderIndex.set(agentId, index);
    }
  });
  const normalizeOrderIndex = (entry: ForwardingEntry): number => {
    const directIndex = sourceOrderIndex.get(entry.sourceAgentId);
    if (directIndex !== undefined) {
      return directIndex;
    }
    for (const [agentId, aliases] of Object.entries(initialMessageSourceAliasesByAgentId)) {
      if (!matchesAgentIdOrAliases(entry.sourceAgentId, agentId, aliases)) {
        continue;
      }
      const aliasIndex = sourceOrderIndex.get(agentId);
      if (aliasIndex !== undefined) {
        return aliasIndex;
      }
    }
    return Number.MAX_SAFE_INTEGER;
  };

  return entries
    .map((entry, index) => ({
      entry,
      index,
      orderIndex: normalizeOrderIndex(entry),
    }))
    .sort((left, right) => left.orderIndex - right.orderIndex || left.index - right.index)
    .map((item) => item.entry);
}

function aggregateForwardingEntries(entries: ForwardingEntry[]): string[] {
  const contentsBySource = new Map<string, string[]>();
  const normalizedContentBySource = new Map<string, Set<string>>();
  for (const entry of entries) {
    const normalizedSourceAgentId = entry.sourceAgentId.trim();
    const normalizedContent = normalizeContentForDedup(entry.content);
    if (!normalizedSourceAgentId || !normalizedContent) {
      continue;
    }
    const sourceContents = contentsBySource.get(normalizedSourceAgentId) ?? [];
    const sourceSeen = normalizedContentBySource.get(normalizedSourceAgentId) ?? new Set<string>();
    if (sourceSeen.has(normalizedContent)) {
      continue;
    }
    sourceSeen.add(normalizedContent);
    sourceContents.push(entry.content.trim());
    contentsBySource.set(normalizedSourceAgentId, sourceContents);
    normalizedContentBySource.set(normalizedSourceAgentId, sourceSeen);
  }
  return [...contentsBySource.entries()].map(([sourceAgentId, sourceContents]) =>
    `${buildSourceAgentMessageSectionLabel(sourceAgentId)}\n${sourceContents.join("\n\n")}`,
  );
}

function resolveInitialMessageEntryByAgentId(
  messages: MinimalMessage[],
  agentId: string,
  aliases: string[],
): InitialMessageEntryResolution {
  const matchedMessage = findLastForwardableInitialSourceMessage(messages, agentId, aliases);
  if (matchedMessage.kind === "missing") {
    return {
      kind: "missing",
    };
  }
  const content = normalizeForwardableMessageContent(matchedMessage.message);
  if (!content) {
    return {
      kind: "missing",
    };
  }
  const sourceAgentId = matchedMessage.message.sender.trim();
  if (!sourceAgentId) {
    throw new Error(`initialMessage 命中的来源消息缺少 sender：${agentId}`);
  }
  return {
    kind: "found",
    entry: {
      sourceAgentId,
      content,
    },
  };
}

function matchesAlias(sourceAgentId: string, alias: string): boolean {
  const normalizedSource = sourceAgentId.trim();
  const normalizedAlias = alias.trim();
  if (!normalizedSource || !normalizedAlias) {
    return false;
  }
  return normalizedSource === normalizedAlias;
}

function matchesAgentIdOrAliases(
  sourceAgentId: string,
  agentId: string,
  aliases: string[],
): boolean {
  if (matchesAlias(sourceAgentId, agentId)) {
    return true;
  }
  return aliases.some((alias) => matchesAlias(sourceAgentId, alias));
}


function isForwardableInitialSourceMessage(message: MinimalMessage): boolean {
  return isAgentFinalMessageRecord(message) && message.content.trim().length > 0;
}

function matchesForwardingMessageAgentAlias(message: MinimalMessage, alias: string): boolean {
  const normalizedAlias = alias.trim();
  if (!normalizedAlias) {
    return false;
  }
  const candidateIds = new Set<string>([
    message.sender,
    getMessageSenderDisplayName(message) ?? "",
  ].map((value) => value.trim()).filter(Boolean));
  return candidateIds.has(normalizedAlias);
}

function normalizeForwardableMessageContent(message: MinimalMessage): string {
  if (message.sender === "user") {
    const rawUserContent = message.content.trim();
    if (!rawUserContent) {
      return "";
    }
    const targetAgentId = getMessageTargetAgentIds(message)[0]?.trim();
    const stripped = targetAgentId
      ? stripTargetMention(rawUserContent, targetAgentId)
      : rawUserContent;
    return stripTrailingStandaloneMentions(stripped);
  }
  if (isAgentFinalMessageRecord(message)) {
    return stripTrailingStandaloneMentions(
      extractAgentFinalDisplayContent(message),
    );
  }
  return stripTrailingStandaloneMentions(message.content.trim());
}

function stripTrailingStandaloneMentions(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }

  const lines = trimmed.split(/\r?\n/);
  while (lines.length > 0) {
    const lastLine = lines.at(-1)?.trim() ?? "";
    if (!/^(?:@\S+\s*)+$/u.test(lastLine)) {
      break;
    }
    lines.pop();
  }

  return lines.join("\n").trim();
}

function stripLeadingTargetMention(content: string, targetAgentId: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }

  const mentionToken = `@${targetAgentId}`;
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
