interface TaskSessionSummaryInput {
  logFilePath: string;
  taskUrl?: string | null;
}

export function renderTaskSessionSummary(input: TaskSessionSummaryInput): string {
  const lines = [
    "",
    `日志：${input.logFilePath}`,
  ];
  if (input.taskUrl) {
    lines.push(`网页：${input.taskUrl}`);
  }
  return lines.join("\n");
}
