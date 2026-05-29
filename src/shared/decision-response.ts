import { normalizeTopologyEdgeTrigger } from "./types";

const DECISION_TAG_PATTERN = /<([\w]+)>/gu;

interface FoundDecisionSignalBlock {
  contentWithoutTrigger: string;
  kind: "found";
  trigger: string;
}

const MISSING_DECISION_SIGNAL_BLOCK = {
  kind: "missing",
} as const;

export type DecisionSignalBlockResult =
  | FoundDecisionSignalBlock
  | typeof MISSING_DECISION_SIGNAL_BLOCK;

function getMatchedAllowedTriggers(
  content: string,
  allowedTriggers: readonly string[],
): string[] {
  const allowed = new Set(allowedTriggers.map((label) => normalizeTopologyEdgeTrigger(label)));
  return [...content.matchAll(DECISION_TAG_PATTERN)]
    .map((match) => `<${match[1]!}>`)
    .filter((trigger) => allowed.has(trigger));
}

export function hasSingleDecisionSignalTrigger(
  content: string,
  allowedTriggers: readonly string[],
): boolean {
  return new Set(getMatchedAllowedTriggers(content.trim(), allowedTriggers)).size === 1;
}

// 2026-05-29: 用户要求只按 allowed 起始 trigger 解析；命中后只移除第一次命中的起始 trigger，
// 不对 closing tag 做额外校验、截断或清理。
export function extractDecisionSignalBlock(
  content: string,
  allowedTriggers: readonly string[],
): DecisionSignalBlockResult {
  const trimmed = content.trim();
  const [trigger = ""] = getMatchedAllowedTriggers(trimmed, allowedTriggers);
  if (!trigger) {
    return MISSING_DECISION_SIGNAL_BLOCK;
  }

  return {
    contentWithoutTrigger: trimmed.replace(trigger, "").trim(),
    kind: "found",
    trigger,
  };
}

// 2026-05-29: 用户要求 contentWithoutTrigger 只移除第一次命中的 allowed 起始 trigger，其余内容原样保留。
export function stripDecisionResponseMarkup(
  content: string,
  allowedTriggers: readonly string[],
): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }

  if (!hasSingleDecisionSignalTrigger(trimmed, allowedTriggers)) {
    return trimmed;
  }

  const parsed = extractDecisionSignalBlock(trimmed, allowedTriggers);
  if (parsed.kind !== "found") {
    return trimmed;
  }

  return parsed.contentWithoutTrigger;
}
