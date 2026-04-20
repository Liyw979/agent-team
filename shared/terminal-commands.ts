export function quotePortableShellArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function buildCliAttachAgentCommand(taskId: string, agentName: string): string {
  return `bun run cli -- task attach ${quotePortableShellArg(taskId)} ${quotePortableShellArg(agentName)}`;
}

export function buildCliOpencodeAttachCommand(
  attachBaseUrl: string,
  sessionId: string,
  cwd: string,
): string {
  return [
    "opencode",
    "attach",
    quotePortableShellArg(attachBaseUrl),
    "--session",
    quotePortableShellArg(sessionId),
    "--dir",
    quotePortableShellArg(cwd),
  ].join(" ");
}
