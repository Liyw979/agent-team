import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCliAttachSessionCommand,
  buildCliPanelFocusCommand,
  buildOpencodePaneCommand,
} from "./terminal-commands";

test("CLI 打开的 panel 命令使用跨平台双引号参数", () => {
  assert.equal(
    buildCliPanelFocusCommand("task 123", "Code Review"),
    'npm run cli -- panel focus "task 123" "Code Review"',
  );
});

test("CLI 打开的 zellij attach 命令对 Windows 和 POSIX 都可直接复用", () => {
  assert.equal(
    buildCliAttachSessionCommand("session 123"),
    'zellij attach "session 123" --create',
  );
});

test("CLI 打开的 zellij attach 命令支持 Windows 内置二进制路径", () => {
  assert.equal(
    buildCliAttachSessionCommand("session 123", {
      command: "C:\\Program Files\\Agent Flow\\resources\\bin\\zellij.exe",
      platform: "win32",
    }),
    '"C:\\Program Files\\Agent Flow\\resources\\bin\\zellij.exe" attach "session 123" --create',
  );
});

test("Windows pane 启动命令使用 cmd.exe 和 Windows 环境变量语法", () => {
  const command = buildOpencodePaneCommand({
    cwd: "C:\\work tree\\agent-team",
    runtimeDir: "C:\\work tree\\agent-team\\.agentflow\\pane\\Build",
    dbPath: "C:\\work tree\\agent-team\\.agentflow\\pane\\Build\\opencode-pane.db",
    agentName: "Build",
    opencodeSessionId: "session-123",
    opencodeAgentName: "build",
    attachBaseUrl: "http://127.0.0.1:43127",
    platform: "win32",
  });

  assert.equal(command.shellLaunch.command, "cmd.exe");
  assert.deepEqual(command.shellLaunch.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(command.shellCommand, /if not exist "C:\\work tree\\agent-team\\\.agentflow\\pane\\Build" mkdir "C:\\work tree\\agent-team\\\.agentflow\\pane\\Build"/);
  assert.match(command.shellCommand, /cd \/d "C:\\work tree\\agent-team"/);
  assert.match(command.shellCommand, /set "OPENCODE_CONFIG_DIR=C:\\work tree\\agent-team\\\.agentflow\\pane\\Build"/);
  assert.match(command.shellCommand, /set "OPENCODE_DB=C:\\work tree\\agent-team\\\.agentflow\\pane\\Build\\opencode-pane\.db"/);
  assert.match(command.shellCommand, /set "OPENCODE_CLIENT=agentflow-zellij"/);
  assert.match(command.shellCommand, /"opencode" "attach" "http:\/\/127\.0\.0\.1:43127" "--session" "session-123" "--dir" "C:\\work tree\\agent-team"/);
  assert.doesNotMatch(command.shellCommand, /\/bin\/sh|mkdir -p|export /);
});

test("POSIX pane 启动命令继续使用 /bin/sh 和 export", () => {
  const command = buildOpencodePaneCommand({
    cwd: "/tmp/agent-team",
    runtimeDir: "/tmp/agent-team/.agentflow/pane/Build",
    dbPath: "/tmp/agent-team/.agentflow/pane/Build/opencode-pane.db",
    agentName: "Build",
    opencodeSessionId: null,
    opencodeAgentName: "build",
    attachBaseUrl: "http://127.0.0.1:43127",
    platform: "darwin",
  });

  assert.equal(command.shellLaunch.command, "/bin/sh");
  assert.deepEqual(command.shellLaunch.args.slice(0, 1), ["-c"]);
  assert.match(command.shellCommand, /mkdir -p '\/tmp\/agent-team\/\.agentflow\/pane\/Build'/);
  assert.match(command.shellCommand, /export OPENCODE_CONFIG_DIR='\/tmp\/agent-team\/\.agentflow\/pane\/Build'/);
  assert.match(command.shellCommand, /exec opencode \. --agent 'build'/);
});
