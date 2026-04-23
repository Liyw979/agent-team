import assert from "node:assert/strict";
import test from "node:test";

import {
  isCompiledRuntimeExecutable,
  isCompiledRuntimeDir,
  isRuntimeWebSourcePath,
  resolveCompiledEmbeddedWebRoot,
  resolveRuntimeWebRoot,
  resolveSourceAssetFallback,
  shouldReuseRepoWebDist,
} from "./runtime-assets";

test("does not fall back when dist/web is missing", () => {
  assert.equal(
    resolveSourceAssetFallback({
      repoWebRootExists: false,
      distBuiltAtMs: null,
      latestSourceUpdatedAtMs: Date.UTC(2026, 3, 21, 11, 0, 0),
    }),
    "unavailable",
  );
});

test("does not fall back when dist/web is older than source", () => {
  assert.equal(
    resolveSourceAssetFallback({
      repoWebRootExists: true,
      distBuiltAtMs: Date.UTC(2026, 3, 20, 20, 58, 0),
      latestSourceUpdatedAtMs: Date.UTC(2026, 3, 21, 11, 0, 0),
    }),
    "unavailable",
  );
});

test("source-mode task ui does not reuse stale dist/web", () => {
  assert.equal(
    shouldReuseRepoWebDist({
      repoWebRootExists: true,
      distBuiltAtMs: Date.UTC(2026, 3, 20, 20, 58, 0),
      latestSourceUpdatedAtMs: Date.UTC(2026, 3, 21, 11, 0, 0),
    }),
    false,
  );
});

test("source-mode task ui reuses fresh dist/web", () => {
  assert.equal(
    shouldReuseRepoWebDist({
      repoWebRootExists: true,
      distBuiltAtMs: Date.UTC(2026, 3, 21, 11, 5, 0),
      latestSourceUpdatedAtMs: Date.UTC(2026, 3, 21, 11, 0, 0),
    }),
    true,
  );
});

test("source-mode task ui 不能把 build 生成的 embedded-assets 文件当成前端源码变更", () => {
  assert.equal(isRuntimeWebSourcePath("src/cli/generated-embedded-assets.ts"), false);
  assert.equal(isRuntimeWebSourcePath("src/App.tsx"), true);
});

test("fallback resolution returns null without a web root", () => {
  assert.equal(
    resolveRuntimeWebRoot({
      fallbackWebRoot: null,
      fallbackIndexHtmlExists: false,
    }),
    null,
  );
});

test("fallback resolution returns dist/web when index.html exists", () => {
  assert.equal(
    resolveRuntimeWebRoot({
      fallbackWebRoot: "/repo/dist/web",
      fallbackIndexHtmlExists: true,
    }),
    "/repo/dist/web",
  );
});

test("compiled runtime does not expose embedded web root without index.html", () => {
  assert.equal(
    resolveCompiledEmbeddedWebRoot({
      runtimeRoot: "/tmp/src/runtime/0.1.0",
      embeddedAssetRelativePaths: [
        "assets/index-abc123.js",
        "assets/index-def456.css",
      ],
    }),
    null,
  );
});

test("compiled runtime bunfs dir is detected", () => {
  assert.equal(
    isCompiledRuntimeDir("file:///$bunfs/root/compile"),
    true,
  );
});

test("compiled runtime executable path is detected", () => {
  assert.equal(
    isCompiledRuntimeExecutable("D:\\repo\\agent-team\\dist\\agent-team.exe"),
    true,
  );
  assert.equal(
    isCompiledRuntimeExecutable("/repo/agent-team/dist/agent-team-macos-arm64"),
    true,
  );
});

test("node and bun executables are not treated as compiled runtime", () => {
  assert.equal(
    isCompiledRuntimeExecutable("C:\\Program Files\\nodejs\\node.exe"),
    false,
  );
  assert.equal(
    isCompiledRuntimeExecutable("C:\\tools\\bun.exe"),
    false,
  );
  assert.equal(
    isCompiledRuntimeExecutable("/usr/local/bin/node"),
    false,
  );
  assert.equal(
    isCompiledRuntimeExecutable("/usr/local/bin/bun"),
    false,
  );
});
