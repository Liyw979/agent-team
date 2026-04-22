import test from "node:test";
import assert from "node:assert/strict";

import { buildTerminalLaunchSpec } from "./terminal-launcher";

test("buildTerminalLaunchSpec uses cmd start to launch a visible Windows attach terminal", () => {
  const spec = buildTerminalLaunchSpec({
    cwd: "C:\\work\\agent-team",
    command: "opencode attach http://127.0.0.1:4310 --session session-1",
    platform: "win32",
    env: {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    },
  });

  assert.deepEqual(spec, {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: [
      "/d",
      "/c",
      "start",
      "",
      "/d",
      "C:\\work\\agent-team",
      "C:\\Windows\\System32\\cmd.exe",
      "/d",
      "/s",
      "/k",
      "opencode attach http://127.0.0.1:4310 --session session-1",
    ],
    cwd: "C:\\work\\agent-team",
  });
});

test("buildTerminalLaunchSpec supports a PowerShell fallback launcher on Windows", () => {
  const spec = buildTerminalLaunchSpec({
    cwd: "C:\\work\\agent-team",
    command: "opencode attach http://127.0.0.1:4310 --session session-1",
    platform: "win32",
    env: {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      AGENT_TEAM_WINDOWS_TERMINAL: "powershell",
    },
  });

  assert.deepEqual(spec, {
    command: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Start-Process -WorkingDirectory 'C:\\work\\agent-team' -FilePath 'powershell.exe' -ArgumentList @('-NoExit', '-Command', 'opencode attach http://127.0.0.1:4310 --session session-1')",
    ],
    cwd: "C:\\work\\agent-team",
  });
});

test("buildTerminalLaunchSpec still avoids a plain bare start target path on Windows", () => {
  const spec = buildTerminalLaunchSpec({
    cwd: "C:\\work\\agent-team",
    command: "opencode attach http://127.0.0.1:4310 --session session-1",
    platform: "win32",
    env: {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    },
  });

  assert.match(
    spec.args.join("\n"),
    /^\/d\n\/c\nstart\n\n\/d\nC:\\work\\agent-team\nC:\\Windows\\System32\\cmd\.exe\n\/d\n\/s\n\/k/m,
  );
  assert.equal(spec.args[3], "");
});

test("buildTerminalLaunchSpec keeps the inner attach command clean on Windows", () => {
  const spec = buildTerminalLaunchSpec({
    cwd: "C:\\work\\agent-team",
    command: "opencode attach http://127.0.0.1:4310 --session session-1",
    platform: "win32",
    env: {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    },
  });

  assert.match(
    spec.args[10] ?? "",
    /opencode attach http:\/\/127\.0\.0\.1:4310 --session session-1/,
  );
  assert.doesNotMatch(spec.args[10] ?? "", /pause >nul/);
  assert.doesNotMatch(spec.args[10] ?? "", /Attach command exited/);
});

test("buildTerminalLaunchSpec keeps the PowerShell fallback attach command clean on Windows", () => {
  const spec = buildTerminalLaunchSpec({
    cwd: "C:\\work\\agent-team",
    command: "opencode attach http://127.0.0.1:4310 --session session-1",
    platform: "win32",
    env: {
      AGENT_TEAM_WINDOWS_TERMINAL: "powershell",
    },
  });

  assert.equal(spec.command, "powershell.exe");
  assert.match(spec.args[5] ?? "", /Start-Process -WorkingDirectory 'C:\\work\\agent-team'/);
  assert.match(spec.args[5] ?? "", /-FilePath 'powershell\.exe'/);
  assert.match(spec.args[5] ?? "", /@\('-NoExit', '-Command', 'opencode attach http:\/\/127\.0\.0\.1:4310 --session session-1'\)/);
});

test("buildTerminalLaunchSpec prefers the ComSpec cmd path on Windows", () => {
  const spec = buildTerminalLaunchSpec({
    cwd: "C:\\work\\agent-team",
    command: "opencode attach http://127.0.0.1:4310 --session session-1",
    platform: "win32",
    env: {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    },
  } as never);

  assert.equal(spec.command, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(spec.args[6], "C:\\Windows\\System32\\cmd.exe");
});

test("buildTerminalLaunchSpec opens a single Terminal attach window on macOS", () => {
  const spec = buildTerminalLaunchSpec({
    cwd: "/tmp/agent team",
    command: 'opencode attach "http://127.0.0.1:4310" --session "session-1"',
    platform: "darwin",
  });

  assert.deepEqual(spec, {
    command: "osascript",
    args: [
      "-e",
      'if application "Terminal" is running then',
      "-e",
      'tell application "Terminal" to do script "opencode attach \\"http://127.0.0.1:4310\\" --session \\"session-1\\""',
      "-e",
      "else",
      "-e",
      'tell application "Terminal"',
      "-e",
      "activate",
      "-e",
      "repeat until (count of windows) > 0",
      "-e",
      "delay 0.05",
      "-e",
      "end repeat",
      "-e",
      'set attachTab to do script "opencode attach \\"http://127.0.0.1:4310\\" --session \\"session-1\\"" in window 1',
      "-e",
      "set selected tab of window 1 to attachTab",
      "-e",
      "end tell",
      "-e",
      "end if",
      "-e",
      'tell application "Terminal" to activate',
    ],
    cwd: "/tmp/agent team",
  });
});

test("buildTerminalLaunchSpec focuses the attach tab on first macOS launch", () => {
  const spec = buildTerminalLaunchSpec({
    cwd: "/tmp/agent team",
    command: 'opencode attach "http://127.0.0.1:4310" --session "session-1"',
    platform: "darwin",
  });

  assert.match(
    spec.args.join("\n"),
    /set attachTab to do script "opencode attach \\"http:\/\/127\.0\.0\.1:4310\\" --session \\"session-1\\"" in window 1/,
  );
  assert.match(spec.args.join("\n"), /set selected tab of window 1 to attachTab/);
});

test("buildTerminalLaunchSpec uses the system terminal on Linux", () => {
  const spec = buildTerminalLaunchSpec({
    cwd: "/tmp/agent-team",
    command: 'opencode attach "http://127.0.0.1:4310" --session "session-1"',
    platform: "linux",
  });

  assert.deepEqual(spec, {
    command: "x-terminal-emulator",
    args: [
      "-e",
      "/bin/sh",
      "-lc",
      'opencode attach "http://127.0.0.1:4310" --session "session-1"',
    ],
    cwd: "/tmp/agent-team",
  });
});
