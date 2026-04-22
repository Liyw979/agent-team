import path from "node:path";

type WindowsEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

function readWindowsEnv(env: WindowsEnv, key: string): string | null {
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

  return null;
}

export function resolveWindowsCmdPath(env: WindowsEnv = process.env): string {
  const comSpec = readWindowsEnv(env, "ComSpec");
  if (comSpec) {
    return comSpec;
  }

  const systemRoot = readWindowsEnv(env, "SystemRoot") ?? readWindowsEnv(env, "WINDIR");
  if (systemRoot) {
    return path.win32.join(systemRoot, "System32", "cmd.exe");
  }

  return "cmd.exe";
}

export function quoteWindowsShellValue(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
