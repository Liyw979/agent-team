import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const PACKAGE_JSON = JSON.parse(
  fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as {
  scripts?: Record<string, string>;
};

test("package.json 提供 macOS 打包入口", () => {
  assert.equal(
    PACKAGE_JSON.scripts?.["dist:mac-arm64"],
    "bun run build && bun build --compile --target bun-darwin-arm64 ./src/cli/index.ts --outfile ./dist/agent-team-macos-arm64",
  );
  assert.equal(
    PACKAGE_JSON.scripts?.["dist:mac-x64"],
    "bun run build && bun build --compile --target bun-darwin-x64 ./src/cli/index.ts --outfile ./dist/agent-team-macos-x64",
  );
});
