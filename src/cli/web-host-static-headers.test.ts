import assert from "node:assert/strict";
import test from "node:test";

import { buildStaticFileHeaders } from "./web-host";

test("web host 返回静态页面和前端产物时必须禁用缓存，避免 UI 继续显示旧字号", () => {
  assert.deepEqual(buildStaticFileHeaders("/tmp/index.html"), {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });

  assert.deepEqual(buildStaticFileHeaders("/tmp/assets/index.js"), {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "no-store",
  });

  assert.deepEqual(buildStaticFileHeaders("/tmp/assets/index.css"), {
    "content-type": "text/css; charset=utf-8",
    "cache-control": "no-store",
  });
});
