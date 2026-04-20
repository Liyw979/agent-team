import type { ParsedCliCommand } from "./cli-command";

interface ResolveCliTaskStreamingPlanInput {
  commandKind: Extract<ParsedCliCommand, { kind: "task.headless" | "task.ui" }>["kind"];
  isResume: boolean;
}

interface CliTaskStreamingPlan {
  enabled: boolean;
  includeHistory: boolean;
  printAttach: boolean;
}

export function resolveCliTaskStreamingPlan(
  input: ResolveCliTaskStreamingPlanInput,
): CliTaskStreamingPlan {
  if (input.commandKind === "task.headless") {
    return {
      enabled: true,
      includeHistory: true,
      printAttach: true,
    };
  }

  if (input.isResume) {
    return {
      enabled: true,
      includeHistory: false,
      printAttach: false,
    };
  }

  return {
    enabled: true,
    includeHistory: true,
    printAttach: true,
  };
}
