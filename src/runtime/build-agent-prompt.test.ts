import test from "node:test";
import assert from "node:assert/strict";

import { buildAgentSystemPrompt } from "./agent-system-prompt";
import { buildSubmitMessageBody } from "./opencode-request-body";
import {
  DECISION_COMPLETE_LABEL,
  DECISION_CONTINUE_LABEL,
} from "../shared/decision-response";

test("Decision agents keep the response contract in the system prompt", () => {
  const prompt = buildAgentSystemPrompt();

  assert.doesNotMatch(prompt, /\[From BA Agent\]/);
  assert.doesNotMatch(prompt, /\[@/);
  assert.match(
    prompt,
    new RegExp(DECISION_CONTINUE_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.match(
    prompt,
    new RegExp(DECISION_COMPLETE_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("Build agent request body omits system", () => {
  const body = buildSubmitMessageBody({
    agent: "Build",
    content: "Implement feature",
  });

  assert.equal("system" in body, false);
  assert.equal(body["agent"], "build");
});

test("Decision agent request body keeps system", () => {
  const body = buildSubmitMessageBody({
    agent: "TaskReview",
    content: "Decision the delivery",
    system: buildAgentSystemPrompt(),
  });

  assert.equal(typeof body["system"], "string");
  assert.doesNotMatch(String(body["system"]), /\[From Build Agent\]/);
  assert.match(
    String(body["system"]),
    new RegExp(DECISION_CONTINUE_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.match(
    String(body["system"]),
    new RegExp(DECISION_COMPLETE_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("Decision agents build a system prompt", () => {
  const systemPrompt = buildAgentSystemPrompt();

  assert.equal(typeof systemPrompt, "string");
  assert.doesNotMatch(String(systemPrompt), /\[From Build Agent\]/);
});
