const path = require("node:path");

function selectPathModule(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function toImportFileUrl(filePath, platform) {
  if (platform === "win32") {
    return `file:///${encodeURI(filePath.replace(/\\/g, "/"))}`;
  }
  return `file://${encodeURI(filePath)}`;
}

function buildCliLauncherSpec(input) {
  const platform = input.platform || process.platform;
  const pathModule = selectPathModule(platform);
  const repoRoot = input.repoRoot;
  const entry = pathModule.resolve(repoRoot, "src/cli/index.ts");
  const preflight = pathModule.resolve(repoRoot, "node_modules/tsx/dist/preflight.cjs");
  const loader = pathModule.resolve(repoRoot, "node_modules/tsx/dist/loader.mjs");

  return {
    command: input.nodeBinary,
    args: [
      "--require",
      preflight,
      "--import",
      toImportFileUrl(loader, platform),
      entry,
      ...input.argv,
    ],
    cwd: repoRoot,
    env: {
      ...input.env,
    },
  };
}

module.exports = {
  buildCliLauncherSpec,
};
