export function quotePortableShellArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function buildCliAttachAgentCommand(agentName: string, cwd?: string): string {
  const cwdSegment = cwd ? ` --cwd ${quotePortableShellArg(cwd)}` : "";
  return `bun run cli -- task attach ${quotePortableShellArg(agentName)}${cwdSegment}`;
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
