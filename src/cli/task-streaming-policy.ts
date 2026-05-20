interface ResolveCliTaskStreamingPlanInput {
  showMessage: boolean;
  isResume: boolean;
}

interface CliTaskStreamingPlan {
  enabled: boolean;
  includeHistory: boolean;
  printAttach: boolean;
  printMessages: boolean;
}

export function resolveCliTaskStreamingPlan(
  input: ResolveCliTaskStreamingPlanInput,
): CliTaskStreamingPlan {
  if (!input.isResume) {
    return {
      enabled: true,
      includeHistory: input.showMessage,
      printAttach: true,
      printMessages: input.showMessage,
    };
  }

  return {
    enabled: true,
    includeHistory: false,
    printAttach: false,
    printMessages: input.showMessage,
  };
}
