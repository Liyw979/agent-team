export const REVIEW_RESPONSE_LABEL = "<revision_request>";
export const REVIEW_RESPONSE_END_LABEL = "</revision_request>";
const REVIEW_RESPONSE_TAG_PATTERN = /<\/?revision_request>/gu;

export function formatReviewResponseBlock(content: string): string {
  const normalized = content.trim();
  return `${REVIEW_RESPONSE_LABEL}${normalized}${REVIEW_RESPONSE_END_LABEL}`;
}

export function stripLeadingReviewResponseLabel(content: string): string {
  return content.replace(REVIEW_RESPONSE_TAG_PATTERN, "").trim();
}

export function extractLastReviewResponse(content: string): string {
  return extractTrailingReviewResponseBlock(content)?.response ?? "";
}

export function extractTrailingReviewResponseBlock(content: string): {
  body: string;
  response: string;
  rawBlock: string;
} | null {
  const trimmed = content.trim();
  const pattern = /<revision_request>([\s\S]*?)<\/revision_request>/gu;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null = pattern.exec(trimmed);

  while (match) {
    lastMatch = match;
    match = pattern.exec(trimmed);
  }

  if (!lastMatch || typeof lastMatch.index !== "number") {
    const markerIndex = trimmed.lastIndexOf(REVIEW_RESPONSE_LABEL);
    if (markerIndex < 0) {
      return null;
    }

    const rawBlock = trimmed.slice(markerIndex).trim();
    const response = stripLeadingReviewResponseLabel(rawBlock);
    if (!response) {
      return null;
    }

    return {
      body: trimmed.slice(0, markerIndex).trim(),
      response,
      rawBlock,
    };
  }

  const rawBlock = lastMatch[0].trim();
  const response = (lastMatch[1] ?? "").trim();
  const markerIndex = lastMatch.index;

  return {
    body: trimmed.slice(0, markerIndex).trim(),
    response,
    rawBlock,
  };
}

export function stripReviewResponseMarkup(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }

  const parsed = extractTrailingReviewResponseBlock(trimmed);
  if (!parsed) {
    return stripLeadingReviewResponseLabel(trimmed);
  }

  return [parsed.body, parsed.response].filter(Boolean).join("\n\n").trim();
}
