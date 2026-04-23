export function parseTargetAgentIds(value: string[]): string[] {
  return value.map((item) => item.trim()).filter(Boolean);
}

export function buildMentionSuffix(agentIds: string[]): string {
  const mentions = [...new Set(agentIds.map((item) => item.trim()).filter(Boolean))]
    .map((item) => `@${item}`);
  return mentions.join(" ");
}

function stripLeadingMentions(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }

  const lines = trimmed.split(/\r?\n/);
  const firstLine = lines[0]?.trim() ?? "";
  if (/^(?:@\S+\s*)+$/u.test(firstLine)) {
    return lines.slice(1).join("\n").trim();
  }

  return trimmed.replace(/^(?:@\S+\s+)+/u, "").trim();
}

export function formatAgentDispatchContent(_content: string, targetAgentIds: string[]): string {
  const body = stripLeadingMentions(_content);
  const mentionSuffix = buildMentionSuffix(targetAgentIds);
  return [body, mentionSuffix].filter(Boolean).join("\n\n").trim();
}

export function formatActionRequiredRequestContent(content: string, targetAgentIds: string[]): string {
  const body = stripLeadingMentions(content);
  const mentionSuffix = buildMentionSuffix(parseTargetAgentIds(targetAgentIds));
  return [body, mentionSuffix].filter(Boolean).join("\n\n").trim();
}
