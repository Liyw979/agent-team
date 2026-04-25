interface AgentPanelColorToken {
  background: string;
  border: string;
}

const AGENT_PANEL_COLOR_TOKENS: Record<string, AgentPanelColorToken> = {
  BA: {
    background: "#F4EED4",
    border: "#B8A64B",
  },
  Build: {
    background: "#DDD7EE",
    border: "#B7AFE8",
  },
  CodeReview: {
    background: "#F4E0D4",
    border: "#E4B18F",
  },
  UnitTest: {
    background: "#DCDDFA",
    border: "#AEB7F2",
  },
  TaskReview: {
    background: "#F4E0D4",
    border: "#E4B18F",
  },
};

const FALLBACK_AGENT_PANEL_COLOR_TOKENS: AgentPanelColorToken[] = [
  {
    background: "#F4EED4",
    border: "#B8A64B",
  },
  {
    background: "#DDD7EE",
    border: "#B7AFE8",
  },
  {
    background: "#F4E0D4",
    border: "#E4B18F",
  },
];

function buildFallbackAgentKey(agentId: string) {
  return agentId.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hashAgentId(agentId: string) {
  return [...buildFallbackAgentKey(agentId)].reduce((acc, char) => acc + char.charCodeAt(0), 0);
}

export function getAgentPanelColorToken(agentId: string): AgentPanelColorToken {
  const matched = AGENT_PANEL_COLOR_TOKENS[agentId.trim()];
  if (matched) {
    return matched;
  }

  return FALLBACK_AGENT_PANEL_COLOR_TOKENS[
    hashAgentId(agentId) % FALLBACK_AGENT_PANEL_COLOR_TOKENS.length
  ]!;
}
