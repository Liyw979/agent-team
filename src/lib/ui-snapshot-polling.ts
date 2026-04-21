export function getUiSnapshotPollingIntervalMs(taskId: string): number | null {
  return taskId.trim() ? 1000 : null;
}
