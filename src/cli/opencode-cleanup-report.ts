interface OpenCodeCleanupReportInput {
  killedPids: number[];
}

export function renderOpenCodeCleanupReport(input: OpenCodeCleanupReportInput): string {
  const uniquePids = [...new Set(input.killedPids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (uniquePids.length === 0) {
    return "";
  }
  return `已清理 OpenCode 实例 PID: ${uniquePids.join(", ")}\n`;
}
