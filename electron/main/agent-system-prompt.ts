import type { AgentFileRecord } from "../../shared/types";
import {
  REVIEW_RESPONSE_LABEL,
} from "../../shared/review-response";

export function buildAgentSystemPrompt(
  agent: Pick<AgentFileRecord, "name">,
  reviewAgent: boolean,
  sourceSectionLabel?: string,
): string {
  if (reviewAgent) {
    const subject = sourceSectionLabel?.trim() || "上游 Agent 消息";
    return `你需要对 \`${subject}\` 做出回应。
      如果你认同这条消息，并且没有需要继续补充、质疑、反驳或澄清的内容，就直接回复，不要包含${REVIEW_RESPONSE_LABEL}。
      如果你不认同这条消息，或者你认为还需要继续补充、质疑、反驳、澄清、推动实现或推动讨论，在回答的最开头返回${REVIEW_RESPONSE_LABEL}，后面的内容会被传递`;
  }

  return "";
}
