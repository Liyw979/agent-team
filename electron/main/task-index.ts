export interface TaskLocatorEntry {
  taskId: string;
  cwd: string;
}

export function findTaskLocatorCwd(
  entries: readonly TaskLocatorEntry[],
  taskId: string,
): string | null {
  return entries.find((entry) => entry.taskId === taskId)?.cwd ?? null;
}

export function upsertTaskLocatorEntry(
  entries: readonly TaskLocatorEntry[],
  nextEntry: TaskLocatorEntry,
): TaskLocatorEntry[] {
  return [
    ...entries.filter((entry) => entry.taskId !== nextEntry.taskId),
    nextEntry,
  ];
}

export function removeTaskLocatorEntry(
  entries: readonly TaskLocatorEntry[],
  taskId: string,
): TaskLocatorEntry[] {
  return entries.filter((entry) => entry.taskId !== taskId);
}
