import { DEFAULT_TOPOLOGY_TRIGGER } from "@shared/types";
import { extractTrailingDecisionSignalBlock, stripDecisionResponseMarkup } from "@shared/decision-response";

type ParsedDecisionBase = {
  cleanContent: string;
  opinion: string;
};

export type ParsedDecision =
  | (ParsedDecisionBase & {
      kind: "valid";
      trigger: string;
      rawDecisionBlock?: string;
    })
  | (ParsedDecisionBase & {
      kind: "invalid";
      validationError: string;
    });

export function stripStructuredSignals(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => !/^\s*(NEXT_AGENTS:|TASK_DONE\b|SESSION_REF:)/i.test(line))
    .join("\n")
    .trim();
}

export function normalizeDecisionDisplayContent(
  content: string,
  allowedTriggerLiterals: readonly string[],
): string {
  return stripStructuredSignals(
    stripDecisionResponseMarkup(content, allowedTriggerLiterals),
  );
}

export function parseDecision(
  content: string,
  decisionAgent: boolean,
  allowedTriggers: readonly string[] = [],
): ParsedDecision {
  const signalMatch = extractTrailingDecisionSignalBlock(content, allowedTriggers);
  if (signalMatch.kind === "found") {
    return {
      cleanContent: normalizeDecisionDisplayContent(
        content,
        allowedTriggers,
      ),
      kind: "valid",
      trigger: signalMatch.trigger,
      opinion: stripStructuredSignals(signalMatch.response),
      rawDecisionBlock: signalMatch.rawBlock,
    };
  }

  const cleanContent = stripStructuredSignals(content);
  if (!decisionAgent) {
    return {
      cleanContent,
      kind: "valid",
      trigger: DEFAULT_TOPOLOGY_TRIGGER,
      opinion: "",
    };
  }

  return {
    cleanContent,
    opinion: cleanContent,
    kind: "invalid",
    validationError: allowedTriggers.length > 0
      ? `当前 Agent 必须返回以下 trigger 之一：${allowedTriggers.join(" / ")}`
      : "当前 Agent 未配置任何可用 trigger",
  };
}
