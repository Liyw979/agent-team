export function buildUiUrl(input: {
  port: number;
  taskId: string;
}): string {
  const query = new URLSearchParams({
    taskId: input.taskId,
  });
  return `http://127.0.0.1:${input.port}/?${query.toString()}`;
}

export function buildBrowserOpenSpec(input: {
  url: string;
  platform?: NodeJS.Platform;
}): { command: string; args: string[] } {
  const platform = input.platform ?? process.platform;
  if (platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "start", "", `"${input.url}"`],
    };
  }
  if (platform === "darwin") {
    return {
      command: "open",
      args: [input.url],
    };
  }
  return {
    command: "xdg-open",
    args: [input.url],
  };
}
