import test from "node:test";
import assert from "node:assert/strict";

import { buildAgentPromptDialogState } from "./agent-prompt-dialog";

test("buildAgentPromptDialogState 会为普通 agent 返回 prompt 详情", () => {
  assert.deepEqual(
    buildAgentPromptDialogState({
      agentId: "CodeReview",
      prompt: "你负责审查代码改动。",
    }),
    {
      agentId: "CodeReview",
      promptSourceLabel: "System Prompt",
      content: "你负责审查代码改动。",
    },
  );
});

test("buildAgentPromptDialogState 会为 Build 返回 opencode 加载提示", () => {
  assert.deepEqual(
    buildAgentPromptDialogState({
      agentId: "Build",
      prompt: "",
    }),
    {
      agentId: "Build",
      promptSourceLabel: "OpenCode 加载",
      content: "Prompt为空或者由opencode加载",
    },
  );
});

test("buildAgentPromptDialogState 会为普通 agent 的空 prompt 返回 opencode 加载提示", () => {
  assert.deepEqual(
    buildAgentPromptDialogState({
      agentId: "CodeReview",
      prompt: "",
    }),
    {
      agentId: "CodeReview",
      promptSourceLabel: "OpenCode 加载",
      content: "Prompt为空或者由opencode加载",
    },
  );
});
