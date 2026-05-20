import { appendAppLog } from "../runtime/app-log";

interface CliRunFailureInput {
  context: CliRunFailureContext;
  message: string;
  cwd: string;
  didPrintDiagnostics: boolean;
  printDiagnostics: (logFilePath: string) => void;
}

export type CliRunFailureContext =
  | {
      kind: "without-task";
    }
  | {
      kind: "task";
      logFilePath: string;
    };

export function reportCliRunFailure(input: CliRunFailureInput): boolean {
  if (input.context.kind === "task") {
    appendAppLog("error", "cli.run_failed", {
      cwd: input.cwd,
      message: input.message,
    });
  }

  if (!input.didPrintDiagnostics && input.context.kind === "task") {
    input.printDiagnostics(input.context.logFilePath);
    return true;
  }

  return input.didPrintDiagnostics;
}
