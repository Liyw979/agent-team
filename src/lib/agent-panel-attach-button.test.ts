import test from "node:test";
import assert from "node:assert/strict";
import { buildAgentPanelAttachButtonState } from "./agent-panel-attach-button";

test("团队成员面板里有可 attach session 的按钮必须可见", () => {
  const result = buildAgentPanelAttachButtonState({
    agentName: "Build",
    hasSession: true,
    isOpening: false,
  });

  assert.equal(result.disabled, false);
  assert.equal(result.label, "attach");
  assert.match(result.className, /inline-flex/);
  assert.doesNotMatch(result.className, /\bsr-only\b/);
});
