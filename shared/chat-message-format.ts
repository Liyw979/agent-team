export function parseTargetAgentIds(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildMentionSuffix(agentIds: string[]): string {
  const mentions = [...new Set(agentIds.map((item) => item.trim()).filter(Boolean))]
    .map((item) => `@${item}`);
  return mentions.join(" ");
}

export function stripLeadingMentions(content: string): string {
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

export function formatHighLevelTriggerContent(_content: string, targetAgentIds: string[]): string {
  const mentionSuffix = buildMentionSuffix(targetAgentIds);
  return mentionSuffix.trim();
}

export function formatRevisionRequestContent(content: string, targetAgentId?: string): string {
  const body = stripLeadingMentions(content);
  const mentionSuffix = targetAgentId ? `@${targetAgentId}` : "";
  return [body, mentionSuffix].filter(Boolean).join("\n\n").trim();
}
