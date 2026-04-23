export function toOpenCodeAgentId(agentId: string): string {
  if (agentId.trim().toLowerCase() === "build") {
    return "build";
  }
  return agentId;
}
