import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import { parseCliCommand } from "./cli-command";

const CLI_SOURCE = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("parseCliCommand 解析新建 task headless", () => {
  const parsed = parseCliCommand([
    "task",
    "headless",
    "--file",
    "config/team-topologies/development-team.topology.json",
    "--message",
    "请开始执行",
    "--cwd",
    "/tmp/project",
  ]);

  assert.deepEqual(parsed, {
    kind: "task.headless",
    file: "config/team-topologies/development-team.topology.json",
    message: "请开始执行",
    cwd: "/tmp/project",
  });
});

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
    "config/team-topologies/development-team.topology.json",
    "--message",
    "请开始执行",
    "--cwd",
    "/tmp/project",
  ]);

  assert.deepEqual(parsed, {
    kind: "task.ui",
    file: "config/team-topologies/development-team.topology.json",
    message: "请开始执行",
    cwd: "/tmp/project",
    taskId: undefined,
  });
});

test("parseCliCommand 解析 task ui 恢复已有任务", () => {
  const parsed = parseCliCommand([
    "task",
    "ui",
    "--task",
    "task-1",
    "--cwd",
    "/tmp/project",
  ]);

  assert.deepEqual(parsed, {
    kind: "task.ui",
    taskId: "task-1",
    cwd: "/tmp/project",
    file: undefined,
    message: undefined,
  });
});

test("parseCliCommand 解析 task attach", () => {
  const parsed = parseCliCommand([
    "task",
    "attach",
    "Build",
    "--print-only",
    "--cwd",
    "/tmp/project",
  ]);

  assert.deepEqual(parsed, {
    kind: "task.attach",
    agentName: "Build",
    printOnly: true,
    cwd: "/tmp/project",
  });
});

test("旧 task run 与旧 --ui 入口都会被拒绝", () => {
  assert.throws(() => parseCliCommand([
    "task",
    "run",
    "--file",
    "config/team-topologies/development-team.topology.json",
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

test("Commander help 包含 task headless/task ui/task attach 命令", () => {
  assert.match(CLI_SOURCE, /task headless --file <topology-json> --message <message>/);
  assert.match(CLI_SOURCE, /task ui --file <topology-json> --message <message>/);
  assert.match(CLI_SOURCE, /task ui --task <taskId>/);
  assert.match(CLI_SOURCE, /task attach <agentName>/);
  assert.doesNotMatch(CLI_SOURCE, /task run --file <topology-json> --message <message>/);
  assert.doesNotMatch(CLI_SOURCE, /task show <taskId>/);
  assert.doesNotMatch(CLI_SOURCE, /task chat --file <topology-json> --message <message>/);
  assert.doesNotMatch(CLI_SOURCE, /task chat --task <taskId>/);
  assert.doesNotMatch(CLI_SOURCE, /--ui/);
  assert.doesNotMatch(CLI_SOURCE, /attach <taskId> <agentName>/);
  assert.doesNotMatch(CLI_SOURCE, /task attach-agent <taskId> <agentName>/);
  assert.doesNotMatch(CLI_SOURCE, /dsl run --file <dsl-file>/);
  assert.doesNotMatch(CLI_SOURCE, /agent attach <agentName>/);
});
