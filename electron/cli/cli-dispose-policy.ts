import type { ParsedCliCommand } from "./cli-command";

interface ResolveCliDisposeOptionsInput {
  commandKind: ParsedCliCommand["kind"];
  observedSettledTaskState: boolean;
}

interface CliDisposeOptions {
  awaitPendingTaskRuns: boolean;
  forceProcessExit: boolean;
}

export function resolveCliDisposeOptions(
  input: ResolveCliDisposeOptionsInput,
): CliDisposeOptions {
  if (!input.observedSettledTaskState) {
    return {
      awaitPendingTaskRuns: true,
      forceProcessExit: false,
    };
  }

  if (input.commandKind === "task.run" || input.commandKind === "task.show") {
    return {
      awaitPendingTaskRuns: false,
      forceProcessExit: true,
    };
  }

  return {
    awaitPendingTaskRuns: true,
    forceProcessExit: false,
  };
}
