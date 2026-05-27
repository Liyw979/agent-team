import { normalizeTopologyEdgeTrigger } from "./types";

const DECISION_TAG_PATTERN = /<\w+>/gu;

function buildDecisionEndLabel(label: string): string {
  return `</${label.slice(1, -1)}>`;
}

interface DecisionSignalToken {
  start: string;
  end: string;
}

interface DecisionAnchorMatch {
  trigger: string;
  index: number;
  endIndex: number;
  responseRaw: string;
  markerRanges: DecisionMarkerRange[];
}

interface DecisionMarkerRange {
  start: number;
  end: number;
}

interface FoundDecisionSignalBlock {
  kind: "found";
  body: string;
  response: string;
  rawBlock: string;
  trigger: string;
}

const MISSING_DECISION_SIGNAL_BLOCK = {
  kind: "missing",
} as const;

export type DecisionSignalBlockResult =
  | FoundDecisionSignalBlock
  | typeof MISSING_DECISION_SIGNAL_BLOCK;

function normalizeDecisionSignalTokens(
  allowedTriggers: readonly string[],
): DecisionSignalToken[] {
  const normalized = [...new Set(allowedTriggers.map((label) => normalizeTopologyEdgeTrigger(label)))];
  return normalized.map((label) => ({
    start: label,
    end: buildDecisionEndLabel(label),
  }));
}

function isBareDecisionAnchor(anchor: DecisionAnchorMatch): boolean {
  const range = anchor.markerRanges[0];
  return anchor.markerRanges.length === 1
    && range !== undefined
    && range.start === anchor.index
    && range.end === anchor.endIndex
    && anchor.responseRaw.trim() === "";
}

function isBoundaryRepeatedBareTrigger(
  content: string,
  anchors: readonly DecisionAnchorMatch[],
): boolean {
  if (anchors.length !== 2) {
    return false;
  }
  const [first, second] = anchors;
  return first !== undefined
    && second !== undefined
    && first.trigger === second.trigger
    && isBareDecisionAnchor(first)
    && isBareDecisionAnchor(second)
    && first.index === 0
    && second.endIndex === content.length
    && content.slice(first.endIndex, second.index).trim().length > 0;
}

export function hasSingleDecisionSignalTrigger(
  content: string,
  allowedTriggers: readonly string[],
): boolean {
  const trimmed = content.trim();
  const tokens = normalizeDecisionSignalTokens(allowedTriggers);
  const anchors = collectDecisionSignalAnchors(trimmed, tokens);
  return anchors.length === 1 || isBoundaryRepeatedBareTrigger(trimmed, anchors);
}

// 用户要求：allowedTriggers 必须由调用方显式传入；共享解析结果不引入 multiple 状态。
export function extractDecisionSignalBlock(
  content: string,
  allowedTriggers: readonly string[],
): DecisionSignalBlockResult {
  const trimmed = content.trim();
  const tokens = normalizeDecisionSignalTokens(allowedTriggers);
  const anchors = collectDecisionSignalAnchors(trimmed, tokens);
  const anchor = anchors.at(-1);
  if (!anchor) {
    return MISSING_DECISION_SIGNAL_BLOCK;
  }

  const markerRanges = mergeDecisionMarkerRanges(anchors.flatMap((match) => match.markerRanges));
  const body = stripDecisionSignalMarkers(trimmed, markerRanges, 0, anchor.index).trim();
  const trailingRemainder = stripDecisionSignalMarkers(
    trimmed,
    markerRanges,
    anchor.endIndex,
    trimmed.length,
  ).trim();
  const anchorResponse = anchor.responseRaw.trim();
  const response = [anchorResponse, trailingRemainder].filter(Boolean).join("\n\n").trim() || body;
  return {
    kind: "found",
    body: body || response,
    response,
    rawBlock: trimmed,
    trigger: anchor.trigger,
  };
}

// 用户要求：allowedTriggers 必须由调用方显式传入，避免缺失上下文被空集合掩盖。
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

  const normalizedBody = parsed.body.replace(/\s+/g, " ").trim();
  const normalizedResponse = parsed.response.replace(/\s+/g, " ").trim();
  if (normalizedBody && normalizedBody === normalizedResponse) {
    return parsed.body.trim();
  }

  return [parsed.body, parsed.response].filter(Boolean).join("\n\n").trim();
}

function collectDecisionSignalAnchors(
  content: string,
  tokens: readonly DecisionSignalToken[],
): DecisionAnchorMatch[] {
  const tokenByStart = new Map(tokens.map((token) => [token.start, token]));
  return [...content.matchAll(DECISION_TAG_PATTERN)]
    .flatMap((match) => {
      const start = match.index;
      const token = tokenByStart.get(match[0]);
      if (typeof start !== "number" || !token) {
        return [];
      }

      const closeStart = content.indexOf(token.end, start + token.start.length);
      const wrapped = closeStart >= 0;
      const endIndex = wrapped ? closeStart + token.end.length : start + token.start.length;
      return [{
        trigger: token.start,
        index: start,
        endIndex,
        responseRaw: wrapped ? content.slice(start + token.start.length, closeStart) : "",
        markerRanges: wrapped
          ? [
            { start, end: start + token.start.length },
            { start: closeStart, end: endIndex },
          ]
          : [{ start, end: start + token.start.length }],
      } satisfies DecisionAnchorMatch];
    });
}

function mergeDecisionMarkerRanges(
  ranges: DecisionMarkerRange[],
): DecisionMarkerRange[] {
  if (ranges.length === 0) {
    return [];
  }

  const sorted = [...ranges].sort((left, right) =>
    left.start === right.start ? left.end - right.end : left.start - right.start,
  );
  const merged: DecisionMarkerRange[] = [sorted[0]!];

  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index]!;
    const previous = merged[merged.length - 1]!;
    if (current.start <= previous.end) {
      previous.end = Math.max(previous.end, current.end);
      continue;
    }
    merged.push({ ...current });
  }

  return merged;
}

function stripDecisionSignalMarkers(
  content: string,
  ranges: DecisionMarkerRange[],
  startIndex: number,
  endIndex: number,
): string {
  if (startIndex >= endIndex) {
    return "";
  }

  let cursor = startIndex;
  const parts: string[] = [];
  for (const range of ranges) {
    if (range.end <= startIndex) {
      continue;
    }
    if (range.start >= endIndex) {
      break;
    }
    if (cursor < range.start) {
      parts.push(content.slice(cursor, Math.min(range.start, endIndex)));
    }
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < endIndex) {
    parts.push(content.slice(cursor, endIndex));
  }
  return parts.join("");
}
