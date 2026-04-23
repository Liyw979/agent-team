export interface TaskAttachCommandEntry {
  agentId: string;
  opencodeAttachCommand: string | null;
}

export function collectNewTaskAttachCommandEntries(
  previousEntries: TaskAttachCommandEntry[],
  nextEntries: TaskAttachCommandEntry[],
): TaskAttachCommandEntry[] {
  const previousCommandByAgent = new Map(
    previousEntries.map((entry) => [entry.agentId, entry.opencodeAttachCommand]),
  );

  return nextEntries.filter((entry) => {
    if (!entry.opencodeAttachCommand) {
      return false;
    }
    return previousCommandByAgent.get(entry.agentId) !== entry.opencodeAttachCommand;
  });
}

export function renderTaskAttachCommands(entries: TaskAttachCommandEntry[]): string {
  const visibleEntries = entries.filter((entry) => Boolean(entry.opencodeAttachCommand));
  if (visibleEntries.length === 0) {
    return "";
  }

  let output = "attach:\n";
  for (const entry of visibleEntries) {
    output += `- ${entry.agentId} | ${entry.opencodeAttachCommand}\n`;
  }
  output += "\n";
  return output;
}
