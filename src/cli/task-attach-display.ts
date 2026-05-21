export type TaskAttachCommandEntry =
  | {
      kind: "attached";
      agentId: string;
      opencodeAttachCommand: string;
    }
  | {
      kind: "pending";
      agentId: string;
    };

export function collectNewTaskAttachCommandEntries(
  previousEntries: TaskAttachCommandEntry[],
  nextEntries: TaskAttachCommandEntry[],
): TaskAttachCommandEntry[] {
  const previousCommandByAgent = new Map<string, string>(
    previousEntries
      .filter((entry) => entry.kind === "attached")
      .map((entry) => [entry.agentId, entry.opencodeAttachCommand]),
  );

  return nextEntries.filter((entry) => entry.kind === "attached"
    && previousCommandByAgent.get(entry.agentId) !== entry.opencodeAttachCommand);
}

export function renderTaskAttachCommands(entries: TaskAttachCommandEntry[]): string {
  const visibleEntries = entries.filter((entry) => entry.kind === "attached");
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
