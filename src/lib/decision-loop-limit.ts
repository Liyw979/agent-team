import { isTaskCompletedMessageRecord, type MessageRecord } from "@shared/types";

export function getLoopLimitFailedDecisionAgentName(
  messages: MessageRecord[],
): string | null {
  const failedCompletionMessage = [...messages]
    .reverse()
    .find((message) => isTaskCompletedMessageRecord(message) && message.status === "failed");
  const content = failedCompletionMessage?.content?.trim() ?? "";
  const match = /^(.*?)\s*->\s*.*已连续交流\s+\d+\s+次，任务已结束$/u.exec(content);
  const decisionAgentName = match?.[1]?.trim() ?? "";
  return decisionAgentName || null;
}
