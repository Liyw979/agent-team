import assert from "node:assert/strict";
import path from "node:path";
import { test } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveCliRepoRoot } = require("./launcher-paths.cjs") as {
  resolveCliRepoRoot: (scriptDir: string) => string;
};

test("resolveCliRepoRoot 浼氭妸 cli 鐩綍瑙ｆ瀽鍥炲綋鍓嶄粨搴撴牴鐩綍", () => {
  const repoRoot = path.resolve("fixtures", "agent-team");
  const scriptDir = path.join(repoRoot, "cli");

  assert.equal(resolveCliRepoRoot(scriptDir), repoRoot);
});

test("resolveCliRepoRoot 浼氭妸 src/cli 鐩綍瑙ｆ瀽鍥炵湡瀹炰粨搴撴牴鐩綍", () => {
  const repoRoot = path.resolve("/repo/agent-team");
  const scriptDir = path.join(repoRoot, "src", "cli");

  assert.equal(resolveCliRepoRoot(scriptDir), repoRoot);
});
