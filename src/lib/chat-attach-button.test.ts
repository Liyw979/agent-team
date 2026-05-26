import { test } from "bun:test";
import assert from "node:assert/strict";
import { resolveChatMessageAttachButtonState } from "./chat-attach-button";

test("resolveChatMessageAttachButtonState 会为 agent 消息生成可点击的 attach 状态", () => {
  const state = resolveChatMessageAttachButtonState({
    sender: "误报论证-3",
    taskAgents: [
      {
        id: "误报论证-3",
        opencodeSessionId: "session-3",
      },
    ],
  });

  assert.deepEqual(state, {
    visible: true,
    agentId: "误报论证-3",
    disabled: false,
    title: "attach 到 误报论证-3",
    label: "attach",
  });
});

test("resolveChatMessageAttachButtonState 会在 session 缺失时保留禁用态文案", () => {
  const state = resolveChatMessageAttachButtonState({
    sender: "误报论证-3",
    taskAgents: [
      {
        id: "误报论证-3",
        opencodeSessionId: "",
      },
    ],
  });

  assert.deepEqual(state, {
    visible: true,
    agentId: "误报论证-3",
    disabled: true,
    title: "误报论证-3 当前还没有可 attach 的 OpenCode session。",
    label: "attach",
  });
});

test("resolveChatMessageAttachButtonState 不会给 user 或 system 消息渲染 attach", () => {
  assert.equal(resolveChatMessageAttachButtonState({
    sender: "user",
    taskAgents: [],
  }), false);

  assert.equal(resolveChatMessageAttachButtonState({
    sender: "system",
    taskAgents: [],
  }), false);
});
