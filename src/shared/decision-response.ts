import { normalizeTopologyEdgeTrigger } from "./types";

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

interface FoundDecisionAnchorResult {
  kind: "found";
  anchor: DecisionAnchorMatch;
}

interface FoundDecisionStartTokenResult {
  kind: "found";
  token: DecisionSignalToken;
}

const MISSING_DECISION_SIGNAL_BLOCK = {
  kind: "missing",
} as const;

const MISSING_DECISION_ANCHOR_RESULT = {
  kind: "missing",
} as const;

const MISSING_DECISION_START_TOKEN_RESULT = {
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

// 用户要求：allowedTriggers 必须由调用方显式传入，避免缺失上下文被默认空集合掩盖。
export function extractTrailingDecisionSignalBlock(
  content: string,
  allowedTriggers: readonly string[],
): DecisionSignalBlockResult {
  const trimmed = content.trim();
  const tokens = normalizeDecisionSignalTokens(allowedTriggers);
  const structure = collectDecisionSignalStructure(trimmed, tokens);
  if (structure.anchorResult.kind === "missing") {
    return MISSING_DECISION_SIGNAL_BLOCK;
  }
  const anchor = structure.anchorResult.anchor;

  const body = stripDecisionSignalMarkers(trimmed, structure.markerRanges, 0, anchor.index).trim();
  const trailingRemainder = stripDecisionSignalMarkers(
    trimmed,
    structure.markerRanges,
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

// 用户要求：allowedTriggers 必须由调用方显式传入，避免缺失上下文被默认空集合掩盖。
export function stripDecisionResponseMarkup(
  content: string,
  allowedTriggers: readonly string[],
): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }

  const parsed = extractTrailingDecisionSignalBlock(trimmed, allowedTriggers);
  if (parsed.kind === "missing") {
    return trimmed;
  }

  const normalizedBody = parsed.body.replace(/\s+/g, " ").trim();
  const normalizedResponse = parsed.response.replace(/\s+/g, " ").trim();
  if (normalizedBody && normalizedBody === normalizedResponse) {
    return parsed.body.trim();
  }

  return [parsed.body, parsed.response].filter(Boolean).join("\n\n").trim();
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function collectDecisionSignalStructure(
  content: string,
  tokens: readonly DecisionSignalToken[],
): {
  anchorResult: FoundDecisionAnchorResult | typeof MISSING_DECISION_ANCHOR_RESULT;
  markerRanges: DecisionMarkerRange[];
} {
  const markerRanges: DecisionMarkerRange[] = [];
  const sortedTokens = [...tokens].sort((left, right) => right.start.length - left.start.length);
  const wrappedMatches = collectTopLevelWrappedMatches(content, sortedTokens);
  const wrappedRanges = wrappedMatches.map((match) => ({
    start: match.index,
    end: match.endIndex,
  }));
  for (const match of wrappedMatches) {
    const endToken = buildDecisionEndLabel(match.trigger);
    markerRanges.push(
      { start: match.index, end: match.index + match.trigger.length },
      { start: match.endIndex - endToken.length, end: match.endIndex },
    );
  }

  let lastMatchResult: FoundDecisionAnchorResult | typeof MISSING_DECISION_ANCHOR_RESULT =
    MISSING_DECISION_ANCHOR_RESULT;
  for (const match of wrappedMatches) {
    if (lastMatchResult.kind === "missing" || match.index >= lastMatchResult.anchor.index) {
      lastMatchResult = {
        kind: "found",
        anchor: match,
      };
    }
  }

  for (const token of sortedTokens) {
    const barePattern = new RegExp(escapeForRegex(token.start), "gu");
    // 协议约束是“命中允许 trigger 即有效”，因此 bare trigger 只要不位于其他 wrapped trigger 内，
    // 无论出现在开头、正文中还是尾部，都参与最终决策锚点判定。
    for (const bareMatch of content.matchAll(barePattern)) {
      const start = bareMatch.index;
      if (typeof start !== "number") {
        continue;
      }
      const insideWrappedRange = wrappedRanges.some((range) => start >= range.start && start < range.end);
      if (insideWrappedRange) {
        continue;
      }

      markerRanges.push({ start, end: start + token.start.length });
      if (lastMatchResult.kind === "missing" || start >= lastMatchResult.anchor.index) {
        lastMatchResult = {
          kind: "found",
          anchor: {
            trigger: token.start,
            index: start,
            endIndex: start + token.start.length,
            responseRaw: "",
          },
        };
      }
    }
  }

  return {
    anchorResult: lastMatchResult,
    markerRanges: mergeDecisionMarkerRanges(markerRanges),
  };
}

function collectTopLevelWrappedMatches(
  content: string,
  tokens: readonly DecisionSignalToken[],
): DecisionAnchorMatch[] {
  const matches: DecisionAnchorMatch[] = [];
  const stack: Array<{ token: DecisionSignalToken; markerStart: number }> = [];
  let index = 0;

  while (index < content.length) {
    const top = stack[stack.length - 1];
    if (!top) {
      const startTokenResult = findDecisionStartTokenAt(content, index, tokens);
      if (startTokenResult.kind === "missing") {
        index += 1;
        continue;
      }

      const startToken = startTokenResult.token;
      stack.push({ token: startToken, markerStart: index });
      index += startToken.start.length;
      continue;
    }

    if (content.startsWith(top.token.start, index)) {
      const remainingEndTokenCount = countDecisionTokenOccurrencesFrom(content, top.token.end, index);
      if (remainingEndTokenCount <= stack.length) {
        index += top.token.start.length;
        continue;
      }
      stack.push({ token: top.token, markerStart: index });
      index += top.token.start.length;
      continue;
    }

    if (content.startsWith(top.token.end, index)) {
      stack.pop();
      const endIndex = index + top.token.end.length;
      if (stack.length === 0) {
        matches.push({
          trigger: top.token.start,
          index: top.markerStart,
          endIndex,
          responseRaw: content.slice(
            top.markerStart + top.token.start.length,
            index,
          ),
        });
      }
      index = endIndex;
      continue;
    }

    index += 1;
  }

  return matches;
}

function countDecisionTokenOccurrencesFrom(
  content: string,
  token: string,
  startIndex: number,
): number {
  let matchIndex = content.indexOf(token, startIndex);
  let count = 0;

  while (matchIndex >= 0) {
    count += 1;
    matchIndex = content.indexOf(token, matchIndex + token.length);
  }

  return count;
}

function findDecisionStartTokenAt(
  content: string,
  index: number,
  tokens: readonly DecisionSignalToken[],
): FoundDecisionStartTokenResult | typeof MISSING_DECISION_START_TOKEN_RESULT {
  for (const token of tokens) {
    if (content.startsWith(token.start, index)) {
      return {
        kind: "found",
        token,
      };
    }
  }
  return MISSING_DECISION_START_TOKEN_RESULT;
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
