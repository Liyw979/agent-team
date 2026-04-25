import type { MessageRecord } from "@shared/types";
import { withOptionalString } from "@shared/object-utils";
import {
  getMessageSenderDisplayName,
  isAgentDispatchMessageRecord,
  isAgentFinalMessageRecord,
} from "@shared/types";
import {
  buildMentionSuffix,
  parseTargetAgentIds,
} from "@shared/chat-message-format";
import {
  extractLastDecisionResponse,
  stripDecisionResponseMarkup,
  stripLeadingDecisionResponseLabel,
} from "@shared/decision-response";

export interface ChatMessageItem {
  id: string;
  sender: string;
  senderDisplayName?: string;
  timestamp: string;
  content: string;
  kinds: string[];
  messageChain: MessageRecord[];
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

function extractTrailingMentionAgentIds(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed) {
    return [];
  }

  const lines = trimmed.split(/\r?\n/);
  const mentions: string[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line) {
      if (mentions.length > 0) {
        continue;
      }
      continue;
    }
    if (!/^(?:@\S+\s*)+$/u.test(line)) {
      break;
    }
    mentions.unshift(
      ...line
        .split(/\s+/u)
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => item.replace(/^@/u, "")),
    );
  }

  return parseTargetAgentIds(mentions);
}

const TRAILING_FOLLOW_UP_OFFER_PATTERN =
  /\n\n(?<tail>(?:如果你(?:愿意|希望|需要)|若你(?:愿意|希望|需要)|如需)[\s\S]*)$/u;

export function stripTrailingFollowUpOffer(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }

  const match = TRAILING_FOLLOW_UP_OFFER_PATTERN.exec(trimmed);
  if (!match || typeof match.index !== "number") {
    return trimmed;
  }

  const tail = typeof match.groups?.["tail"] === "string"
    ? match.groups["tail"].trim()
    : "";
  if (!tail) {
    return trimmed;
  }
  if (!/(?:我(?:也)?可以|可继续|下一步可以)/u.test(tail)) {
    return trimmed;
  }

  return trimmed.slice(0, match.index).trimEnd();
}

function stripRevisionFeedbackLabel(content: string): string {
  return stripLeadingDecisionResponseLabel(stripDecisionResponseMarkup(content));
}

function getActionRequiredRequestDisplayBody(message: MessageRecord): string {
  const normalized = stripTrailingMentions(message.content);
  const extracted = extractLastDecisionResponse(normalized);
  if (extracted) {
    return extracted;
  }

  return stripDecisionResponseMarkup(normalized);
}

function formatDisplayContentWithStoredMentions(sourceContent: string, body: string): string {
  const mentions = extractTrailingMentionAgentIds(sourceContent);
  return [stripTrailingMentions(body), buildMentionSuffix(mentions)].filter(Boolean).join("\n\n").trim();
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
      lastHeadingIndex = match.index + (match[1]?.length ?? 0);
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
  const rawContent = message.content.trim();
  if (!rawContent) {
    return "";
  }

  const normalizedRawContent = stripDecisionResponseMarkup(rawContent);
  const trailingSection = isAgentFinalMessageRecord(message) && message.decision
    ? normalizedRawContent
    : extractTrailingTopLevelSection(normalizedRawContent);
  const normalized = trailingSection
    .replace(/\n(?:---|\*\*\*)(?:\s*\n?)*$/u, "")
    .trim();
  return hasMeaningfulText(normalized) ? normalized : message.content.trim();
}

function buildMergedActionRequiredRequestContent(previous: ChatMessageItem, current: MessageRecord): string {
  const summary = previous.content.trim();
  const feedback = getActionRequiredRequestDisplayBody(current);
  const previousLastMessage = previous.messageChain.at(-1);
  if (!feedback) {
    return formatDisplayContentWithStoredMentions(current.content, summary);
  }

  const normalizedSummary = summary.replace(/\s+/g, " ").trim();
  const normalizedFeedback = feedback.replace(/\s+/g, " ").trim();
  const normalizedSummaryFeedback = stripRevisionFeedbackLabel(summary)
    .replace(/\s+/g, " ")
    .trim();
  const normalizedPreviousFinalResponse =
    previousLastMessage
    && isAgentFinalMessageRecord(previousLastMessage)
    && previousLastMessage.decision === "continue"
      ? (extractLastDecisionResponse(previousLastMessage.content) || "")
        .replace(/\s+/g, " ")
        .trim()
      : "";

  if (!normalizedSummary) {
    return formatDisplayContentWithStoredMentions(current.content, feedback);
  }

  if (
    normalizedSummary === normalizedFeedback ||
    normalizedSummaryFeedback === normalizedFeedback ||
    normalizedPreviousFinalResponse === normalizedFeedback
  ) {
    return formatDisplayContentWithStoredMentions(current.content, summary);
  }

  return formatDisplayContentWithStoredMentions(current.content, `${summary}\n\n${feedback}`);
}

function buildMergedAgentFinalTriggerContent(previous: ChatMessageItem, current: MessageRecord): string {
  const base = stripTrailingFollowUpOffer(previous.content.trim());
  const targets = extractTrailingMentionAgentIds(current.content);
  const resolvedTargets = targets.length > 0
    ? targets
    : (isAgentDispatchMessageRecord(current) ? parseTargetAgentIds(current.targetAgentIds) : []);

  if (resolvedTargets.length === 0) {
    return [base, current.content.trim()].filter(Boolean).join("\n\n");
  }

  const mergedTargets = [...new Set([
    ...extractTrailingMentionAgentIds(previous.content),
    ...resolvedTargets,
  ])];
  return [stripTrailingMentions(base), buildMentionSuffix(mergedTargets)].filter(Boolean).join("\n\n");
}

function buildMergedAgentDispatchContent(previous: ChatMessageItem, current: MessageRecord): string {
  const previousBody = stripTrailingMentions(stripTrailingFollowUpOffer(previous.content.trim()));
  const previousTargets = extractTrailingMentionAgentIds(previous.content);
  const currentDisplayContent = getDisplayContent(current);
  const currentBody = stripTrailingMentions(currentDisplayContent);
  const currentTargets = extractTrailingMentionAgentIds(currentDisplayContent);
  const mergedTargets = [...new Set([...previousTargets, ...currentTargets])];
  const bodyParts: string[] = [];
  const normalizedPreviousBody = previousBody.replace(/\s+/g, " ").trim();
  const normalizedCurrentBody = currentBody.replace(/\s+/g, " ").trim();

  if (previousBody) {
    bodyParts.push(previousBody);
  }
  if (currentBody && normalizedCurrentBody !== normalizedPreviousBody) {
    bodyParts.push(currentBody);
  }

  return [bodyParts.join("\n\n").trim(), buildMentionSuffix(mergedTargets)].filter(Boolean).join("\n\n");
}

function shouldMergeAgentDispatch(previous: ChatMessageItem, current: MessageRecord) {
  return (
    previous.kinds.at(-1) === "agent-dispatch" &&
    current.kind === "agent-dispatch"
  );
}

function shouldMergeAgentFinalWithDispatch(previous: ChatMessageItem, current: MessageRecord) {
  return (
    previous.kinds.at(-1) === "agent-final" &&
    current.kind === "agent-dispatch"
  );
}

function shouldMergeActionRequiredRequest(previous: ChatMessageItem, current: MessageRecord) {
  const previousLastMessage = previous.messageChain.at(-1);
  return (
    previous.kinds.at(-1) === "agent-final" &&
    !!previousLastMessage &&
    isAgentFinalMessageRecord(previousLastMessage) &&
    previousLastMessage.decision === "continue" &&
    current.kind === "continue-request"
  );
}

function findActionRequiredRequestMergeTargetIndex(
  merged: ChatMessageItem[],
  current: MessageRecord,
): number {
  if (current.kind !== "continue-request" || !isNonSystemAgent(current.sender)) {
    return -1;
  }

  for (let index = merged.length - 1; index >= 0; index -= 1) {
    const candidate = merged[index];
    const candidateLastMessage = candidate?.messageChain.at(-1);
    if (!candidate || candidate.sender !== current.sender) {
      continue;
    }
    if (candidate.kinds.includes("continue-request")) {
      continue;
    }
    if (
      candidate.kinds.at(-1) === "agent-final" &&
      !!candidateLastMessage &&
      isAgentFinalMessageRecord(candidateLastMessage) &&
      candidateLastMessage.decision === "continue"
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
    shouldMergeActionRequiredRequest(previous, current)
  );
}

function getDisplayContent(message: MessageRecord): string {
  if (message.kind === "agent-final") {
    return extractAgentFinalDisplayContent(message);
  }
  if (message.kind === "agent-dispatch") {
    return message.content.trim();
  }
  if (message.kind === "continue-request") {
    return formatDisplayContentWithStoredMentions(message.content, getActionRequiredRequestDisplayBody(message));
  }
  return message.content;
}

export function mergeTaskChatMessages(messages: MessageRecord[]): ChatMessageItem[] {
  const merged: ChatMessageItem[] = [];

  for (const message of messages) {
    const last = merged.at(-1);
    const senderDisplayName = getMessageSenderDisplayName(message)?.trim();

    if (last && shouldMergeMessages(last, message)) {
      last.id = `${last.id}:${message.id}`;
      last.timestamp = message.timestamp;
      last.content =
        message.kind === "continue-request"
          ? buildMergedActionRequiredRequestContent(last, message)
          : message.kind === "agent-dispatch" && last.kinds.at(-1) === "agent-final"
            ? buildMergedAgentFinalTriggerContent(last, message)
            : message.kind === "agent-dispatch" && last.kinds.at(-1) === "agent-dispatch"
              ? buildMergedAgentDispatchContent(last, message)
              : [last.content, getDisplayContent(message)].filter(Boolean).join("\n\n");
      last.kinds.push(message.kind);
      last.messageChain.push(message);
      continue;
    }

    const revisionRequestMergeTargetIndex = findActionRequiredRequestMergeTargetIndex(merged, message);
    if (revisionRequestMergeTargetIndex >= 0) {
      const target = merged[revisionRequestMergeTargetIndex];
      if (target) {
        target.id = `${target.id}:${message.id}`;
        target.timestamp = message.timestamp;
        target.content = buildMergedActionRequiredRequestContent(target, message);
        target.kinds.push(message.kind);
        target.messageChain.push(message);
        continue;
      }
    }

    merged.push(withOptionalString({
      id: message.id,
      sender: senderDisplayName
        ? senderDisplayName
        : message.sender,
      timestamp: message.timestamp,
      content: getDisplayContent(message),
      kinds: [message.kind],
      messageChain: [message],
    }, "senderDisplayName", senderDisplayName));
  }

  return merged;
}
