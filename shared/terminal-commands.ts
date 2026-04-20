export type TerminalPlatform = NodeJS.Platform;

interface CliAttachCommandOptions {
  command?: string;
  platform?: TerminalPlatform;
}

interface InlineCommandOptions {
  command: string;
  args: string[];
  platform?: TerminalPlatform;
}

interface OpencodePaneCommandOptions {
  cwd: string;
  runtimeDir: string;
  dbPath: string;
  agentName: string;
  opencodeSessionId: string | null;
  opencodeAgentName: string;
  attachBaseUrl: string;
  platform?: TerminalPlatform;
}

interface ShellLaunchSpec {
  command: string;
  args: string[];
}

interface WindowsPaneLaunchArtifacts {
  shellCommand: string;
  shellLaunch: ShellLaunchSpec;
  launcherPath: string | null;
  launcherContent: string | null;
}

function buildWindowsOpencodeCommand(options: OpencodePaneCommandOptions): string {
  if (options.opencodeSessionId) {
    return [
      "opencode",
      "attach",
      quoteWindowsArg(options.attachBaseUrl),
      "--session",
      quoteWindowsArg(options.opencodeSessionId),
      "--dir",
      quoteWindowsArg(options.cwd),
    ].join(" ");
  }

  return [
    "opencode",
    ".",
    "--agent",
    quoteWindowsArg(options.opencodeAgentName),
  ].join(" ");
}

function quotePosixArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteWindowsArg(value: string): string {
  const escaped = value
    .replace(/(\\*)"/g, "$1$1\\\"")
    .replace(/(\\+)$/g, "$1$1");
  return `"${escaped}"`;
}

function quotePortableArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function escapeWindowsEnvValue(value: string): string {
  return value.replace(/%/g, "%%");
}

function normalizeWindowsEnvPath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function quoteInlineCommandArg(
  value: string,
  platform: TerminalPlatform = process.platform,
): string {
  return platform === "win32" ? quoteWindowsArg(value) : quotePosixArg(value);
}

export function quotePortableShellArg(value: string): string {
  return quotePortableArg(value);
}

export function buildInlineCommand(
  options: InlineCommandOptions,
): string {
  return [options.command, ...options.args]
    .map((part) => quoteInlineCommandArg(part, options.platform))
    .join(" ");
}

export function buildShellLaunchSpec(
  inlineCommand: string,
  platform: TerminalPlatform = process.platform,
): ShellLaunchSpec {
  if (platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", inlineCommand],
    };
  }

  return {
    command: "/bin/sh",
    args: ["-c", inlineCommand],
  };
}

export function buildCliPanelFocusCommand(
  taskId: string,
  agentName: string,
): string {
  return `npm run cli -- panel focus ${quotePortableShellArg(taskId)} ${quotePortableShellArg(agentName)}`;
}

export function buildCliTaskShowCommand(
  taskId: string,
): string {
  return `npm run cli -- task show ${quotePortableShellArg(taskId)}`;
}

export function buildCliAttachAgentCommand(
  agentName: string,
): string {
  return `npm run cli -- task attach ${quotePortableShellArg(agentName)}`;
}

export function buildCliAttachSessionCommand(
  sessionName: string,
  options: CliAttachCommandOptions = {},
): string {
  const command = options.command ?? "zellij";
  const renderedCommand = /[\s"]/.test(command) ? quotePortableShellArg(command) : command;
  return `${renderedCommand} attach ${quotePortableShellArg(sessionName)} --create`;
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

export function buildWindowsPaneLaunchArtifacts(
  inlineCommand: string,
): WindowsPaneLaunchArtifacts {
  return {
    shellCommand: inlineCommand,
    shellLaunch: {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", inlineCommand],
    },
    launcherPath: null,
    launcherContent: null,
  };
}

export function buildOpencodePaneCommand(
  options: OpencodePaneCommandOptions,
): {
  shellCommand: string;
  shellLaunch: ShellLaunchSpec;
} {
  const platform = options.platform ?? process.platform;

  if (platform === "win32") {
    const runtimeDirForEnv = normalizeWindowsEnvPath(options.runtimeDir);
    const dbPathForEnv = normalizeWindowsEnvPath(options.dbPath);
    const opencodeCommand = options.opencodeSessionId
      ? buildInlineCommand({
          command: "opencode",
          args: [
            "attach",
            options.attachBaseUrl,
            "--session",
            options.opencodeSessionId,
            "--dir",
            options.cwd,
          ],
          platform,
        })
      : buildInlineCommand({
          command: "opencode",
          args: [".", "--agent", options.opencodeAgentName],
          platform,
        });

    const shellCommand = [
      `if not exist ${quoteWindowsArg(options.runtimeDir)} mkdir ${quoteWindowsArg(options.runtimeDir)}`,
      `cd /d ${quoteWindowsArg(options.cwd)}`,
      // OpenCode's Windows TUI attach path works reliably with POSIX-style paths.
      `set "OPENCODE_CONFIG_DIR=${escapeWindowsEnvValue(runtimeDirForEnv)}"`,
      `set "OPENCODE_DB=${escapeWindowsEnvValue(dbPathForEnv)}"`,
      `set "OPENCODE_DISABLE_PROJECT_CONFIG=true"`,
      `set "OPENCODE_CLIENT=agentflow-zellij"`,
      opencodeCommand,
    ].join(" && ");

    const launchArtifacts = buildWindowsPaneLaunchArtifacts(shellCommand);
    return {
      shellCommand: launchArtifacts.shellCommand,
      shellLaunch: launchArtifacts.shellLaunch,
    };
  }

  const opencodeCommand = options.opencodeSessionId
    ? [
        "exec opencode attach",
        quotePosixArg(options.attachBaseUrl),
        "--session",
        quotePosixArg(options.opencodeSessionId),
        "--dir",
        quotePosixArg(options.cwd),
      ].join(" ")
    : [
        "exec opencode .",
        "--agent",
        quotePosixArg(options.opencodeAgentName),
      ].join(" ");

  const shellCommand = [
    `mkdir -p ${quotePosixArg(options.runtimeDir)}`,
    "&&",
    `cd ${quotePosixArg(options.cwd)}`,
    "&&",
    `export OPENCODE_CONFIG_DIR=${quotePosixArg(options.runtimeDir)}`,
    `OPENCODE_DB=${quotePosixArg(options.dbPath)}`,
    "OPENCODE_DISABLE_PROJECT_CONFIG='true'",
    "OPENCODE_CLIENT='agentflow-zellij'",
    "&&",
    opencodeCommand,
  ].join(" ");

  return {
    shellCommand,
    shellLaunch: buildShellLaunchSpec(shellCommand, platform),
  };
}
