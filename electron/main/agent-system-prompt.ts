import type { AgentRecord } from "../../shared/types";
import {
  REVIEW_APPROVED_LABEL,
  REVIEW_NEEDS_REVISION_LABEL,
} from "../../shared/review-response";

export function buildAgentSystemPrompt(
  agent: Pick<AgentRecord, "name">,
  reviewAgent: boolean,
  sourceSectionLabel?: string,
): string {
  if (reviewAgent) {
    const subject = sourceSectionLabel?.trim() || "上游 Agent 消息";
    return `你需要对 \`${subject}\` 做出回应。
      你的回复必须以<xxx>标签开头
      如果你认同对方，请使用${REVIEW_APPROVED_LABEL}\n你的同意结论。
      如果你不认同对方，请使用${REVIEW_NEEDS_REVISION_LABEL}\n你的建议、挑战。`;
  }

  return "";
}
