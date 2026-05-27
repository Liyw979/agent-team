import path from "node:path";

interface ResolveLaunchContextInput {
  argv: string[];
  defaultCwd: string;
}

interface LaunchContext {
  // This only records where the UI launch was requested from; runtime routing stays inside Orchestrator.cwd.
  launchCwd: string;
}

export function resolveLaunchContext(input: ResolveLaunchContextInput): LaunchContext {
  // 2026-05-27: 用户要求仅保留显式 CLI 启动目录与默认目录，不保留环境变量兼容入口，避免死状态回归。
  const launchArgumentIndex = input.argv.findIndex((value) => value === "--agent-team-cwd");
  const launchArgumentValue = launchArgumentIndex < 0
    ? ""
    : input.argv[launchArgumentIndex + 1];
  const launchCwdRaw = (typeof launchArgumentValue === "string" ? launchArgumentValue.trim() : "") || input.defaultCwd;

  return {
    launchCwd: path.resolve(launchCwdRaw),
  };
}
