import test from "node:test";
import assert from "node:assert/strict";

import {
  collectNewTaskAttachCommandEntries,
  renderTaskAttachCommands,
} from "./task-attach-display";

test("renderTaskAttachCommands 在 CLI 里只展示底层 opencode attach 命令", () => {
  const output = renderTaskAttachCommands([
    {
      agentId: "Build",
      opencodeAttachCommand: "opencode attach 'http://127.0.0.1:43127' --session 'session-1'",
    },
  ]);

  assert.match(output, /^attach:\n/);
  assert.match(output, /- Build \| opencode attach 'http:\/\/127\.0\.0\.1:43127' --session 'session-1'/);
  assert.doesNotMatch(output, /^\nattach:\n/);
  assert.doesNotMatch(output, /opencode attach:/);
  assert.doesNotMatch(output, /task attach/);
});

test("collectNewTaskAttachCommandEntries 会找出 spawn 后新出现的 attach 命令", () => {
  const previous = [
    {
      agentId: "线索发现",
      opencodeAttachCommand: "opencode attach 'http://127.0.0.1:4096' --session 'ses-initial'",
    },
    {
      agentId: "漏洞论证-1",
      opencodeAttachCommand: null,
    },
  ];

  const next = [
    {
      agentId: "线索发现",
      opencodeAttachCommand: "opencode attach 'http://127.0.0.1:4096' --session 'ses-initial'",
    },
    {
      agentId: "漏洞论证-1",
      opencodeAttachCommand: "opencode attach 'http://127.0.0.1:4096' --session 'ses-pro-1'",
    },
    {
      agentId: "讨论总结-1",
      opencodeAttachCommand: "opencode attach 'http://127.0.0.1:4096' --session 'ses-summary-1'",
    },
  ];

  assert.deepEqual(collectNewTaskAttachCommandEntries(previous, next), [
    {
      agentId: "漏洞论证-1",
      opencodeAttachCommand: "opencode attach 'http://127.0.0.1:4096' --session 'ses-pro-1'",
    },
    {
      agentId: "讨论总结-1",
      opencodeAttachCommand: "opencode attach 'http://127.0.0.1:4096' --session 'ses-summary-1'",
    },
  ]);
});

test("renderTaskAttachCommands 不会展示没有 session 的占位 agent", () => {
  const output = renderTaskAttachCommands([
    {
      agentId: "线索发现",
      opencodeAttachCommand: "opencode attach 'http://127.0.0.1:4096' --session 'ses-initial'",
    },
    {
      agentId: "漏洞论证",
      opencodeAttachCommand: null,
    },
  ]);

  assert.match(output, /- 线索发现 \| opencode attach 'http:\/\/127\.0\.0\.1:4096' --session 'ses-initial'/);
  assert.doesNotMatch(output, /漏洞论证/);
  assert.doesNotMatch(output, /当前还没有可用 session/);
});
