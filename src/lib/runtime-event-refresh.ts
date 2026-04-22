import type { RuntimeUpdatedEventPayload } from "@shared/types";

export function shouldRefreshForRuntimeEvent(input: {
  currentTaskId: string | null | undefined;
  payload: RuntimeUpdatedEventPayload;
}): boolean {
  const currentTaskId = input.currentTaskId?.trim() ?? "";
  if (!currentTaskId) {
    return false;
  }
  return input.payload.taskId === currentTaskId;
}
