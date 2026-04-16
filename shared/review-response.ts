export const REVIEW_RESPONSE_LABEL = "<revision_request>";
export const REVIEW_RESPONSE_END_LABEL = "</revision_request>";

export function formatReviewResponseBlock(content: string): string {
  const normalized = content.trim();
  return `${REVIEW_RESPONSE_LABEL}${normalized}${REVIEW_RESPONSE_END_LABEL}`;
}

export function stripLeadingReviewResponseLabel(content: string): string {
  return content
    .replace(/^<revision_request>\s*/u, "")
    .replace(/\s*<\/revision_request>\s*$/u, "")
    .trim();
}

export function extractLastReviewResponse(content: string): string {
  const marker = /<revision_request>([\s\S]*?)<\/revision_request>/gu;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null = marker.exec(content);

  while (match) {
    lastMatch = match;
    match = marker.exec(content);
  }

  if (!lastMatch) {
    return "";
  }

  return (lastMatch[1] ?? "").trim();
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
    return null;
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
