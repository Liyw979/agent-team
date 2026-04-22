interface TaskSessionSummaryInput {
  logFilePath: string;
  taskUrl?: string | null;
}

export function renderTaskSessionSummary(input: TaskSessionSummaryInput): string {
  return [
    `日志: ${input.logFilePath}`,
    input.taskUrl ? `url: ${input.taskUrl}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
