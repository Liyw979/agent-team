import test from "node:test";
import assert from "node:assert/strict";

import { buildAgentSystemPrompt } from "./agent-system-prompt";
import { buildSubmitMessageBody } from "./opencode-request-body";
import {
  REVIEW_COMPLETE_LABEL,
  REVIEW_CONTINUE_LABEL,
} from "../shared/review-response";

test("Build agent does not inject a system prompt", () => {
  const prompt = buildAgentSystemPrompt({
    name: "Build",
  }, false);

  assert.equal(prompt, "");
});

test("Review agents keep the response contract in the system prompt", () => {
  const prompt = buildAgentSystemPrompt({
    name: "TaskReview",
  }, true, "[From BA Agent]");

  assert.match(prompt, /`\[From BA Agent\]`/);
  assert.doesNotMatch(prompt, /\[@/);
  assert.match(
    prompt,
    new RegExp(REVIEW_CONTINUE_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.match(
    prompt,
    new RegExp(REVIEW_COMPLETE_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("Non-review agents do not inject a system prompt", () => {
  const prompt = buildAgentSystemPrompt({
    name: "BA",
  }, false);

  assert.equal(prompt, "");
});

test("Build agent request body omits system", () => {
  const body = buildSubmitMessageBody({
    agent: "Build",
    content: "Implement feature",
    system: buildAgentSystemPrompt({
      name: "Build",
    }, false),
  });

  assert.equal("system" in body, false);
  assert.equal(body["agent"], "build");
});

test("Review agent request body keeps system", () => {
  const body = buildSubmitMessageBody({
    agent: "TaskReview",
    content: "Review the delivery",
    system: buildAgentSystemPrompt({
      name: "TaskReview",
    }, true, "[From Build Agent]"),
  });

  assert.equal(typeof body["system"], "string");
  assert.match(String(body["system"]), /\[From Build Agent\]/);
  assert.match(
    String(body["system"]),
    new RegExp(REVIEW_CONTINUE_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.match(
    String(body["system"]),
    new RegExp(REVIEW_COMPLETE_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});
