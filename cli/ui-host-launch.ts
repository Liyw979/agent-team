import path from "node:path";

export interface UiHostLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
}

interface SourceUiHostLaunchInput {
  mode: "source";
  nodeBinary: string;
  repoRoot: string;
  cwd: string;
  taskId: string;
  port: number;
}

interface CompiledUiHostLaunchInput {
  mode: "compiled";
  executablePath: string;
  cwd: string;
  taskId: string;
  port: number;
}

export type BuildUiHostLaunchSpecInput =
  | SourceUiHostLaunchInput
  | CompiledUiHostLaunchInput;

export function buildUiHostLaunchSpec(
  input: BuildUiHostLaunchSpecInput,
): UiHostLaunchSpec {
  const hostArgs = [
    "internal",
    "web-host",
    "--cwd",
    input.cwd,
    "--task-id",
    input.taskId,
    "--port",
    String(input.port),
  ];

  if (input.mode === "compiled") {
    return {
      command: input.executablePath,
      args: hostArgs,
      cwd: path.dirname(input.executablePath),
    };
  }

  return {
    command: input.nodeBinary,
    args: [
      "--require",
      path.join(input.repoRoot, "node_modules/tsx/dist/preflight.cjs"),
      "--import",
      `file://${path.join(input.repoRoot, "node_modules/tsx/dist/loader.mjs")}`,
      path.join(input.repoRoot, "cli/index.ts"),
      ...hostArgs,
    ],
    cwd: input.repoRoot,
  };
}

export function buildUiUrl(input: {
  port: number;
  cwd: string;
  taskId: string;
}): string {
  const query = new URLSearchParams({
    cwd: input.cwd,
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
