export const DECISION_CONTINUE_LABEL = "<continue>";
export const DECISION_CONTINUE_END_LABEL = "</continue>";
export const DECISION_COMPLETE_LABEL = "<complete>";
export const DECISION_COMPLETE_END_LABEL = "</complete>";

type DecisionSignalKind = "continue" | "complete";

const DECISION_SIGNAL_TAG_PATTERN = /<\/?(?:continue|complete)>/gu;

export function stripLeadingDecisionResponseLabel(content: string): string {
  return content.replace(DECISION_SIGNAL_TAG_PATTERN, "").trim();
}

export function extractLastDecisionResponse(content: string): string {
  return extractTrailingDecisionSignalBlock(content)?.response ?? "";
}

export function extractTrailingDecisionSignalBlock(content: string): {
  body: string;
  response: string;
  rawBlock: string;
  kind: DecisionSignalKind;
} | null {
  const trimmed = content.trim();
  const pattern = /<(continue|complete)>([\s\S]*?)<\/\1>/gu;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null = pattern.exec(trimmed);

  while (match) {
    lastMatch = match;
    match = pattern.exec(trimmed);
  }

  if (lastMatch && typeof lastMatch.index === "number") {
    const kind = lastMatch[1] === "complete" ? "complete" : "continue";
    const rawBlock = lastMatch[0].trim();
    const response = (lastMatch[2] ?? "").trim();
    const markerIndex = lastMatch.index;

    return {
      body: trimmed.slice(0, markerIndex).trim(),
      response,
      rawBlock,
      kind,
    };
  }

  const leadingStart = findLeadingSignalStart(trimmed);
  if (leadingStart) {
    const response = stripTrailingBareDecisionSignal(
      stripLeadingDecisionResponseLabel(trimmed),
      leadingStart.kind,
    );
    if (response) {
      return {
        body: "",
        response,
        rawBlock: trimmed,
        kind: leadingStart.kind,
      };
    }
  }

  const trailingStart = findLastSignalStart(trimmed);
  if (!trailingStart) {
    return null;
  }

  const rawBlock = trimmed.slice(trailingStart.index).trim();
  const response = stripLeadingDecisionResponseLabel(rawBlock);
  if (!response) {
    const body = trimmed.slice(0, trailingStart.index).trim();
    if (body && isBareDecisionSignal(rawBlock, trailingStart.kind)) {
      return {
        body,
        response: body,
        rawBlock,
        kind: trailingStart.kind,
      };
    }
    return null;
  }

  return {
    body: trimmed.slice(0, trailingStart.index).trim(),
    response,
    rawBlock,
    kind: trailingStart.kind,
  };
}

export function stripDecisionResponseMarkup(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }

  const parsed = extractTrailingDecisionSignalBlock(trimmed);
  if (!parsed) {
    return stripLeadingDecisionResponseLabel(trimmed);
  }

  const normalizedBody = parsed.body.replace(/\s+/g, " ").trim();
  const normalizedResponse = parsed.response.replace(/\s+/g, " ").trim();
  if (normalizedBody && normalizedBody === normalizedResponse) {
    return parsed.body.trim();
  }

  return [parsed.body, parsed.response].filter(Boolean).join("\n\n").trim();
}

function findLastSignalStart(content: string): { index: number; kind: DecisionSignalKind } | null {
  let last: { index: number; kind: DecisionSignalKind } | null = null;

  const tokens: Array<{ kind: DecisionSignalKind; start: string }> = [
    { kind: "continue", start: DECISION_CONTINUE_LABEL },
    { kind: "complete", start: DECISION_COMPLETE_LABEL },
  ];

  for (const token of tokens) {
    const index = content.lastIndexOf(token.start);
    if (index < 0) {
      continue;
    }
    if (!last || index > last.index) {
      last = { index, kind: token.kind };
    }
  }

  return last;
}

function findLeadingSignalStart(content: string): { kind: DecisionSignalKind } | null {
  if (content.startsWith(DECISION_CONTINUE_LABEL)) {
    return { kind: "continue" };
  }
  if (content.startsWith(DECISION_COMPLETE_LABEL)) {
    return { kind: "complete" };
  }
  return null;
}

function isBareDecisionSignal(rawBlock: string, kind: DecisionSignalKind): boolean {
  return rawBlock === (kind === "continue" ? DECISION_CONTINUE_LABEL : DECISION_COMPLETE_LABEL);
}

function stripTrailingBareDecisionSignal(content: string, kind: DecisionSignalKind): string {
  let normalized = content.trim();
  const label = kind === "continue" ? DECISION_CONTINUE_LABEL : DECISION_COMPLETE_LABEL;

  while (normalized.endsWith(label)) {
    const next = normalized.slice(0, -label.length).trimEnd();
    if (!next) {
      break;
    }
    normalized = next.trim();
  }

  return normalized;
}
