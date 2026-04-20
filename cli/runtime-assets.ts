import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json";
import { EMBEDDED_WEB_ASSETS } from "./generated-embedded-assets";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface ResolvedRuntimeAssets {
  webRoot: string | null;
}

export function isCompiledRuntime(): boolean {
  const runtimeDir = (import.meta as ImportMeta & { dir?: string }).dir ?? "";
  return runtimeDir.startsWith("/$bunfs");
}

export function getRepoWebDistRoot(): string {
  return path.join(REPO_ROOT, "dist", "web");
}

export async function ensureRuntimeAssets(userDataPath: string): Promise<ResolvedRuntimeAssets> {
  const runtimeRoot = path.join(userDataPath, "runtime", packageJson.version);
  fs.mkdirSync(runtimeRoot, { recursive: true });

  let webRoot: string | null = process.env.AGENTFLOW_WEB_ROOT?.trim() || null;

  if (isCompiledRuntime()) {
    if (!webRoot && EMBEDDED_WEB_ASSETS.length > 0) {
      webRoot = path.join(runtimeRoot, "web");
      for (const asset of EMBEDDED_WEB_ASSETS) {
        const targetPath = path.join(webRoot, asset.relativePath);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, Buffer.from(asset.base64, "base64"));
      }
    }
  } else {
    if (!webRoot) {
      const repoWebRoot = getRepoWebDistRoot();
      if (fs.existsSync(path.join(repoWebRoot, "index.html"))) {
        webRoot = repoWebRoot;
      }
    }
  }

  if (webRoot) {
    process.env.AGENTFLOW_WEB_ROOT = webRoot;
  }

  return {
    webRoot,
  };
}
