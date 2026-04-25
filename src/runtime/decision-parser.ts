import { extractTrailingDecisionSignalBlock } from "@shared/decision-response";

export type Decision = "complete" | "continue" | "invalid";

export interface ParsedDecision {
  cleanContent: string;
  decision: Decision;
  opinion: string | null;
  rawDecisionBlock: string | null;
  validationError: string | null;
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
      validationError: null,
    };
  }

  const cleanContent = stripStructuredSignals(content);
  if (!decisionAgent) {
    return {
      cleanContent,
      decision: "complete",
      opinion: null,
      rawDecisionBlock: null,
      validationError: null,
    };
  }

  return {
    cleanContent,
    decision: "continue",
    opinion: cleanContent || null,
    rawDecisionBlock: null,
    validationError: null,
  };
}
