import fs from "node:fs";
import path from "node:path";

interface ResolveValidatedWorkspaceCwdInput {
  requestedCwd?: string;
  currentCwd: string;
  exists: boolean;
  isDirectory: boolean;
}

export function resolveValidatedWorkspaceCwd(input: ResolveValidatedWorkspaceCwdInput): string {
  const resolvedCwd = path.resolve(input.currentCwd, input.requestedCwd ?? ".");
  if (!input.exists) {
    throw new Error(`工作目录不存在：${resolvedCwd}`);
  }
  if (!input.isDirectory) {
    throw new Error(`工作目录必须是目录：${resolvedCwd}`);
  }
  return resolvedCwd;
}

export function resolveWorkspaceCwdFromFilesystem(requestedCwd: string | undefined, currentCwd: string): string {
  const resolvedCwd = path.resolve(requestedCwd ?? currentCwd);
  let stats: fs.Stats | null = null;

  try {
    stats = fs.statSync(resolvedCwd);
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? error.code : null;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  return resolveValidatedWorkspaceCwd({
    requestedCwd,
    currentCwd,
    exists: stats !== null,
    isDirectory: stats?.isDirectory() ?? false,
  });
}
