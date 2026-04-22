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

interface ResolvedRuntimeAssets {
  webRoot: string | null;
}

interface ResolveRuntimeWebRootInput {
  fallbackWebRoot: string | null;
  fallbackIndexHtmlExists: boolean;
}

interface ResolveCompiledEmbeddedWebRootInput {
  runtimeRoot: string;
  embeddedAssetRelativePaths: string[];
}

export function resolveSourceAssetFallback(input: {
  repoWebRootExists: boolean;
  distBuiltAtMs: number | null;
  latestSourceUpdatedAtMs: number | null;
}): "webRoot" | "unavailable" {
  if (!input.repoWebRootExists) {
    return "unavailable";
  }

  if (!Number.isFinite(input.distBuiltAtMs) || !Number.isFinite(input.latestSourceUpdatedAtMs)) {
    return "unavailable";
  }

  return (input.distBuiltAtMs ?? 0) >= (input.latestSourceUpdatedAtMs ?? 0)
    ? "webRoot"
    : "unavailable";
}

export function isCompiledRuntime(): boolean {
  const runtimeDir = (import.meta as ImportMeta & { dir?: string }).dir ?? "";
  return isCompiledRuntimeDir(runtimeDir) || isCompiledRuntimeExecutable(process.execPath);
}

export function isCompiledRuntimeDir(runtimeDir: string): boolean {
  const normalized = runtimeDir.replace(/\\/g, "/");
  return normalized.startsWith("/$bunfs")
    || normalized.startsWith("file:///$bunfs/")
    || normalized === "file:///$bunfs";
}

export function isCompiledRuntimeExecutable(execPath: string): boolean {
  const normalizedExecPath = (execPath || "").replace(/\\/g, "/");
  const executableName = path.posix.basename(normalizedExecPath).toLowerCase();
  if (!executableName) {
    return false;
  }

  return executableName !== "node"
    && executableName !== "node.exe"
    && executableName !== "bun"
    && executableName !== "bun.exe";
}

function getRepoWebDistRoot(): string {
  return path.join(REPO_ROOT, "dist", "web");
}

export function shouldReuseRepoWebDist(input: {
  repoWebRootExists: boolean;
  distBuiltAtMs: number | null;
  latestSourceUpdatedAtMs: number | null;
}) {
  return resolveSourceAssetFallback(input) === "webRoot";
}

export function resolveCompiledEmbeddedWebRoot(input: ResolveCompiledEmbeddedWebRootInput): string | null {
  return input.embeddedAssetRelativePaths.includes("index.html")
    ? path.join(input.runtimeRoot, "web")
    : null;
}

export function resolveRuntimeWebRoot(input: ResolveRuntimeWebRootInput): string | null {
  if (!input.fallbackWebRoot) {
    return null;
  }

  return input.fallbackIndexHtmlExists ? input.fallbackWebRoot : null;
}

function hasIndexHtmlFile(webRoot: string | null): boolean {
  if (!webRoot) {
    return false;
  }

  const indexPath = path.join(webRoot, "index.html");
  return fs.existsSync(indexPath) && fs.statSync(indexPath).isFile();
}

function getLatestMtimeMs(targetPath: string): number | null {
  if (!fs.existsSync(targetPath)) {
    return null;
  }

  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    return stat.mtimeMs;
  }

  if (!stat.isDirectory()) {
    return null;
  }

  let latest = stat.mtimeMs;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    const childLatest = getLatestMtimeMs(path.join(targetPath, entry.name));
    if (typeof childLatest === "number" && childLatest > latest) {
      latest = childLatest;
    }
  }
  return latest;
}

function getLatestRepoWebSourceUpdatedAtMs() {
  let latest: number | null = null;

  for (const relativePath of WEB_SOURCE_WATCH_PATHS) {
    const candidate = getLatestMtimeMs(path.join(REPO_ROOT, relativePath));
    if (typeof candidate === "number" && (latest === null || candidate > latest)) {
      latest = candidate;
    }
  }

  return latest;
}

export async function ensureRuntimeAssets(userDataPath: string): Promise<ResolvedRuntimeAssets> {
  const runtimeRoot = path.join(userDataPath, "runtime", packageJson.version);
  fs.mkdirSync(runtimeRoot, { recursive: true });

  let fallbackWebRoot: string | null = null;

  if (isCompiledRuntime()) {
    const compiledEmbeddedWebRoot = resolveCompiledEmbeddedWebRoot({
      runtimeRoot,
      embeddedAssetRelativePaths: EMBEDDED_WEB_ASSETS.map((asset) => asset.relativePath),
    });
    if (compiledEmbeddedWebRoot) {
      fallbackWebRoot = compiledEmbeddedWebRoot;
      for (const asset of EMBEDDED_WEB_ASSETS) {
        const targetPath = path.join(fallbackWebRoot, asset.relativePath);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, Buffer.from(asset.base64, "base64"));
      }
    }
  } else {
    const repoWebRoot = getRepoWebDistRoot();
    const repoIndexPath = path.join(repoWebRoot, "index.html");
    if (shouldReuseRepoWebDist({
      repoWebRootExists: fs.existsSync(repoIndexPath),
      distBuiltAtMs: fs.existsSync(repoIndexPath) ? fs.statSync(repoIndexPath).mtimeMs : null,
      latestSourceUpdatedAtMs: getLatestRepoWebSourceUpdatedAtMs(),
    })) {
      fallbackWebRoot = repoWebRoot;
    }
  }

  const webRoot = resolveRuntimeWebRoot({
    fallbackWebRoot,
    fallbackIndexHtmlExists: hasIndexHtmlFile(fallbackWebRoot),
  });

  return {
    webRoot,
  };
}
