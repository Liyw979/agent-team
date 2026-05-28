function quotePortableShellArg(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    if (/^[A-Za-z0-9_./:\\-]+$/.test(value)) {
      return value;
    }
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildCliAttachCommand(
  commandName: string,
  attachBaseUrl: string,
  sessionId: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return [
    commandName,
    "attach",
    quotePortableShellArg(attachBaseUrl, platform),
    "--session",
    quotePortableShellArg(sessionId, platform),
  ].join(" ");
}
