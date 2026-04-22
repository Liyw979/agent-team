import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCliOpencodeAttachCommand,
} from "./terminal-commands";

test("CLI builds a Windows attach command without extra quotes for cmd /k", () => {
  assert.equal(
    buildCliOpencodeAttachCommand("http://127.0.0.1:43127", "session-123", {
      platform: "win32",
    }),
    "opencode attach http://127.0.0.1:43127 --session session-123",
  );
});

test("POSIX attach command still quotes baseUrl and session safely", () => {
  assert.equal(
    buildCliOpencodeAttachCommand("http://127.0.0.1:43127", "session-123", {
      platform: "darwin",
    }),
    "opencode attach 'http://127.0.0.1:43127' --session 'session-123'",
  );
});
