interface AgentPanelColorToken {
  background: string;
  border: string;
}

const AGENT_PANEL_COLOR_TOKENS: Record<string, AgentPanelColorToken> = {
  ba: {
    background: "#F4EED4",
    border: "#B8A64B",
  },
  build: {
    background: "#DDD7EE",
    border: "#B7AFE8",
  },
  codereview: {
    background: "#F4E0D4",
    border: "#E4B18F",
  },
  unittest: {
    background: "#DCDDFA",
    border: "#AEB7F2",
  },
  taskreview: {
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

function normalizeAgentId(agentId: string) {
  return agentId.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hashAgentId(agentId: string) {
  return [...normalizeAgentId(agentId)].reduce((acc, char) => acc + char.charCodeAt(0), 0);
}

export function getAgentPanelColorToken(agentId: string): AgentPanelColorToken {
  const normalized = normalizeAgentId(agentId);
  const matched = AGENT_PANEL_COLOR_TOKENS[normalized];
  if (matched) {
    return matched;
  }

  return FALLBACK_AGENT_PANEL_COLOR_TOKENS[
    hashAgentId(agentId) % FALLBACK_AGENT_PANEL_COLOR_TOKENS.length
  ]!;
}
