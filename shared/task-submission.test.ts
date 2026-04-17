import assert from "node:assert/strict";
import test from "node:test";

import { resolveTaskSubmissionTarget } from "./task-submission";

test("未显式 @Agent 时默认投递给 Build", () => {
  const resolution = resolveTaskSubmissionTarget({
    content: "请直接实现功能",
    availableAgents: ["BA", "Build", "TaskReview"],
  });

  assert.deepEqual(resolution, {
    ok: true,
    targetAgent: "Build",
  });
});

test("缺少 Build 时仍允许显式 @ 非 Build Agent 发送消息", () => {
  const resolution = resolveTaskSubmissionTarget({
    content: "@BA 请先整理需求",
    availableAgents: ["BA"],
  });

  assert.deepEqual(resolution, {
    ok: true,
    targetAgent: "BA",
  });
});

test("缺少 Build 且未显式 @ 任何 Agent 时，必须提示用户先指定目标 Agent", () => {
  const resolution = resolveTaskSubmissionTarget({
    content: "请先整理需求",
    availableAgents: ["BA"],
  });

  assert.deepEqual(resolution, {
    ok: false,
    code: "missing_build_agent",
    message: "当前 Project 缺少 Build Agent，请使用 @ 指定一个已写入 Agent 后再发送。",
  });
});

test("缺少 Build 时，显式 @Build 仍然必须被拒绝", () => {
  const resolution = resolveTaskSubmissionTarget({
    content: "@Build 请实现功能",
    availableAgents: ["BA"],
  });

  assert.deepEqual(resolution, {
    ok: false,
    code: "missing_target_agent",
    message: "当前 Project 尚未写入 Build Agent，@Build 不可用。",
  });
});
