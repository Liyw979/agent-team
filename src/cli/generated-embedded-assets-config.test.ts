import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const PACKAGE_JSON = JSON.parse(
  fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as {
  scripts?: Record<string, string>;
};

test("build:embedded-assets 会改为调用 cli 目录下的生成脚本", () => {
  assert.equal(
    PACKAGE_JSON.scripts?.["build:embedded-assets"],
    "node src/cli/generate-embedded-assets.mjs",
  );
});

test("build 和 test 会先生成 generated-embedded-assets.ts", () => {
  assert.equal(
    PACKAGE_JSON.scripts?.build,
    "bun run build:web && bun run build:embedded-assets && tsc --noEmit",
  );
  assert.equal(
    PACKAGE_JSON.scripts?.knip,
    "bun run build:embedded-assets && knip",
  );
  assert.equal(
    PACKAGE_JSON.scripts?.test,
    "bun run build:embedded-assets && tsx --test",
  );
});

test("generated-embedded-assets.ts 会被 git ignore", () => {
  const gitIgnore = fs.readFileSync(new URL("../../.gitignore", import.meta.url), "utf8");
  assert.match(gitIgnore, /^src\/cli\/generated-embedded-assets\.ts$/m);
});

test("generated-embedded-assets.ts 会包含 index.html，确保 exe 内嵌前端入口页", () => {
  const generatedSource = fs.readFileSync(
    new URL("./generated-embedded-assets.ts", import.meta.url),
    "utf8",
  );
  assert.match(generatedSource, /relativePath: "index\.html"/);
});
