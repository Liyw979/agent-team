export function toOpenCodeAgentName(agentName: string): string {
  if (agentName.trim().toLowerCase() === "build") {
    return "build";
  }
  return agentName;
}
