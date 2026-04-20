import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCliAttachAgentCommand,
  buildCliOpencodeAttachCommand,
} from "./terminal-commands";

test("CLI 打开的 attach 命令统一走顶层 attach 子命令", () => {
  assert.equal(
    buildCliAttachAgentCommand("Code Review"),
    'bun run cli -- task attach "Code Review"',
  );
});

test("CLI 在跨工作区场景下构造 task attach 命令时会带上 --cwd", () => {
  assert.equal(
    buildCliAttachAgentCommand("Code Review", "/tmp/project"),
    'bun run cli -- task attach "Code Review" --cwd "/tmp/project"',
  );
});

test("CLI 支持直接构造 OpenCode attach agent session 命令", () => {
  assert.equal(
    buildCliOpencodeAttachCommand("http://127.0.0.1:43127", "session-123", "/tmp/agent team"),
    'opencode attach "http://127.0.0.1:43127" --session "session-123" --dir "/tmp/agent team"',
  );
});
