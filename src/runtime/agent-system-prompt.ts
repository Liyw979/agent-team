import {
  REVIEW_COMPLETE_LABEL,
  REVIEW_CONTINUE_LABEL,
} from "../shared/review-response";

export function buildAgentSystemPrompt(): string {
  return `
      回复必须以<xxx>标签开头
      如果当前分支还需要继续处理，请使用${REVIEW_CONTINUE_LABEL}\n你的建议、挑战或补充。
      如果当前分支已经完成判定，请使用${REVIEW_COMPLETE_LABEL}\n你的结束结论。`;
}
