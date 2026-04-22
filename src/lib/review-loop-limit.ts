import type { MessageRecord } from "@shared/types";

export function getLoopLimitFailedReviewerName(
  messages: Pick<MessageRecord, "content" | "meta">[],
): string | null {
  const failedCompletionMessage = [...messages]
    .reverse()
    .find((message) => message.meta?.kind === "task-completed" && message.meta?.status === "failed");
  const content = failedCompletionMessage?.content?.trim() ?? "";
  const match = /^(.*?)\s*->\s*.*已连续交流\s+\d+\s+次，任务已结束$/u.exec(content);
  const reviewerName = match?.[1]?.trim() ?? "";
  return reviewerName || null;
}
