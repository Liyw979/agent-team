import test from "node:test";
import assert from "node:assert/strict";

import { buildAgentSystemPrompt } from "./agent-system-prompt";
import { buildMockAgentReply } from "./mock-agent-reply";
import { buildSubmitMessageBody } from "./opencode-request-body";

test("Build agent 完全不注入 system prompt", () => {
  const prompt = buildAgentSystemPrompt({
    name: "Build",
  }, false);

  assert.equal(prompt, "");
});

test("存在审视边的 agent 才注入 DECISION 协议", () => {
  const prompt = buildAgentSystemPrompt({
    name: "TaskReview",
  }, true);

  assert.match(prompt, /【DECISION】检查通过/);
  assert.match(prompt, /【DECISION】需要修改/);
});

test("没有审视边的 agent 不注入 system prompt", () => {
  const prompt = buildAgentSystemPrompt({
    name: "BA",
  }, false);

  assert.equal(prompt, "");
});

test("mock 模式下 Build agent 回复不再伪造已完成决策块", () => {
  const reply = buildMockAgentReply("Build", "请实现功能并自检");

  assert.doesNotMatch(reply, /【DECISION】已完成/);
  assert.match(reply, /我已完成主要实现与本地自检/);
});

test("mock 模式下 BA 回复不再伪造审视决策块", () => {
  const reply = buildMockAgentReply("BA", "请整理需求");

  assert.doesNotMatch(reply, /【DECISION】/);
  assert.match(reply, /目标、范围、约束与验收标准/);
});

test("Build agent 的请求体不会携带 system 字段", () => {
  const body = buildSubmitMessageBody({
    agent: "Build",
    content: "请实现功能",
    system: buildAgentSystemPrompt({
      name: "Build",
    }, false),
  });

  assert.equal("system" in body, false);
  assert.equal(body.agent, "build");
});

test("存在审视边的 agent 请求体继续携带 system 字段", () => {
  const body = buildSubmitMessageBody({
    agent: "TaskReview",
    content: "请审视交付结果",
    system: buildAgentSystemPrompt({
      name: "TaskReview",
    }, true),
  });

  assert.equal(typeof body.system, "string");
  assert.match(String(body.system), /【DECISION】检查通过/);
});
