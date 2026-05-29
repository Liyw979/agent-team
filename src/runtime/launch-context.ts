import path from "node:path";

interface ResolveLaunchContextInput {
  argv: string[];
  defaultCwd: string;
}

export function resolveLaunchContext(input: ResolveLaunchContextInput): string {
  // 2026-05-27: 用户要求仅保留显式 CLI 启动目录与默认目录，不保留环境变量兼容入口，避免死状态回归。
  // 2026-05-29: 用户要求禁止只含一个字段的结构体，启动目录解析直接返回 string，避免 launchCwd 包装层回归。
  const launchArgumentIndex = input.argv.findIndex((value) => value === "--agent-team-cwd");
  const launchArgumentValue = launchArgumentIndex < 0
    ? ""
    : input.argv[launchArgumentIndex + 1];
  const launchCwdRaw = (typeof launchArgumentValue === "string" ? launchArgumentValue.trim() : "") || input.defaultCwd;

  return path.resolve(launchCwdRaw);
}
