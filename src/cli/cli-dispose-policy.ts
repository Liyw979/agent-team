import type { ParsedCliCommand } from "./cli-command";

interface ResolveCliDisposeOptionsInput {
  commandKind: ParsedCliCommand["kind"];
  observedSettledTaskState: boolean;
}

interface CliDisposeOptions {
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

  if (input.commandKind === "task.headless") {
    return {
      awaitPendingTaskRuns: false,
      forceProcessExit: true,
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
