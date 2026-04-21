import { spawn } from "node:child_process";
import { resolveWindowsCmdPath } from "./windows-shell";

interface TerminalLaunchInput {
  cwd: string;
  command: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

interface TerminalLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
}

type WindowsTerminalLauncher = "cmd" | "powershell";

function quoteAppleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function readWindowsTerminalLauncher(
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
): WindowsTerminalLauncher {
  const raw = env?.AGENT_TEAM_WINDOWS_TERMINAL?.trim().toLowerCase();
  return raw === "powershell" ? "powershell" : "cmd";
}

function buildWindowsStartArgs(input: {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): string[] {
  const cmdPath = resolveWindowsCmdPath(input.env);
  return [
    "/d",
    "/c",
    "start",
    "",
    "/d",
    input.cwd,
    cmdPath,
    "/d",
    "/s",
    "/k",
    input.command,
  ];
}

function buildWindowsPowerShellStartArgs(input: {
  command: string;
  cwd: string;
}): string[] {
  return [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    [
      "Start-Process",
      "-WorkingDirectory",
      quotePowerShellString(input.cwd),
      "-FilePath",
      quotePowerShellString("powershell.exe"),
      "-ArgumentList",
      `@('-NoExit', '-Command', ${quotePowerShellString(input.command)})`,
    ].join(" "),
  ];
}

export function buildTerminalLaunchSpec(input: TerminalLaunchInput): TerminalLaunchSpec {
  const platform = input.platform ?? process.platform;

  if (platform === "win32") {
    const launcher = readWindowsTerminalLauncher(input.env);
    if (launcher === "powershell") {
      return {
        command: "powershell.exe",
        args: buildWindowsPowerShellStartArgs({
          command: input.command,
          cwd: input.cwd,
        }),
        cwd: input.cwd,
      };
    }

    const cmdPath = resolveWindowsCmdPath(input.env);
    return {
      command: cmdPath,
      args: buildWindowsStartArgs({
        command: input.command,
        cwd: input.cwd,
        env: input.env,
      }),
      cwd: input.cwd,
    };
  }

  if (platform === "darwin") {
    return {
      command: "osascript",
      args: [
        "-e",
        'if application "Terminal" is running then',
        "-e",
        `tell application "Terminal" to do script ${quoteAppleScriptString(input.command)}`,
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
        `set attachTab to do script ${quoteAppleScriptString(input.command)} in window 1`,
        "-e",
        "set selected tab of window 1 to attachTab",
        "-e",
        "end tell",
        "-e",
        "end if",
        "-e",
        'tell application "Terminal" to activate',
      ],
      cwd: input.cwd,
    };
  }

  return {
    command: "x-terminal-emulator",
    args: ["-e", "/bin/sh", "-lc", input.command],
    cwd: input.cwd,
  };
}

export async function launchTerminalCommand(input: TerminalLaunchInput): Promise<void> {
  const spec = buildTerminalLaunchSpec(input);
  const platform = input.platform ?? process.platform;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      detached: true,
      stdio: platform === "win32" ? "inherit" : "ignore",
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
