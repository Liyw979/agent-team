import test from "node:test";
import assert from "node:assert/strict";

import { buildAgentPromptPreviewText } from "./agent-prompt-preview";

test("buildAgentPromptPreviewText 会在 Build prompt 为空时返回 opencode 加载提示", () => {
  assert.equal(
    buildAgentPromptPreviewText({
      agentId: "Build",
      prompt: "",
    }),
    "Prompt为空或者由opencode加载",
  );
});

test("buildAgentPromptPreviewText 会在普通 agent prompt 为空时也返回 opencode 加载提示", () => {
  assert.equal(
    buildAgentPromptPreviewText({
      agentId: "CodeReview",
      prompt: "",
    }),
    "Prompt为空或者由opencode加载",
  );
});
