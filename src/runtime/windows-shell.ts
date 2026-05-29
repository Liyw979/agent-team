import path from "node:path";

type WindowsEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

// 2026-05-29: 用户要求系统适配边界直接判定变量是否存在，不再向外暴露可空环境变量语义。
function readWindowsEnv(env: WindowsEnv, key: string): string {
  const direct = env[key];
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  const lowered = key.toLowerCase();
  for (const [entryKey, value] of Object.entries(env)) {
    if (entryKey.toLowerCase() !== lowered) {
      continue;
    }
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

export function resolveWindowsCmdPath(env: WindowsEnv = process.env): string {
  const comSpec = readWindowsEnv(env, "ComSpec");
  if (comSpec) {
    return comSpec;
  }

  const systemRoot = readWindowsEnv(env, "SystemRoot") || readWindowsEnv(env, "WINDIR");
  if (systemRoot) {
    return path.win32.join(systemRoot, "System32", "cmd.exe");
  }

  return "cmd.exe";
}

export function quoteWindowsShellValue(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
