import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBrowserOpenSpec,
  buildUiUrl,
} from "./ui-host-launch";

test("buildUiUrl 只把 taskId 编进浏览器 URL，不再暴露 cwd", () => {
  assert.equal(
    buildUiUrl({
      port: 4310,
      taskId: "task 123",
    }),
    "http://127.0.0.1:4310/?taskId=task+123",
  );
});

test("buildBrowserOpenSpec 在 Windows 使用 start 打开浏览器", () => {
  const spec = buildBrowserOpenSpec({
    url: "http://127.0.0.1:4310/?taskId=task-123",
    platform: "win32",
  });

  assert.equal(spec.command, "cmd.exe");
  assert.deepEqual(spec.args, [
    "/d",
    "/s",
    "/c",
    "start",
    "",
    "\"http://127.0.0.1:4310/?taskId=task-123\"",
  ]);
});

test("buildBrowserOpenSpec 在 macOS 与 Linux 使用系统默认浏览器命令", () => {
  assert.deepEqual(
    buildBrowserOpenSpec({
      url: "http://127.0.0.1:4310/",
      platform: "darwin",
    }),
    {
      command: "open",
      args: ["http://127.0.0.1:4310/"],
    },
  );

  assert.deepEqual(
    buildBrowserOpenSpec({
      url: "http://127.0.0.1:4310/",
      platform: "linux",
    }),
    {
      command: "xdg-open",
      args: ["http://127.0.0.1:4310/"],
    },
  );
});
