const path = require("node:path");

function resolveCliRepoRoot(scriptDir) {
  const normalizedDir = path.resolve(scriptDir);
  const parentDir = path.dirname(normalizedDir);

  if (path.basename(normalizedDir) === "cli" && path.basename(parentDir) === "src") {
    return path.dirname(parentDir);
  }

  return parentDir;
}

module.exports = {
  resolveCliRepoRoot,
};
