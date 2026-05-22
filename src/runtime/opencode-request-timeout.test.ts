import { test } from "bun:test";
import assert from "node:assert/strict";

import { getOpenCodeRequestTimeoutMs } from "./opencode-request-timeout";

test("create session 请求继续使用短超时，避免再次挂成整分钟", () => {
  assert.equal(getOpenCodeRequestTimeoutMs({
    pathname: "/session",
    method: "POST",
  }), 12_000);
});

test("session message 请求使用 5 分钟超时", () => {
  assert.equal(getOpenCodeRequestTimeoutMs({
    pathname: "/session/ses_demo/message",
    method: "POST",
  }), 300_000);
});
