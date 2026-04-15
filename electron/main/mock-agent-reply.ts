import { formatReviewResponseBlock } from "../../shared/review-response";

export function buildMockAgentReply(agent: string, content: string): string {
  const cleaned = content
    .replace(/\bSESSION_REF:\s*.+$/gim, "")
    .replace(/在你完成本轮所有工作后[\s\S]*$/m, "")
    .trim();
  const revisionFeedback =
    formatReviewResponseBlock(
      "我不同意直接进入下一阶段，因为当前结论缺少关键证据，且“已完成验证”的说法与现有上下文不一致。请说明验证依据，并解释为何可以得出当前结论。",
    );
  const reviewPassed = "";
  const completed = "";

  const withDecision = (body: string, decision: string = completed) =>
    [body, decision].filter(Boolean).join("\n");

  if (/需要修改|需要回应|需要响应|返工|rework|revise/i.test(cleaned)) {
    return withDecision(
      "我已重新检查当前上下文，确认这一轮需要继续响应争议点后再继续推进。",
      revisionFeedback,
    );
  }

  switch (agent) {
    case "BA":
      return "我已整理当前 Task 的目标、范围、约束与验收标准，形成了可直接执行的业务分析结果。";
    case "Code":
    case "build":
    case "Build":
      return "我已完成主要实现与本地自检，当前代码、验证步骤和交付说明已经整理完成。";
    case "UnitTest":
      return withDecision("单元测试覆盖与结构检查完成，未发现阻塞问题。", reviewPassed);
    case "IntegrationTest":
      return withDecision("集成测试链路检查完成，关键流程可以继续进入业务复核。", reviewPassed);
    case "CodeReview":
      return withDecision("代码审查完成，当前实现没有发现需要阻塞交付的缺陷。", reviewPassed);
    case "TaskReview":
      return withDecision("任务交付审视完成，交付说明、验证结论与关键文档同步情况已经核对。", reviewPassed);
    default:
      return withDecision("当前阶段审查完成，未发现阻塞问题。", reviewPassed);
  }
}
