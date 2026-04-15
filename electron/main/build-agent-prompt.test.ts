import test from "node:test";
import assert from "node:assert/strict";

import { buildAgentSystemPrompt } from "./agent-system-prompt";
import { buildMockAgentReply } from "./mock-agent-reply";
import { buildSubmitMessageBody } from "./opencode-request-body";
import { REVIEW_RESPONSE_LABEL } from "../../shared/review-response";

test("Build agent 完全不注入 system prompt", () => {
  const prompt = buildAgentSystemPrompt({
    name: "Build",
  }, false);

  assert.equal(prompt, "");
});

test("存在审视边的 agent 才注入回应协议", () => {
  const prompt = buildAgentSystemPrompt({
    name: "TaskReview",
  }, true, "[From BA Agent]");

  assert.match(prompt, /你需要对 `\[From BA Agent\]` 做出回应。/);
  assert.doesNotMatch(prompt, /\[@来源 Agent Message\]/);
  assert.match(prompt, /<revision_request>/);
  assert.doesNotMatch(prompt, /下一个 Agent/);
});

test("没有审视边的 agent 不注入 system prompt", () => {
  const prompt = buildAgentSystemPrompt({
    name: "BA",
  }, false);

  assert.equal(prompt, "");
});

test("mock 模式下 Build agent 回复不再伪造已完成决策块", () => {
  const reply = buildMockAgentReply("Build", "请实现功能并自检");

  assert.doesNotMatch(reply, /回应：/);
  assert.doesNotMatch(reply, /<revision_request>/);
  assert.match(reply, /我已完成主要实现与本地自检/);
});

test("mock 模式下 BA 回复不再伪造审视决策块", () => {
  const reply = buildMockAgentReply("BA", "请整理需求");

  assert.doesNotMatch(reply, /回应：/);
  assert.doesNotMatch(reply, /<revision_request>/);
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
    }, true, "[From Build Agent]"),
  });

  assert.equal(typeof body.system, "string");
  assert.match(String(body.system), /\[From Build Agent\]/);
  assert.match(
    String(body.system),
    new RegExp(REVIEW_RESPONSE_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});
