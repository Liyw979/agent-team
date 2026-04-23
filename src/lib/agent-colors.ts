interface AgentColorToken {
  solid: string;
  soft: string;
  border: string;
  text: string;
  mutedText: string;
  badgeText: string;
}

const AGENT_COLOR_TOKENS: AgentColorToken[] = [
  {
    solid: "#2F6F5E",
    soft: "#E4F2EC",
    border: "#9BC8B8",
    text: "#173328",
    mutedText: "#48685D",
    badgeText: "#F7FBF9",
  },
  {
    solid: "#A7562A",
    soft: "#F9E8DD",
    border: "#E5B393",
    text: "#4F2410",
    mutedText: "#84523A",
    badgeText: "#FFF8F3",
  },
  {
    solid: "#3E6794",
    soft: "#E6EEF8",
    border: "#A8C0E0",
    text: "#19314E",
    mutedText: "#4D6887",
    badgeText: "#F5F9FF",
  },
  {
    solid: "#8C5E9E",
    soft: "#F2E9F6",
    border: "#D2B6DE",
    text: "#432851",
    mutedText: "#715B7E",
    badgeText: "#FCF8FF",
  },
  {
    solid: "#A06C23",
    soft: "#F7ECD7",
    border: "#DEC18E",
    text: "#4B3310",
    mutedText: "#7D6540",
    badgeText: "#FFFBEF",
  },
  {
    solid: "#A0455E",
    soft: "#F9E4EA",
    border: "#E0A7B6",
    text: "#4C1E2A",
    mutedText: "#815562",
    badgeText: "#FFF8FA",
  },
  {
    solid: "#576A2A",
    soft: "#EDF2DD",
    border: "#BDCC97",
    text: "#2D3814",
    mutedText: "#617042",
    badgeText: "#FAFDED",
  },
  {
    solid: "#2C7A7B",
    soft: "#DFF3F1",
    border: "#97D0CB",
    text: "#153B3A",
    mutedText: "#4A7270",
    badgeText: "#F4FEFC",
  },
  {
    solid: "#B15C2D",
    soft: "#F8E7DC",
    border: "#E1B496",
    text: "#512711",
    mutedText: "#87553C",
    badgeText: "#FFF8F4",
  },
  {
    solid: "#496C9B",
    soft: "#E7EEF8",
    border: "#AEC0DE",
    text: "#203555",
    mutedText: "#5A7292",
    badgeText: "#F6FAFF",
  },
  {
    solid: "#7D8F31",
    soft: "#EFF3DE",
    border: "#C5D396",
    text: "#394414",
    mutedText: "#667247",
    badgeText: "#FBFDEC",
  },
  {
    solid: "#9B4D7A",
    soft: "#F6E5EE",
    border: "#D9A9C1",
    text: "#4A2037",
    mutedText: "#7A586A",
    badgeText: "#FFF8FC",
  },
  {
    solid: "#356E88",
    soft: "#E1F0F5",
    border: "#9FC4D1",
    text: "#163848",
    mutedText: "#4E6E7A",
    badgeText: "#F5FCFF",
  },
  {
    solid: "#A36A4A",
    soft: "#F6E8E0",
    border: "#D8B49F",
    text: "#4E2A18",
    mutedText: "#7C5E50",
    badgeText: "#FFF9F6",
  },
  {
    solid: "#5A5FA8",
    soft: "#E8E9FA",
    border: "#B5B8E7",
    text: "#25285A",
    mutedText: "#62668E",
    badgeText: "#F8F8FF",
  },
  {
    solid: "#8A7A29",
    soft: "#F5F0DA",
    border: "#D9CD95",
    text: "#433C12",
    mutedText: "#736946",
    badgeText: "#FFFDF1",
  },
  {
    solid: "#2E8A6B",
    soft: "#E0F4EC",
    border: "#97D1BC",
    text: "#143E31",
    mutedText: "#4D7568",
    badgeText: "#F5FFFB",
  },
  {
    solid: "#A14F3F",
    soft: "#F7E4DF",
    border: "#DEACA3",
    text: "#4C221B",
    mutedText: "#7F5A54",
    badgeText: "#FFF8F6",
  },
  {
    solid: "#6B5A99",
    soft: "#ECE7F7",
    border: "#BDAFDD",
    text: "#30284A",
    mutedText: "#665F7B",
    badgeText: "#FBF9FF",
  },
  {
    solid: "#3B7F52",
    soft: "#E4F1E7",
    border: "#A6CBAD",
    text: "#1B3C24",
    mutedText: "#53715B",
    badgeText: "#F7FCF8",
  },
];

function hashAgentId(name: string) {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

export function getAgentColorToken(agentId: string): AgentColorToken {
  const normalized = agentId.trim().toLowerCase();
  const index = hashAgentId(normalized) % AGENT_COLOR_TOKENS.length;
  const token = AGENT_COLOR_TOKENS[index] ?? AGENT_COLOR_TOKENS[0];
  if (!token) {
    throw new Error("Agent color tokens must contain at least one entry.");
  }
  return token;
}
