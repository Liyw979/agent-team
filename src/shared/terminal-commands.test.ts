import { test } from "bun:test";
import assert from "node:assert/strict";

import { buildCliAttachCommand } from "./terminal-commands";

test("CLI builds an attach command with a custom command name", () => {
  assert.equal(
    buildCliAttachCommand("nga", "http://127.0.0.1:43127", "session-123", "darwin"),
    "nga attach 'http://127.0.0.1:43127' --session 'session-123'",
  );
});

test("CLI builds a Windows attach command without extra quotes for cmd /k", () => {
  assert.equal(
    buildCliAttachCommand("opencode", "http://127.0.0.1:43127", "session-123", "win32"),
    "opencode attach http://127.0.0.1:43127 --session session-123",
  );
});

test("POSIX attach command still quotes baseUrl and session safely", () => {
  assert.equal(
    buildCliAttachCommand("opencode", "http://127.0.0.1:43127", "session-123", "darwin"),
    "opencode attach 'http://127.0.0.1:43127' --session 'session-123'",
  );
});
