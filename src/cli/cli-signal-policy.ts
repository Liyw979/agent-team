import type { ParsedCliCommand } from "./cli-command";

interface ResolveCliSignalPlanInput {
  commandKind: ParsedCliCommand["kind"];
  signal: NodeJS.Signals;
}

interface CliSignalPlan {
  shouldCleanupOpencode: boolean;
  awaitPendingTaskRuns: boolean;
  exitCode: number;
}

export function resolveCliSignalPlan(
  input: ResolveCliSignalPlanInput,
): CliSignalPlan {
  const exitCode = resolveSignalExitCode(input.signal);
  return {
    shouldCleanupOpencode: true,
    awaitPendingTaskRuns: false,
    exitCode,
  };
}

function resolveSignalExitCode(signal: NodeJS.Signals): number {
  if (signal === "SIGINT") {
    return 130;
  }
  if (signal === "SIGTERM") {
    return 143;
  }
  return 1;
}
