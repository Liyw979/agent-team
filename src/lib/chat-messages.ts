import type { MessageRecord } from "@shared/types";
import {
  buildMentionSuffix,
  formatAgentDispatchContent,
  formatRevisionRequestContent,
  parseTargetAgentIds,
} from "@shared/chat-message-format";
import {
  extractLastReviewResponse,
  stripReviewResponseMarkup,
  stripLeadingReviewResponseLabel,
} from "@shared/review-response";

export interface ChatMessageItem {
  id: string;
  sender: string;
  senderDisplayName?: string;
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
  return stripLeadingReviewResponseLabel(stripReviewResponseMarkup(content));
}

function getRevisionRequestDisplayBody(message: MessageRecord): string {
  const normalized = stripTrailingMentions(message.content);
  const extracted = extractLastReviewResponse(normalized);
  if (extracted) {
    return extracted;
  }

  return stripReviewResponseMarkup(normalized);
}

function hasMeaningfulText(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

const FINAL_DELIVERY_HEADING_PATTERN =
  /^(正式结果|正式回复|最终结果|最终回复|最终交付|交付结果|交付内容|结论|答案|输出)$/u;

function extractTrailingTopLevelSection(content: string): string {
  const headingPattern = /(^|\n)(#{1,2}\s+[^\n]+)\n/g;
  let lastHeadingIndex = -1;
  let match: RegExpExecArray | null = headingPattern.exec(content);
  while (match) {
    const headingLine = match[2]?.trim() ?? "";
    const headingTitle = headingLine.replace(/^#{1,2}\s+/u, "").trim();
    if (FINAL_DELIVERY_HEADING_PATTERN.test(headingTitle)) {
      lastHeadingIndex = match.index + match[1].length;
    }
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

  const trailingSection = extractTrailingTopLevelSection(stripReviewResponseMarkup(rawContent));
  const normalized = trailingSection
    .replace(/\n(?:---|\*\*\*)(?:\s*\n?)*$/u, "")
    .trim();
  return hasMeaningfulText(normalized) ? normalized : rawContent;
}

function buildMergedRevisionRequestContent(previous: ChatMessageItem, current: MessageRecord): string {
  const summary = previous.content.trim();
  const feedback = getRevisionRequestDisplayBody(current);
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
    `${summary}\n\n${feedback}`,
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

function shouldMergeAgentDispatch(previous: ChatMessageItem, current: MessageRecord) {
  return (
    previous.kinds.at(-1) === "agent-dispatch" &&
    current.meta?.kind === "agent-dispatch"
  );
}

function shouldMergeAgentFinalWithDispatch(previous: ChatMessageItem, current: MessageRecord) {
  return (
    previous.kinds.at(-1) === "agent-final" &&
    current.meta?.kind === "agent-dispatch"
  );
}

function shouldMergeRevisionRequest(previous: ChatMessageItem, current: MessageRecord) {
  return (
    previous.kinds.at(-1) === "agent-final" &&
    previous.metaChain.at(-1)?.reviewDecision === "needs_revision" &&
    current.meta?.kind === "revision-request"
  );
}

function findRevisionRequestMergeTargetIndex(
  merged: ChatMessageItem[],
  current: MessageRecord,
): number {
  if (current.meta?.kind !== "revision-request" || !isNonSystemAgent(current.sender)) {
    return -1;
  }

  for (let index = merged.length - 1; index >= 0; index -= 1) {
    const candidate = merged[index];
    if (!candidate || candidate.sender !== current.sender) {
      continue;
    }
    if (candidate.kinds.includes("revision-request")) {
      continue;
    }
    if (
      candidate.kinds.at(-1) === "agent-final" &&
      candidate.metaChain.at(-1)?.reviewDecision === "needs_revision"
    ) {
      return index;
    }
  }

  return -1;
}

function shouldMergeMessages(previous: ChatMessageItem | undefined, current: MessageRecord) {
  if (!previous || previous.sender !== current.sender || !isNonSystemAgent(previous.sender)) {
    return false;
  }

  return (
    shouldMergeAgentDispatch(previous, current) ||
    shouldMergeAgentFinalWithDispatch(previous, current) ||
    shouldMergeRevisionRequest(previous, current)
  );
}

function getDisplayContent(message: MessageRecord): string {
  if (message.meta?.kind === "agent-final") {
    return extractAgentFinalDisplayContent(message);
  }
  if (message.meta?.kind === "agent-dispatch") {
    return formatAgentDispatchContent(
      message.content,
      parseTargetAgentIds(message.meta?.targetAgentIds),
    );
  }
  if (message.meta?.kind === "revision-request") {
    return formatRevisionRequestContent(
      getRevisionRequestDisplayBody(message),
      message.meta?.targetAgentId,
    );
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
          : message.meta?.kind === "agent-dispatch" && last.kinds.at(-1) === "agent-final"
            ? buildMergedAgentFinalTriggerContent(last, message)
          : [last.content, getDisplayContent(message)].filter(Boolean).join("\n\n");
      last.kinds.push(message.meta?.kind ?? "");
      last.metaChain.push(message.meta);
      continue;
    }

    const revisionRequestMergeTargetIndex = findRevisionRequestMergeTargetIndex(merged, message);
    if (revisionRequestMergeTargetIndex >= 0) {
      const target = merged[revisionRequestMergeTargetIndex];
      if (target) {
        target.id = `${target.id}:${message.id}`;
        target.timestamp = message.timestamp;
        target.content = buildMergedRevisionRequestContent(target, message);
        target.kinds.push(message.meta?.kind ?? "");
        target.metaChain.push(message.meta);
        continue;
      }
    }

    merged.push({
      id: message.id,
      sender: typeof message.meta?.senderDisplayName === "string" && message.meta.senderDisplayName.trim()
        ? message.meta.senderDisplayName.trim()
        : message.sender,
      senderDisplayName:
        typeof message.meta?.senderDisplayName === "string" && message.meta.senderDisplayName.trim()
          ? message.meta.senderDisplayName.trim()
          : undefined,
      timestamp: message.timestamp,
      content: getDisplayContent(message),
      kinds: message.meta?.kind ? [message.meta.kind] : [],
      metaChain: [message.meta],
    });
  }

  return merged;
}
