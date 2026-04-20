import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface RepositorySnapshot {
  packageJson: string;
  agentsDoc: string;
  launcherScript: string;
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
  if (/\bElectron\b/.test(snapshot.agentsDoc) || /├── electron\//.test(snapshot.agentsDoc)) {
    issues.push("AGENTS.md 仍记录 Electron 技术栈或目录");
  }
  if (/electron\/cli\//.test(snapshot.launcherScript)) {
    issues.push("bin/agentflow 仍指向 electron/cli");
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
    launcherScript: fs.readFileSync(path.join(repoRoot, "bin", "agentflow"), "utf8"),
    hasElectronViteConfig: fs.existsSync(path.join(repoRoot, "electron.vite.config.ts")),
    hasElectronMainEntry: fs.existsSync(path.join(repoRoot, "electron", "main", "index.ts")),
    hasElectronPreload: fs.existsSync(path.join(repoRoot, "electron", "preload.ts")),
  };

  assert.deepEqual(collectLegacyElectronFootprints(snapshot), []);
});
