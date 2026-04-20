import path from "node:path";

export interface BuildCliAttachAgentCommandOptions {
  mode?: "source" | "compiled";
  executablePath?: string;
  platform?: NodeJS.Platform;
}

export interface BuildCliOpencodeAttachCommandOptions {
  platform?: NodeJS.Platform;
}

export function quotePortableShellArg(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveCompiledExecutableName(executablePath: string, platform: NodeJS.Platform) {
  return platform === "win32"
    ? path.win32.basename(executablePath)
    : path.posix.basename(executablePath);
}

export function buildCliAttachAgentCommand(
  taskId: string,
  agentName: string,
  options?: BuildCliAttachAgentCommandOptions,
): string {
  const platform = options?.platform ?? process.platform;
  const commandPrefix =
    options?.mode === "compiled" && options.executablePath
      ? resolveCompiledExecutableName(options.executablePath, platform)
      : "bun run cli --";
  return [
    commandPrefix,
    "task attach",
    quotePortableShellArg(taskId, platform),
    quotePortableShellArg(agentName, platform),
  ].join(" ");
}

export function buildCliOpencodeAttachCommand(
  attachBaseUrl: string,
  sessionId: string,
  cwd: string,
  options?: BuildCliOpencodeAttachCommandOptions,
): string {
  const platform = options?.platform ?? process.platform;
  return [
    "opencode",
    "attach",
    quotePortableShellArg(attachBaseUrl, platform),
    "--session",
    quotePortableShellArg(sessionId, platform),
    "--dir",
    quotePortableShellArg(cwd, platform),
  ].join(" ");
}
