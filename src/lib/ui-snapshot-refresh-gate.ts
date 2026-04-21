import type { UiSnapshotPayload } from "@shared/types";

export interface UiSnapshotRefreshAcceptanceInput {
  latestAcceptedRequestId: number;
  requestId: number;
  payload: UiSnapshotPayload;
}

export interface UiSnapshotRefreshAcceptance {
  accepted: boolean;
  latestAcceptedRequestId: number;
  payload: UiSnapshotPayload | null;
}

export function decideUiSnapshotRefreshAcceptance(
  input: UiSnapshotRefreshAcceptanceInput,
): UiSnapshotRefreshAcceptance {
  if (input.requestId <= input.latestAcceptedRequestId) {
    return {
      accepted: false,
      latestAcceptedRequestId: input.latestAcceptedRequestId,
      payload: null,
    };
  }

  return {
    accepted: true,
    latestAcceptedRequestId: input.requestId,
    payload: input.payload,
  };
}
