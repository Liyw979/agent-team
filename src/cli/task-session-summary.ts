type TaskSessionSummaryInput =
  | {
      kind: "log-only";
      logFilePath: string;
    }
  | {
      kind: "with-url";
      logFilePath: string;
      taskUrl: string;
    };

export function renderTaskSessionSummary(input: TaskSessionSummaryInput): string {
  const lines = [
    "",
    `日志：${input.logFilePath}`,
  ];
  if (input.kind === "with-url") {
    lines.push(`网页：${input.taskUrl}`);
  }
  return lines.join("\n");
}
