import type { MessageRecord } from "@shared/types";

type MinimalMessage = Pick<MessageRecord, "sender" | "content" | "meta">;

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
