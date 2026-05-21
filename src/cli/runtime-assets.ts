import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import packageJson from "../../package.json";
import { EMBEDDED_WEB_ASSETS } from "./generated-embedded-assets";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WEB_SOURCE_WATCH_PATHS = [
  "src",
  "index.html",
  "package.json",
  "postcss.config.js",
  "tailwind.config.ts",
  "vite.config.ts",
] as const;

const EXCLUDED_RUNTIME_WEB_SOURCE_PATHS = new Set([
  "src/cli/generated-embedded-assets.ts",
]);

type ResolvedRuntimeAssets =
  | {
      kind: "available";
      webRoot: string;
    }
  | {
      kind: "unavailable";
    };

type RuntimeWebRootCandidate =
  | {
      kind: "available";
      webRoot: string;
    }
  | {
      kind: "unavailable";
    };

type SourceMtimeResult =
  | {
      kind: "found";
      mtimeMs: number;
    }
  | {
      kind: "missing";
    };

type RuntimeDirResult =
  | {
      kind: "found";
      runtimeDir: string;
    }
  | {
      kind: "missing";
    };

interface ResolveCompiledEmbeddedWebRootInput {
  runtimeRoot: string;
  embeddedAssetRelativePaths: string[];
}

function resolveSourceAssetFallback(input: {
  repoWebRootExists: boolean;
  distBuiltAtMs: SourceMtimeResult;
  latestSourceUpdatedAtMs: SourceMtimeResult;
}): "webRoot" | "unavailable" {
  if (!input.repoWebRootExists) {
    return "unavailable";
  }

  if (input.distBuiltAtMs.kind === "missing" || input.latestSourceUpdatedAtMs.kind === "missing") {
    return "unavailable";
  }

  return input.distBuiltAtMs.mtimeMs >= input.latestSourceUpdatedAtMs.mtimeMs
    ? "webRoot"
    : "unavailable";
}

export function isCompiledRuntime(): boolean {
  const runtimeDirResult = readImportMetaRuntimeDir(import.meta);
  return (
    runtimeDirResult.kind === "found" && isCompiledRuntimeDir(runtimeDirResult.runtimeDir)
  ) || isCompiledRuntimeExecutable(process.execPath);
}

function readImportMetaRuntimeDir(meta: ImportMeta): RuntimeDirResult {
  if ("dir" in meta && typeof meta.dir === "string") {
    return {
      kind: "found",
      runtimeDir: meta.dir,
    };
  }
  return {
    kind: "missing",
  };
}

function isCompiledRuntimeDir(runtimeDir: string): boolean {
  const normalized = runtimeDir.replace(/\\/g, "/");
  return normalized.startsWith("/$bunfs")
    || normalized.startsWith("file:///$bunfs/")
    || normalized === "file:///$bunfs";
}

function isCompiledRuntimeExecutable(execPath: string): boolean {
  const normalizedExecPath = execPath.replace(/\\/g, "/");
  const executableName = path.posix.basename(normalizedExecPath).toLowerCase();

  return executableName !== "node"
    && executableName !== "node.exe"
    && executableName !== "bun"
    && executableName !== "bun.exe";
}

function getRepoWebDistRoot(): string {
  return path.join(REPO_ROOT, "dist", "web");
}

function shouldReuseRepoWebDist(input: {
  repoWebRootExists: boolean;
  distBuiltAtMs: SourceMtimeResult;
  latestSourceUpdatedAtMs: SourceMtimeResult;
}) {
  return resolveSourceAssetFallback(input) === "webRoot";
}

function resolveCompiledEmbeddedWebRoot(input: ResolveCompiledEmbeddedWebRootInput): RuntimeWebRootCandidate {
  return input.embeddedAssetRelativePaths.includes("index.html")
    ? {
        kind: "available",
        webRoot: path.join(input.runtimeRoot, "web"),
      }
    : {
        kind: "unavailable",
      };
}

function resolveRuntimeWebRoot(candidate: RuntimeWebRootCandidate): ResolvedRuntimeAssets {
  if (candidate.kind === "unavailable") {
    return candidate;
  }
  const webRoot = candidate.webRoot;
  const indexPath = path.join(webRoot, "index.html");
  return fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()
    ? candidate
    : {
        kind: "unavailable",
      };
}

function isRuntimeWebSourcePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return !EXCLUDED_RUNTIME_WEB_SOURCE_PATHS.has(normalized);
}

function foundMtime(mtimeMs: number): SourceMtimeResult {
  return {
    kind: "found",
    mtimeMs,
  };
}

function missingMtime(): SourceMtimeResult {
  return {
    kind: "missing",
  };
}

function latestMtime(left: SourceMtimeResult, right: SourceMtimeResult): SourceMtimeResult {
  if (left.kind === "missing") {
    return right;
  }
  if (right.kind === "missing") {
    return left;
  }
  return left.mtimeMs >= right.mtimeMs ? left : right;
}

function readFileMtime(filePath: string): SourceMtimeResult {
  return fs.existsSync(filePath)
    ? foundMtime(fs.statSync(filePath).mtimeMs)
    : missingMtime();
}

function getLatestSourceAwareMtimeMs(targetPath: string): SourceMtimeResult {
  if (!fs.existsSync(targetPath)) {
    return missingMtime();
  }

  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    const relativePath = path.relative(REPO_ROOT, targetPath).replace(/\\/g, "/");
    return isRuntimeWebSourcePath(relativePath)
      ? foundMtime(stat.mtimeMs)
      : missingMtime();
  }

  if (!stat.isDirectory()) {
    return missingMtime();
  }

  return fs.readdirSync(targetPath, { withFileTypes: true }).reduce(
    (latest, entry) => latestMtime(latest, getLatestSourceAwareMtimeMs(path.join(targetPath, entry.name))),
    missingMtime(),
  );
}

function getLatestRepoWebSourceUpdatedAtMs() {
  return WEB_SOURCE_WATCH_PATHS.reduce(
    (latest, relativePath) => latestMtime(latest, getLatestSourceAwareMtimeMs(path.join(REPO_ROOT, relativePath))),
    missingMtime(),
  );
}

export async function ensureRuntimeAssets(userDataPath: string): Promise<ResolvedRuntimeAssets> {
  const runtimeRoot = path.join(userDataPath, "runtime", packageJson.version);
  fs.mkdirSync(runtimeRoot, { recursive: true });

  let candidate: RuntimeWebRootCandidate = {
    kind: "unavailable",
  };

  if (isCompiledRuntime()) {
    const compiledEmbeddedWebRoot = resolveCompiledEmbeddedWebRoot({
      runtimeRoot,
      embeddedAssetRelativePaths: EMBEDDED_WEB_ASSETS.map((asset) => asset.relativePath),
    });
    if (compiledEmbeddedWebRoot.kind === "available") {
      candidate = compiledEmbeddedWebRoot;
      for (const asset of EMBEDDED_WEB_ASSETS) {
        const targetPath = path.join(candidate.webRoot, asset.relativePath);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, Buffer.from(asset.base64, "base64"));
      }
    }
  } else {
    const repoWebRoot = getRepoWebDistRoot();
    const repoIndexPath = path.join(repoWebRoot, "index.html");
    if (shouldReuseRepoWebDist({
      repoWebRootExists: fs.existsSync(repoIndexPath),
      distBuiltAtMs: readFileMtime(repoIndexPath),
      latestSourceUpdatedAtMs: getLatestRepoWebSourceUpdatedAtMs(),
    })) {
      candidate = {
        kind: "available",
        webRoot: repoWebRoot,
      };
    }
  }

  return resolveRuntimeWebRoot(candidate);
}
