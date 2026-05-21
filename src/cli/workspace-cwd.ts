import fs from "node:fs";
import path from "node:path";

interface ResolveValidatedWorkspaceCwdInput {
  requestedCwd: string;
  currentCwd: string;
  exists: boolean;
  isDirectory: boolean;
}

type WorkspacePathStats =
  | {
      kind: "found";
      stats: fs.Stats;
    }
  | {
      kind: "missing";
    };

type FsErrorCode =
  | {
      kind: "fs-code";
      code: string;
    }
  | {
      kind: "unknown-error";
    };

function resolveValidatedWorkspaceCwd(input: ResolveValidatedWorkspaceCwdInput): string {
  const resolvedCwd = path.resolve(input.currentCwd, input.requestedCwd);
  if (!input.exists) {
    throw new Error(`工作目录不存在：${resolvedCwd}`);
  }
  if (!input.isDirectory) {
    throw new Error(`工作目录必须是目录：${resolvedCwd}`);
  }
  return resolvedCwd;
}

function readWorkspacePathStats(resolvedCwd: string): WorkspacePathStats {
  try {
    return {
      kind: "found",
      stats: fs.statSync(resolvedCwd),
    };
  } catch (error) {
    const errorCode = readFsErrorCode(error);
    if (errorCode.kind !== "fs-code" || errorCode.code !== "ENOENT") {
      throw error;
    }
    return {
      kind: "missing",
    };
  }
}

function readFsErrorCode(error: unknown): FsErrorCode {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return {
      kind: "fs-code",
      code: error.code,
    };
  }
  return {
    kind: "unknown-error",
  };
}

export function resolveWorkspaceCwdFromFilesystem(requestedCwd: string, currentCwd: string): string {
  const resolvedCwd = path.resolve(currentCwd, requestedCwd);
  const statsResult = readWorkspacePathStats(resolvedCwd);

  return resolveValidatedWorkspaceCwd({
    requestedCwd,
    currentCwd,
    exists: statsResult.kind === "found",
    isDirectory: statsResult.kind === "found" && statsResult.stats.isDirectory(),
  });
}
