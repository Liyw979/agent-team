import { extractTrailingDecisionSignalBlock } from "@shared/decision-response";
import type { Decision } from "@shared/types";

export interface ParsedDecision {
  cleanContent: string;
  decision: Decision;
  opinion: string;
  rawDecisionBlock: string;
}

export function stripStructuredSignals(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => !/^\s*(NEXT_AGENTS:|TASK_DONE\b|SESSION_REF:)/i.test(line))
    .join("\n")
    .trim();
}

export function parseDecision(content: string, decisionAgent: boolean): ParsedDecision {
  const signalMatch = extractTrailingDecisionSignalBlock(content);
  if (signalMatch) {
    return {
      cleanContent: stripStructuredSignals(signalMatch.body),
      decision: signalMatch.kind === "complete" ? "complete" : "continue",
      opinion: signalMatch.response,
      rawDecisionBlock: signalMatch.rawBlock,
    };
  }

  const cleanContent = stripStructuredSignals(content);
  if (!decisionAgent) {
    return {
      cleanContent,
      decision: "complete",
      opinion: "",
      rawDecisionBlock: "",
    };
  }

  return {
    cleanContent,
    decision: "continue",
    opinion: cleanContent,
    rawDecisionBlock: "",
  };
}
