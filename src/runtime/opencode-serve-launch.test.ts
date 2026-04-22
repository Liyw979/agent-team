import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { extractOpenCodeServeBaseUrl } from "./opencode-serve-launch";

test("OpenCode serve 启动参数直接内联为 serve，避免无意义包装函数", () => {
  const source = fs.readFileSync(new URL("./opencode-client.ts", import.meta.url), "utf8");
  assert.match(source, /const launchArgs = \["serve"\]/);
});

test("OpenCode serve 输出监听地址后，运行时可以解析实际 baseUrl", () => {
  assert.equal(
    extractOpenCodeServeBaseUrl([
      "Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.",
      "opencode server listening on http://127.0.0.1:63791",
    ].join("\n")),
    "http://127.0.0.1:63791",
  );
});
