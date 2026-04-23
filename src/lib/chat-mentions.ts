export interface MentionContext {
  start: number;
  end: number;
  query: string;
}

interface MentionOptionItem {
  agentId: string;
  displayName: string;
  mentionLabel: string;
}

export function getMentionContext(value: string, caret: number): MentionContext | null {
  const prefix = value.slice(0, caret);
  const match = prefix.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) {
    return null;
  }

  const start = prefix.lastIndexOf("@");
  if (start < 0) {
    return null;
  }

  return {
    start,
    end: caret,
    query: match[1] ?? "",
  };
}

export function getMentionOptions(availableAgents: string[], query: string): string[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [...availableAgents];
  }

  return availableAgents.filter((name) => name.toLowerCase().includes(normalizedQuery));
}

export function getMentionOptionItems(availableAgents: string[], query: string): MentionOptionItem[] {
  return getMentionOptions(availableAgents, query).map((agentId) => ({
    agentId,
    displayName: agentId,
    mentionLabel: `@${agentId}`,
  }));
}
