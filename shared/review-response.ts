export const REVIEW_RESPONSE_LABEL = "<revision_request>";

export function formatReviewResponseBlock(content: string): string {
  const normalized = content.trim();
  return normalized ? `${REVIEW_RESPONSE_LABEL} ${normalized}` : REVIEW_RESPONSE_LABEL;
}

export function stripLeadingReviewResponseLabel(content: string): string {
  return content.replace(/^<revision_request>\s*/u, "").trim();
}

export function extractLastReviewResponse(content: string): string {
  const marker = /<revision_request>/gu;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null = marker.exec(content);

  while (match) {
    lastMatch = match;
    match = marker.exec(content);
  }

  if (!lastMatch) {
    return "";
  }

  return content.slice(lastMatch.index + lastMatch[0].length).trim();
}

export function extractTrailingReviewResponseBlock(content: string): {
  body: string;
  response: string;
  rawBlock: string;
} | null {
  const trimmed = content.trim();
  const match = /(^|\n)<revision_request>\s*([\s\S]*)$/u.exec(trimmed);
  const response = match?.[2]?.trim();
  if (!response) {
    return null;
  }

  const startIndex = match.index + (match[1]?.length ?? 0);
  return {
    body: trimmed.slice(0, startIndex).trim(),
    response,
    rawBlock: trimmed.slice(startIndex).trim(),
  };
}
