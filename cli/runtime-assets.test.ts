import assert from "node:assert/strict";
import test from "node:test";

import {
  isCompiledRuntimeDir,
  resolveCompiledEmbeddedWebRoot,
  resolveRuntimeWebRoot,
  resolveSourceAssetFallback,
  shouldReuseRepoWebDist,
} from "./runtime-assets";

test("当 dist/web 不可用时，不应回退到源码目录再起 Vite", () => {
  assert.equal(
    resolveSourceAssetFallback({
      hasExplicitWebRoot: false,
      repoWebRootExists: false,
      distBuiltAtMs: null,
      latestSourceUpdatedAtMs: Date.UTC(2026, 3, 21, 11, 0, 0),
    }),
    "unavailable",
  );
});

test("当 dist/web 早于源码时，不应回退到源码目录再起 Vite", () => {
  assert.equal(
    resolveSourceAssetFallback({
      hasExplicitWebRoot: false,
      repoWebRootExists: true,
      distBuiltAtMs: Date.UTC(2026, 3, 20, 20, 58, 0),
      latestSourceUpdatedAtMs: Date.UTC(2026, 3, 21, 11, 0, 0),
    }),
    "unavailable",
  );
});

test("当源码时间晚于 dist/web 时，源码态 task ui 不应继续复用旧前端产物", () => {
  assert.equal(
    shouldReuseRepoWebDist({
      hasExplicitWebRoot: false,
      repoWebRootExists: true,
      distBuiltAtMs: Date.UTC(2026, 3, 20, 20, 58, 0),
      latestSourceUpdatedAtMs: Date.UTC(2026, 3, 21, 11, 0, 0),
    }),
    false,
  );
});

test("当 dist/web 不早于源码时，源码态 task ui 可以直接复用已有前端产物", () => {
  assert.equal(
    shouldReuseRepoWebDist({
      hasExplicitWebRoot: false,
      repoWebRootExists: true,
      distBuiltAtMs: Date.UTC(2026, 3, 21, 11, 5, 0),
      latestSourceUpdatedAtMs: Date.UTC(2026, 3, 21, 11, 0, 0),
    }),
    true,
  );
});

test("显式指定 AGENT_TEAM_WEB_ROOT 时，不应再按仓库 dist/web 新旧判断", () => {
  assert.equal(
    shouldReuseRepoWebDist({
      hasExplicitWebRoot: true,
      repoWebRootExists: true,
      distBuiltAtMs: Date.UTC(2026, 3, 20, 20, 58, 0),
      latestSourceUpdatedAtMs: Date.UTC(2026, 3, 21, 11, 0, 0),
    }),
    false,
  );
});

test("显式指定的静态目录缺少 index.html 时，应判定为不可用", () => {
  assert.equal(
    resolveRuntimeWebRoot({
      explicitWebRoot: "/tmp/custom-web-root",
      explicitIndexHtmlExists: false,
      fallbackWebRoot: "/repo/dist/web",
      fallbackIndexHtmlExists: true,
    }),
    null,
  );
});

test("编译态内嵌资源缺少 index.html 时，不应暴露 exe 的前端静态目录", () => {
  assert.equal(
    resolveCompiledEmbeddedWebRoot({
      explicitWebRoot: null,
      runtimeRoot: "/tmp/runtime/0.1.0",
      embeddedAssetRelativePaths: [
        "assets/index-abc123.js",
        "assets/index-def456.css",
      ],
    }),
    null,
  );
});

test("compiled runtime 的 bunfs URL 目录应识别为编译态", () => {
  assert.equal(
    isCompiledRuntimeDir("file:///$bunfs/root/compile"),
    true,
  );
});
