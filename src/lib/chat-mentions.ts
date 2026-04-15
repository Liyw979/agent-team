export function getMentionOptions(availableAgents: string[], query: string): string[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [...availableAgents];
  }

  return availableAgents.filter((name) => name.toLowerCase().includes(normalizedQuery));
}
