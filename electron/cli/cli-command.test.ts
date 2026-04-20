import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import { parseCliCommand } from "./cli-command";

const CLI_SOURCE = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("parseCliCommand 解析新建 task run", () => {
  const parsed = parseCliCommand([
    "task",
    "run",
    "--file",
    "config/team-topologies/development-team.topology.json",
    "--message",
    "请开始执行",
    "--ui",
    "--cwd",
    "/tmp/project",
  ]);

  assert.deepEqual(parsed, {
    kind: "task.run",
    file: "config/team-topologies/development-team.topology.json",
    message: "请开始执行",
    ui: true,
    cwd: "/tmp/project",
  });
});

test("parseCliCommand 解析 task show", () => {
  const parsed = parseCliCommand([
    "task",
    "show",
    "task-1",
    "--ui",
  ]);

  assert.deepEqual(parsed, {
    kind: "task.show",
    taskId: "task-1",
    ui: true,
  });
});

test("parseCliCommand 解析 task chat", () => {
  const parsed = parseCliCommand([
    "task",
    "chat",
    "--task",
    "task-1",
    "--message",
    "@BA 继续推进",
  ]);

  assert.deepEqual(parsed, {
    kind: "task.chat",
    taskId: "task-1",
    message: "@BA 继续推进",
    file: undefined,
    ui: false,
    cwd: undefined,
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

test("Commander help 包含 task run/task show/task chat/task attach 命令", () => {
  assert.match(CLI_SOURCE, /task run --file <topology-json> --message <message>/);
  assert.match(CLI_SOURCE, /task show <taskId>/);
  assert.match(CLI_SOURCE, /task chat --file <topology-json> --message <message>/);
  assert.match(CLI_SOURCE, /task attach <agentName>/);
  assert.doesNotMatch(CLI_SOURCE, /task run --task <taskId>/);
  assert.doesNotMatch(CLI_SOURCE, /attach <taskId> <agentName>/);
  assert.doesNotMatch(CLI_SOURCE, /task attach-agent <taskId> <agentName>/);
  assert.doesNotMatch(CLI_SOURCE, /dsl run --file <dsl-file>/);
  assert.doesNotMatch(CLI_SOURCE, /agent attach <agentName>/);
});
