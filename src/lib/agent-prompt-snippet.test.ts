import test from "node:test";
import assert from "node:assert/strict";

import { buildAgentPromptSnippetText } from "./agent-prompt-snippet";

test("buildAgentPromptSnippetText 会在 Build prompt 为空时返回 opencode 加载提示", () => {
  assert.equal(
    buildAgentPromptSnippetText({
      agentId: "Build",
      prompt: "",
    }),
    "Prompt为空或者由opencode加载",
  );
});

test("buildAgentPromptSnippetText 会在普通 agent prompt 为空时也返回 opencode 加载提示", () => {
  assert.equal(
    buildAgentPromptSnippetText({
      agentId: "CodeReview",
      prompt: "",
    }),
    "Prompt为空或者由opencode加载",
  );
});
