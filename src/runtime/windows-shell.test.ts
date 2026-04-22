import assert from "node:assert/strict";
import test from "node:test";

import { quoteWindowsShellValue, resolveWindowsCmdPath } from "./windows-shell";

test("resolveWindowsCmdPath 优先使用 ComSpec", () => {
  assert.equal(
    resolveWindowsCmdPath({
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      SystemRoot: "C:\\Windows",
    }),
    "C:\\Windows\\System32\\cmd.exe",
  );
});

test("resolveWindowsCmdPath 在缺少 ComSpec 时回退到 SystemRoot", () => {
  assert.equal(
    resolveWindowsCmdPath({
      SystemRoot: "C:\\Windows",
    }),
    "C:\\Windows\\System32\\cmd.exe",
  );
});

test("quoteWindowsShellValue 会给 Windows shell 参数补双引号", () => {
  assert.equal(
    quoteWindowsShellValue("C:\\Windows\\System32\\cmd.exe"),
    "\"C:\\Windows\\System32\\cmd.exe\"",
  );
});
