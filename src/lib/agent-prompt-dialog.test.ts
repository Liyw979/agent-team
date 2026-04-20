import test from "node:test";
import assert from "node:assert/strict";

import { buildAgentPromptDialogState } from "./agent-prompt-dialog";

test("buildAgentPromptDialogState 会为普通 agent 返回 prompt 详情", () => {
  assert.deepEqual(
    buildAgentPromptDialogState({
      agentName: "CodeReview",
      prompt: "你负责审查代码改动。",
    }),
    {
      agentName: "CodeReview",
      promptSourceLabel: "System Prompt",
      content: "你负责审查代码改动。",
    },
  );
});

test("buildAgentPromptDialogState 会为 Build 返回内置 prompt 说明", () => {
  assert.deepEqual(
    buildAgentPromptDialogState({
      agentName: "Build",
      prompt: "",
    }),
    {
      agentName: "Build",
      promptSourceLabel: "OpenCode 内置",
      content: "当前 Agent 使用 OpenCode 内置 prompt，运行时不会在工作区拓扑里展开具体正文。",
    },
  );
});
