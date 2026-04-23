import {
  getMessageTargetAgentIds,
  isAgentDispatchMessageRecord,
  isUserMessageRecord,
  type MessageRecord,
  type TopologyEdgeMessageMode,
} from "@shared/types";
import { withOptionalString } from "@shared/object-utils";

type MinimalMessage = MessageRecord;

function extractMention(content: string): string | undefined {
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

export function buildSourceAgentMessageSectionLabel(sourceAgentName: string): string {
  const displayName = sourceAgentName.trim() || "来源 Agent";
  return `[From ${displayName} Agent]`;
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

function normalizeContentForDedup(value: string): string {
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
    if (!message || !isUserMessageRecord(message)) {
      continue;
    }
    const rawContent = message.content.trim();
    const targetAgentName = getMessageTargetAgentIds(message)[0]?.trim();
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
  options: {
    includeInitialTask?: boolean;
    messageMode: TopologyEdgeMessageMode;
  },
): { userMessage?: string; agentMessage: string } {
  const includeInitialTask = options.includeInitialTask ?? true;
  const messageMode = options.messageMode;
  const initialUserContent = getInitialUserMessageContent(messages);
  const latestSourceContent = sourceContent.trim();
  const agentMessage = resolveForwardedAgentMessage(messages, latestSourceContent, messageMode);
  return withOptionalString({
    agentMessage,
  }, "userMessage",
    includeInitialTask
    && initialUserContent
    && !contentContainsNormalized(agentMessage, initialUserContent)
      ? initialUserContent
      : undefined,
  );
}

function resolveForwardedAgentMessage(
  messages: MinimalMessage[],
  latestSourceContent: string,
  messageMode: TopologyEdgeMessageMode,
): string {
  if (messageMode === "none") {
    return "continue";
  }

  if (messageMode === "all") {
    const transcript = buildForwardableTranscript(messages);
    return transcript || latestSourceContent || "（当前没有可转发的历史消息记录。）";
  }

  return latestSourceContent || "（该上游 Agent 未返回可继续流转的正文。）";
}

function buildForwardableTranscript(messages: MinimalMessage[]): string {
  return messages
    .filter((message) => isForwardableMessage(message))
    .map((message) => formatForwardableMessage(message))
    .filter(Boolean)
    .join("\n\n");
}

function isForwardableMessage(message: MinimalMessage): boolean {
  if (!message.content.trim()) {
    return false;
  }
  return !isAgentDispatchMessageRecord(message);
}

function formatForwardableMessage(message: MinimalMessage): string {
  const sender = message.sender.trim() || "Unknown";
  const targetAgentName = getMessageTargetAgentIds(message)[0]?.trim();
  const content = sender === "user" && targetAgentName
    ? stripTargetMention(message.content, targetAgentName)
    : message.content.trim();

  if (!content) {
    return "";
  }

  return `[${sender}] ${content}`;
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
