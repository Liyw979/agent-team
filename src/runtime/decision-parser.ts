import { DEFAULT_TOPOLOGY_TRIGGER } from "@shared/types";
import {
  extractDecisionSignalBlock,
  hasSingleDecisionSignalTrigger,
  stripDecisionResponseMarkup,
} from "@shared/decision-response";

export type ParsedDecision =
  | {
      contentWithoutTrigger: string;
      kind: "valid";
      trigger: string;
    }
  | {
      kind: "invalid";
      validationError: string;
    };

type ValidParsedDecision = Extract<ParsedDecision, { kind: "valid" }>;

export function parseDecision(
  content: string,
  allowedTriggers: readonly string[],
): ParsedDecision {
  // 2026-05-27: 用户要求 decision-parser 不再保留 stripStructuredSignals 后处理，判定回复只按显式 trigger 解析。
  const signalMatch = extractDecisionSignalBlock(content, allowedTriggers);
  const hasOneDecisionTrigger = hasSingleDecisionSignalTrigger(content, allowedTriggers)
    && signalMatch.kind === "found";
  if (!hasOneDecisionTrigger) {
    return {
      kind: "invalid",
      validationError: `回复必须有且仅有 ${allowedTriggers.join(" / ")} 之一`,
    };
  }

  return {
    contentWithoutTrigger: stripDecisionResponseMarkup(content, allowedTriggers).trim(),
    kind: "valid",
    trigger: signalMatch.trigger,
  };
}

export function parseDefaultAgentResult(content: string): ValidParsedDecision {
  return {
    contentWithoutTrigger: content.trim(),
    kind: "valid",
    trigger: DEFAULT_TOPOLOGY_TRIGGER,
  };
}
