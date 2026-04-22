const path = require("node:path");

function resolveCliRepoRoot(scriptDir) {
  return path.resolve(scriptDir, "..");
}

module.exports = {
  resolveCliRepoRoot,
};
