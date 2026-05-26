// 2026-05-26: 用户要求将非 session message 长请求的默认短超时从 12 秒调整为 30 秒。
import { test } from "bun:test";
import assert from "node:assert/strict";

import { getOpenCodeRequestTimeoutMs } from "./opencode-request-timeout";

test("create session 请求继续使用短超时，避免再次挂成整分钟", () => {
  assert.equal(getOpenCodeRequestTimeoutMs({
    pathname: "/session",
    method: "POST",
  }), 30_000);
});

test("session message 请求使用 5 分钟超时", () => {
  assert.equal(getOpenCodeRequestTimeoutMs({
    pathname: "/session/ses_demo/message",
    method: "POST",
  }), 300_000);
});
