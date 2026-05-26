import { spawn } from "node:child_process";
import { resolveWindowsCmdPath } from "./windows-shell";

interface NormalizedTerminalLaunchInput {
  command: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

interface TerminalLaunchSpec {
  command: string;
  args: string[];
}

type WindowsTerminalLauncher = "cmd" | "powershell";

function quoteAppleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function readWindowsTerminalLauncher(
  input: NormalizedTerminalLaunchInput,
): WindowsTerminalLauncher {
  const raw = input.env["AGENT_TEAM_WINDOWS_TERMINAL"]?.trim().toLowerCase();
  return raw === "powershell" ? "powershell" : "cmd";
}

function buildWindowsStartArgs(input: {
  command: string;
  env: NormalizedTerminalLaunchInput["env"];
}): string[] {
  const cmdPath = resolveWindowsCmdPath(input.env);
  return [
    "/d",
    "/c",
    "start",
    "",
    cmdPath,
    "/d",
    "/s",
    "/k",
    input.command,
  ];
}

function buildWindowsPowerShellStartArgs(input: {
  command: string;
}): string[] {
  return [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    [
      "Start-Process",
      "-FilePath",
      quotePowerShellString("powershell.exe"),
      "-ArgumentList",
      `@('-NoExit', '-Command', ${quotePowerShellString(input.command)})`,
    ].join(" "),
  ];
}

function normalizeTerminalLaunchInput(command: string): NormalizedTerminalLaunchInput {
  return {
    command,
    platform: process.platform,
    env: process.env,
  };
}

export function buildTerminalLaunchSpec(
  input: NormalizedTerminalLaunchInput,
): TerminalLaunchSpec {
  const normalized = input;

  if (normalized.platform === "win32") {
    const launcher = readWindowsTerminalLauncher(normalized);
    if (launcher === "powershell") {
      return {
        command: "powershell.exe",
        args: buildWindowsPowerShellStartArgs({
          command: normalized.command,
        }),
      };
    }

    const cmdPath = resolveWindowsCmdPath(normalized.env);
    return {
      command: cmdPath,
      args: buildWindowsStartArgs({
        command: normalized.command,
        env: normalized.env,
      }),
    };
  }

  if (normalized.platform === "darwin") {
    return {
      command: "osascript",
      args: [
        "-e",
        'if application "Terminal" is running then',
        "-e",
        `tell application "Terminal" to do script ${quoteAppleScriptString(normalized.command)}`,
        "-e",
        "else",
        "-e",
        'tell application "Terminal"',
        "-e",
        "activate",
        "-e",
        "repeat until (count of windows) > 0",
        "-e",
        "delay 0.05",
        "-e",
        "end repeat",
        "-e",
        `set attachTab to do script ${quoteAppleScriptString(normalized.command)} in window 1`,
        "-e",
        "set selected tab of window 1 to attachTab",
        "-e",
        "end tell",
        "-e",
        "end if",
        "-e",
        'tell application "Terminal" to activate',
      ],
    };
  }

    return {
      command: "x-terminal-emulator",
      args: ["-e", "/bin/sh", "-lc", normalized.command],
    };
}

export async function launchTerminalCommand(command: string): Promise<void> {
  const normalized = normalizeTerminalLaunchInput(command);
  const spec = buildTerminalLaunchSpec(normalized);
  const spawnOptions = {
    detached: true,
    stdio: normalized.platform === "win32" ? "inherit" : "ignore",
  } as const;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, spawnOptions);

    child.once("error", reject);
    child.once("group", () => {
      child.unref();
      resolve();
    });
  });
}
