import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json";
import { EMBEDDED_WEB_ASSETS } from "./generated-embedded-assets";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_SOURCE_WATCH_PATHS = [
  "src",
  "shared",
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
  explicitWebRoot: string | null;
  explicitIndexHtmlExists: boolean;
  fallbackWebRoot: string | null;
  fallbackIndexHtmlExists: boolean;
}

interface ResolveCompiledEmbeddedWebRootInput {
  explicitWebRoot: string | null;
  runtimeRoot: string;
  embeddedAssetRelativePaths: string[];
}

export function resolveSourceAssetFallback(input: {
  hasExplicitWebRoot: boolean;
  repoWebRootExists: boolean;
  distBuiltAtMs: number | null;
  latestSourceUpdatedAtMs: number | null;
}): "webRoot" | "unavailable" {
  if (input.hasExplicitWebRoot) {
    return "unavailable";
  }

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
  return isCompiledRuntimeDir(runtimeDir);
}

export function isCompiledRuntimeDir(runtimeDir: string): boolean {
  const normalized = runtimeDir.replace(/\\/g, "/");
  return normalized.startsWith("/$bunfs")
    || normalized.startsWith("file:///$bunfs/")
    || normalized === "file:///$bunfs";
}

function getRepoWebDistRoot(): string {
  return path.join(REPO_ROOT, "dist", "web");
}

export function shouldReuseRepoWebDist(input: {
  hasExplicitWebRoot: boolean;
  repoWebRootExists: boolean;
  distBuiltAtMs: number | null;
  latestSourceUpdatedAtMs: number | null;
}) {
  return resolveSourceAssetFallback(input) === "webRoot";
}

export function resolveCompiledEmbeddedWebRoot(input: ResolveCompiledEmbeddedWebRootInput): string | null {
  if (input.explicitWebRoot) {
    return null;
  }

  return input.embeddedAssetRelativePaths.includes("index.html")
    ? path.join(input.runtimeRoot, "web")
    : null;
}

export function resolveRuntimeWebRoot(input: ResolveRuntimeWebRootInput): string | null {
  if (input.explicitWebRoot) {
    return input.explicitIndexHtmlExists ? input.explicitWebRoot : null;
  }

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

  const explicitWebRoot = process.env.AGENT_TEAM_WEB_ROOT?.trim() || null;
  let fallbackWebRoot: string | null = null;

  if (isCompiledRuntime()) {
    const compiledEmbeddedWebRoot = resolveCompiledEmbeddedWebRoot({
      explicitWebRoot,
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
    if (!explicitWebRoot) {
      const repoWebRoot = getRepoWebDistRoot();
      const repoIndexPath = path.join(repoWebRoot, "index.html");
      if (shouldReuseRepoWebDist({
        hasExplicitWebRoot: false,
        repoWebRootExists: fs.existsSync(repoIndexPath),
        distBuiltAtMs: fs.existsSync(repoIndexPath) ? fs.statSync(repoIndexPath).mtimeMs : null,
        latestSourceUpdatedAtMs: getLatestRepoWebSourceUpdatedAtMs(),
      })) {
        fallbackWebRoot = repoWebRoot;
      }
    }
  }

  const webRoot = resolveRuntimeWebRoot({
    explicitWebRoot,
    explicitIndexHtmlExists: hasIndexHtmlFile(explicitWebRoot),
    fallbackWebRoot,
    fallbackIndexHtmlExists: hasIndexHtmlFile(fallbackWebRoot),
  });

  if (webRoot) {
    process.env.AGENT_TEAM_WEB_ROOT = webRoot;
  } else {
    delete process.env.AGENT_TEAM_WEB_ROOT;
  }

  return {
    webRoot,
  };
}
