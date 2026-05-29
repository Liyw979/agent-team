interface ResolveCliDisposeOptionsInput {
  observedSettledTaskState: boolean;
}

export interface CliDisposeOptions {
  awaitPendingTaskRuns: boolean;
  forceProcessExit: boolean;
  keepAliveUntilSignal: boolean;
  shouldDisposeContext: boolean;
}

export function resolveCliDisposeOptions(
  input: ResolveCliDisposeOptionsInput,
): CliDisposeOptions {
  if (!input.observedSettledTaskState) {
    return {
      awaitPendingTaskRuns: true,
      forceProcessExit: false,
      keepAliveUntilSignal: false,
      shouldDisposeContext: true,
    };
  }

  return {
    awaitPendingTaskRuns: true,
    forceProcessExit: false,
    keepAliveUntilSignal: true,
    shouldDisposeContext: false,
  };
}
