import { test } from "bun:test";
import assert from "node:assert/strict";
import type * as childProcess from "node:child_process";

import { ensureOpencodePreflightPassed } from "./opencode-preflight";

test("ensureOpencodePreflightPassed 使用传入命令名执行 --help", async () => {
  let receivedCommand = "";
  let receivedArgs: string[] = [];

  await ensureOpencodePreflightPassed(
    "nga",
    ((command: string, args: readonly string[]) => {
      receivedCommand = command;
      receivedArgs = [...args];
      return {
        status: 0,
        stdout: "",
        stderr: "",
      };
    }) as unknown as typeof childProcess.spawnSync,
  );

  assert.equal(receivedCommand, "nga");
  assert.deepEqual(receivedArgs, ["--help"]);
});

test("ensureOpencodePreflightPassed 失败时返回带命令名的错误信息", async () => {
  await assert.rejects(
    ensureOpencodePreflightPassed(
      "nga",
      (() => ({
        status: 1,
        stdout: "",
        stderr: "boom",
      })) as unknown as typeof childProcess.spawnSync,
    ),
    /`nga --help` 执行失败（boom），说明 nga 无法正常使用，无法启动本应用/u,
  );
});
