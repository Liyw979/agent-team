export interface MentionContext {
  start: number;
  end: number;
  query: string;
}

export type MentionContextState =
  | {
      kind: "active";
      context: MentionContext;
    }
  | {
      kind: "inactive";
    };

interface MentionOptionItem {
  agentId: string;
  displayName: string;
  mentionLabel: string;
}

// 2026-05-29: 用户要求 mention 编辑态在入口一次判定完成，禁止继续向上游暴露 null 语义。
export function getMentionContext(value: string, caret: number): MentionContextState {
  const prefix = value.slice(0, caret);
  const match = prefix.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) {
    return { kind: "inactive" };
  }

  const start = prefix.lastIndexOf("@");
  if (start < 0) {
    return { kind: "inactive" };
  }

  return {
    kind: "active",
    context: {
      start,
      end: caret,
      query: match[1] ?? "",
    },
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
