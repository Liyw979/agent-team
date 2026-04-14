import type { MessageRecord } from "@shared/types";
import {
  buildMentionSuffix,
  formatHighLevelTriggerContent,
  formatRevisionRequestContent,
  parseTargetAgentIds,
} from "@shared/chat-message-format";

export interface ChatMessageItem {
  id: string;
  sender: string;
  timestamp: string;
  content: string;
  kinds: string[];
  metaChain: Array<Record<string, string> | undefined>;
}

function isNonSystemAgent(sender: string | undefined) {
  return sender !== undefined && sender !== "user" && sender !== "system";
}

function stripTrailingMentions(content: string): string {
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

function stripRevisionFeedbackLabel(content: string): string {
  return content.replace(/^具体修改意见[:：]\s*/u, "").trim();
}

function getRevisionRequestFeedback(content: string): string {
  const normalized = stripTrailingMentions(content);
  const marker = /具体修改意见[:：]/gu;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null = marker.exec(normalized);

  while (match) {
    lastMatch = match;
    match = marker.exec(normalized);
  }

  if (!lastMatch) {
    return "";
  }

  return normalized.slice(lastMatch.index + lastMatch[0].length).trim();
}

function hasMeaningfulText(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

function extractTrailingTopLevelSection(content: string): string {
  const headingPattern = /(^|\n)(#{1,2}\s+[^\n]+)\n/g;
  let lastHeadingIndex = -1;
  let match: RegExpExecArray | null = headingPattern.exec(content);
  while (match) {
    lastHeadingIndex = match.index + match[1].length;
    match = headingPattern.exec(content);
  }

  if (lastHeadingIndex < 0) {
    return content;
  }

  const trailingSection = content.slice(lastHeadingIndex).trim();
  return trailingSection || content;
}

function extractAgentFinalDisplayContent(message: MessageRecord): string {
  const rawContent = message.meta?.finalMessage?.trim() || message.content.trim();
  if (!rawContent) {
    return "";
  }

  const trailingSection = extractTrailingTopLevelSection(rawContent);
  const normalized = trailingSection
    .replace(/\n(?:---|\*\*\*)(?:\s*\n?)*$/u, "")
    .trim();
  return hasMeaningfulText(normalized) ? normalized : rawContent;
}

function buildMergedRevisionRequestContent(previous: ChatMessageItem, current: MessageRecord): string {
  const summary = previous.content.trim();
  const feedback = getRevisionRequestFeedback(current.content);
  if (!feedback) {
    return formatRevisionRequestContent(summary, current.meta?.targetAgentId);
  }

  const normalizedSummary = summary.replace(/\s+/g, " ").trim();
  const normalizedFeedback = feedback.replace(/\s+/g, " ").trim();
  const normalizedSummaryFeedback = stripRevisionFeedbackLabel(summary)
    .replace(/\s+/g, " ")
    .trim();

  if (!normalizedSummary) {
    return formatRevisionRequestContent(feedback, current.meta?.targetAgentId);
  }

  if (
    normalizedSummary === normalizedFeedback ||
    normalizedSummaryFeedback === normalizedFeedback
  ) {
    return formatRevisionRequestContent(summary, current.meta?.targetAgentId);
  }

  return formatRevisionRequestContent(
    `${summary}\n\n具体修改意见：\n${feedback}`,
    current.meta?.targetAgentId,
  );
}

function buildMergedAgentFinalTriggerContent(previous: ChatMessageItem, current: MessageRecord): string {
  const base = previous.content.trim();
  const targets = parseTargetAgentIds(current.meta?.targetAgentIds);

  if (targets.length === 0) {
    return [base, current.content.trim()].filter(Boolean).join("\n\n");
  }

  return [base, buildMentionSuffix(targets)].filter(Boolean).join("\n\n");
}

function shouldMergeHighLevelTrigger(previous: ChatMessageItem, current: MessageRecord) {
  return (
    previous.kinds.at(-1) === "high-level-trigger" &&
    current.meta?.kind === "high-level-trigger"
  );
}

function shouldMergeAgentFinalWithTrigger(previous: ChatMessageItem, current: MessageRecord) {
  return (
    previous.kinds.at(-1) === "agent-final" &&
    current.meta?.kind === "high-level-trigger"
  );
}

function shouldMergeRevisionRequest(previous: ChatMessageItem, current: MessageRecord) {
  return (
    previous.kinds.at(-1) === "agent-final" &&
    previous.metaChain.at(-1)?.reviewDecision === "needs_revision" &&
    current.meta?.kind === "revision-request"
  );
}

function shouldMergeMessages(previous: ChatMessageItem | undefined, current: MessageRecord) {
  if (!previous || previous.sender !== current.sender || !isNonSystemAgent(previous.sender)) {
    return false;
  }

  return (
    shouldMergeHighLevelTrigger(previous, current) ||
    shouldMergeAgentFinalWithTrigger(previous, current) ||
    shouldMergeRevisionRequest(previous, current)
  );
}

function getDisplayContent(message: MessageRecord): string {
  if (message.meta?.kind === "agent-final") {
    return extractAgentFinalDisplayContent(message);
  }
  if (message.meta?.kind === "high-level-trigger") {
    return formatHighLevelTriggerContent(
      message.content,
      parseTargetAgentIds(message.meta?.targetAgentIds),
    );
  }
  if (message.meta?.kind === "revision-request") {
    return formatRevisionRequestContent(message.content, message.meta?.targetAgentId);
  }
  return message.content;
}

export function mergeTaskChatMessages(messages: MessageRecord[]): ChatMessageItem[] {
  const merged: ChatMessageItem[] = [];

  for (const message of messages) {
    const last = merged.at(-1);

    if (last && shouldMergeMessages(last, message)) {
      last.id = `${last.id}:${message.id}`;
      last.timestamp = message.timestamp;
      last.content =
        message.meta?.kind === "revision-request"
          ? buildMergedRevisionRequestContent(last, message)
          : message.meta?.kind === "high-level-trigger" && last.kinds.at(-1) === "agent-final"
            ? buildMergedAgentFinalTriggerContent(last, message)
          : [last.content, getDisplayContent(message)].filter(Boolean).join("\n\n");
      last.kinds.push(message.meta?.kind ?? "");
      last.metaChain.push(message.meta);
      continue;
    }

    merged.push({
      id: message.id,
      sender: message.sender,
      timestamp: message.timestamp,
      content: getDisplayContent(message),
      kinds: message.meta?.kind ? [message.meta.kind] : [],
      metaChain: [message.meta],
    });
  }

  return merged;
}
