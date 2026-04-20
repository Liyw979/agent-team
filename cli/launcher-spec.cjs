const path = require("node:path");

function buildCliLauncherSpec(input) {
  const repoRoot = input.repoRoot;
  const entry = path.resolve(repoRoot, "cli/index.ts");
  const preflight = path.resolve(repoRoot, "node_modules/tsx/dist/preflight.cjs");
  const loader = path.resolve(repoRoot, "node_modules/tsx/dist/loader.mjs");

  return {
    command: input.nodeBinary,
    args: [
      "--require",
      preflight,
      "--import",
      `file://${loader}`,
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
