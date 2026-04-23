import assert from "node:assert/strict";
import test from "node:test";

import { resolveTaskSubmissionTarget } from "./task-submission";

test("未显式 @Agent 时默认投递给 start node", () => {
  const resolution = resolveTaskSubmissionTarget({
    content: "请直接实现功能",
    availableAgents: ["BA", "Build", "TaskReview"],
    defaultTargetAgentId: "BA",
  });

  assert.deepEqual(resolution, {
    ok: true,
    targetAgentId: "BA",
  });
});

test("显式 @Agent 时仍然从该 Agent 开始，而不是回退到 start node", () => {
  const resolution = resolveTaskSubmissionTarget({
    content: "@TaskReview 请直接验收",
    availableAgents: ["BA", "Build", "TaskReview"],
    defaultTargetAgentId: "BA",
  });

  assert.deepEqual(resolution, {
    ok: true,
    targetAgentId: "TaskReview",
  });
});

test("显式 mentionAgentId 字段按 Agent ID 寻址且输出 targetAgentId", () => {
  const resolution = resolveTaskSubmissionTarget({
    content: "请直接验收",
    availableAgents: ["BA", "Build", "TaskReview"],
    defaultTargetAgentId: "BA",
    mentionAgentId: "TaskReview",
  });

  assert.deepEqual(resolution, {
    ok: true,
    targetAgentId: "TaskReview",
  });
  const legacyTargetKey = ["target", "Agent"].join("");
  assert.equal(Object.prototype.hasOwnProperty.call(resolution, legacyTargetKey), false);
});

test("缺少 Build 时仍允许显式 @ 非 Build Agent 发送消息", () => {
  const resolution = resolveTaskSubmissionTarget({
    content: "@BA 请先整理需求",
    availableAgents: ["BA"],
  });

  assert.deepEqual(resolution, {
    ok: true,
    targetAgentId: "BA",
  });
});

test("缺少 Build 但存在 start node 时，未显式 @ 任何 Agent 仍然默认投递给 start node", () => {
  const resolution = resolveTaskSubmissionTarget({
    content: "请先整理需求",
    availableAgents: ["BA"],
    defaultTargetAgentId: "BA",
  });

  assert.deepEqual(resolution, {
    ok: true,
    targetAgentId: "BA",
  });
});

test("未显式 @ 且当前拓扑缺少 start node 时，必须明确报错", () => {
  const resolution = resolveTaskSubmissionTarget({
    content: "请先整理需求",
    availableAgents: ["BA"],
  });

  assert.deepEqual(resolution, {
    ok: false,
    code: "missing_start_agent",
    message: "当前拓扑缺少 start node，请使用 @ 指定一个已写入 Agent 后再发送。",
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
