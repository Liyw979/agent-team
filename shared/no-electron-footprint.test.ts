import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface RepositorySnapshot {
  packageJson: string;
  agentsDoc: string;
  launcherScript: string;
  hasRootPackageLock: boolean;
  hasRootBunLock: boolean;
  hasElectronViteConfig: boolean;
  hasElectronMainEntry: boolean;
  hasElectronPreload: boolean;
}

function collectLegacyElectronFootprints(snapshot: RepositorySnapshot) {
  const issues: string[] = [];

  if (/electron-updater|electron-builder|electron-vite/.test(snapshot.packageJson)) {
    issues.push("package.json 仍声明 Electron 依赖");
  }
  if (/electron\/cli\//.test(snapshot.packageJson)) {
    issues.push("package.json 脚本仍指向 electron/cli");
  }
  if (/"packageManager"\s*:\s*"bun@/.test(snapshot.packageJson) === false) {
    issues.push("package.json 未声明 Bun 作为默认包管理器");
  }
  if (/\bnpm run\b/.test(snapshot.packageJson)) {
    issues.push("package.json 脚本仍回指 npm run");
  }
  if (/\bElectron\b/.test(snapshot.agentsDoc) || /├── electron\//.test(snapshot.agentsDoc)) {
    issues.push("AGENTS.md 仍记录 Electron 技术栈或目录");
  }
  if (/\bnpm run\b/.test(snapshot.agentsDoc)) {
    issues.push("AGENTS.md 主工程命令文案仍回指 npm run");
  }
  if (/electron\/cli\//.test(snapshot.launcherScript)) {
    issues.push("bin/agent-team 仍指向 electron/cli");
  }
  if (snapshot.hasRootPackageLock) {
    issues.push("主工程根目录仍保留 package-lock.json");
  }
  if (snapshot.hasRootBunLock === false) {
    issues.push("主工程根目录缺少 bun.lock");
  }
  if (snapshot.hasElectronViteConfig) {
    issues.push("仓库仍保留 electron.vite.config.ts");
  }
  if (snapshot.hasElectronMainEntry) {
    issues.push("仓库仍保留 Electron 主进程入口");
  }
  if (snapshot.hasElectronPreload) {
    issues.push("仓库仍保留 Electron preload");
  }

  return issues;
}

test("仓库不再残留 Electron 集成足迹", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const snapshot: RepositorySnapshot = {
    packageJson: fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    agentsDoc: fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8"),
    launcherScript: fs.readFileSync(path.join(repoRoot, "bin", "agent-team"), "utf8"),
    hasRootPackageLock: fs.existsSync(path.join(repoRoot, "package-lock.json")),
    hasRootBunLock: fs.existsSync(path.join(repoRoot, "bun.lock")),
    launcherScript: fs.readFileSync(path.join(repoRoot, "bin", "agent-team"), "utf8"),
    hasRootPackageLock: fs.existsSync(path.join(repoRoot, "package-lock.json")),
    hasRootBunLock: fs.existsSync(path.join(repoRoot, "bun.lock")),
    hasElectronViteConfig: fs.existsSync(path.join(repoRoot, "electron.vite.config.ts")),
    hasElectronMainEntry: fs.existsSync(path.join(repoRoot, "electron", "main", "index.ts")),
    hasElectronPreload: fs.existsSync(path.join(repoRoot, "electron", "preload.ts")),
  };

  assert.deepEqual(collectLegacyElectronFootprints(snapshot), []);
});
