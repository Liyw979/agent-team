export interface TaskAttachCommandEntry {
  agentName: string;
  opencodeAttachCommand: string | null;
}

export function collectNewTaskAttachCommandEntries(
  previousEntries: TaskAttachCommandEntry[],
  nextEntries: TaskAttachCommandEntry[],
): TaskAttachCommandEntry[] {
  const previousCommandByAgent = new Map(
    previousEntries.map((entry) => [entry.agentName, entry.opencodeAttachCommand]),
  );

  return nextEntries.filter((entry) => {
    if (!entry.opencodeAttachCommand) {
      return false;
    }
    return previousCommandByAgent.get(entry.agentName) !== entry.opencodeAttachCommand;
  });
}

export function renderTaskAttachCommands(entries: TaskAttachCommandEntry[]): string {
  const visibleEntries = entries.filter((entry) => Boolean(entry.opencodeAttachCommand));
  if (visibleEntries.length === 0) {
    return "";
  }

  let output = "attach:\n";
  for (const entry of visibleEntries) {
    output += `- ${entry.agentName} | ${entry.opencodeAttachCommand}\n`;
  }
  output += "\n";
  return output;
}
