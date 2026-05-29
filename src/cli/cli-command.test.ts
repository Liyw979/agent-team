import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  buildCliHelpText,
  isCliCommandNameSupported,
  parseCliCommand,
} from "./cli-command";

test("parseCliCommand 不再接受 task show", () => {
  assert.throws(() => parseCliCommand([
    "task",
    "show",
    "task-1",
  ]));
});

test("parseCliCommand 不再接受 task chat", () => {
  assert.throws(() => parseCliCommand([
    "task",
    "chat",
    "--task",
    "task-1",
    "--message",
    "@BA 继续推进",
  ]));
});

test("parseCliCommand 解析 task ui 新建任务", () => {
  const parsed = parseCliCommand([
    "task",
    "ui",
    "--file",
    "config/team-topologies/development-team.topology.yaml",
    "--message",
    "请开始执行",
    "--cwd",
    "/tmp/project",
  ]);

  assert.deepEqual(parsed, {
    kind: "task.ui",
    cmd: "opencode",
    file: "config/team-topologies/development-team.topology.yaml",
    message: "请开始执行",
    cwd: "/tmp/project",
  });
});

test("parseCliCommand 接受 .yaml 拓扑文件路径", () => {
  const parsed = parseCliCommand([
    "task",
    "ui",
    "--file",
    "config/team-topologies/development-team.topology.yaml",
    "--message",
    "请开始执行",
  ]);

  assert.deepEqual(parsed, {
    kind: "task.ui",
    cmd: "opencode",
    cwd: "",
    file: "config/team-topologies/development-team.topology.yaml",
    message: "请开始执行",
  });
});

test("parseCliCommand 不再接受 task ui --task 恢复已有任务", () => {
  assert.throws(() => parseCliCommand([
    "task",
    "ui",
    "--task",
    "task-1",
    "--cwd",
    "/tmp/project",
  ]));
});

test("parseCliCommand 不再接受 task ui 的位置参数 taskId", () => {
  assert.throws(() => parseCliCommand([
    "task",
    "ui",
    "task-1",
  ]));
});

test("parseCliCommand 允许 task ui 单独接收 --cwd", () => {
  const parsed = parseCliCommand([
    "task",
    "ui",
    "--cwd",
    "/tmp/project",
    "--file",
    "config/team-topologies/development-team.topology.yaml",
    "--message",
    "请开始执行",
  ]);

  assert.deepEqual(parsed, {
    kind: "task.ui",
    cmd: "opencode",
    file: "config/team-topologies/development-team.topology.yaml",
    message: "请开始执行",
    cwd: "/tmp/project",
  });
});

test("parseCliCommand 解析 task ui 的 --cmd", () => {
  const parsed = parseCliCommand([
    "task",
    "ui",
    "--cmd",
    "nga",
    "--file",
    "config/team-topologies/development-team.topology.yaml",
    "--message",
    "请开始执行",
  ]);

  assert.deepEqual(parsed, {
    kind: "task.ui",
    cmd: "nga",
    cwd: "",
    file: "config/team-topologies/development-team.topology.yaml",
    message: "请开始执行",
  });
});

test("isCliCommandNameSupported 只接受单个命令名允许字符", () => {
  assert.equal(isCliCommandNameSupported("nga"), true);
  assert.equal(isCliCommandNameSupported("nga-dev"), true);
  assert.equal(isCliCommandNameSupported("/usr/local/bin/nga"), true);
  assert.equal(isCliCommandNameSupported("nga dev"), false);
  assert.equal(isCliCommandNameSupported("echo&&id"), false);
  assert.equal(isCliCommandNameSupported("echo;id"), false);
  assert.equal(isCliCommandNameSupported("$(id)"), false);
  assert.equal(isCliCommandNameSupported("  "), false);
});

test("parseCliCommand 不再接受 task attach", () => {
  assert.throws(() => parseCliCommand([
    "task",
    "attach",
    "task-1",
    "Build",
  ]));
});

test("旧 task run 与旧 --ui 入口都会被拒绝", () => {
  assert.throws(() => parseCliCommand([
    "task",
    "run",
    "--file",
    "config/team-topologies/development-team.topology.yaml",
    "--message",
    "请开始执行",
  ]));
  assert.throws(() => parseCliCommand([
    "task",
    "show",
    "task-1",
    "--ui",
  ]));
});

test("Commander help 只展示保留的 task ui 命令", () => {
  const help = buildCliHelpText();

  assert.match(help, /Commands:\n\s+task/u);
  assert.match(help, /task ui --file <topology-file> --message <message>/u);
  assert.match(help, /--cmd <command>/u);
  assert.doesNotMatch(help, /headless/u);
  assert.doesNotMatch(help, /task attach/u);
  assert.doesNotMatch(help, /task show/u);
  assert.doesNotMatch(help, /task chat/u);
  assert.doesNotMatch(help, /task run/u);
  assert.doesNotMatch(help, /dsl run/u);
  assert.doesNotMatch(help, /agent attach/u);
});
