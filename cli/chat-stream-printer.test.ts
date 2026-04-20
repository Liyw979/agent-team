import assert from "node:assert/strict";
import test from "node:test";

import type { MessageRecord } from "@shared/types";
import {
  collectIncrementalChatTranscript,
  renderChatStreamEntries,
  measureDisplayWidth,
} from "./chat-stream-printer";

function createMessage(input: {
  id: string;
  sender: string;
  timestamp: string;
  content: string;
  meta?: Record<string, string>;
}): MessageRecord {
  return {
    id: input.id,
    projectId: "project-1",
    taskId: "task-1",
    sender: input.sender,
    timestamp: input.timestamp,
    content: input.content,
    meta: input.meta,
  };
}

test("collectIncrementalChatTranscript 只返回新增的群聊合并消息", () => {
  const previous = [
    createMessage({
      id: "m1",
      sender: "user",
      timestamp: "2026-04-19T10:00:00.000Z",
      content: "@Build 请实现 DSL",
    }),
  ];
  const next = [
    ...previous,
    createMessage({
      id: "m2",
      sender: "Build",
      timestamp: "2026-04-19T10:00:01.000Z",
      content: "已完成首轮实现。",
      meta: {
        kind: "agent-final",
      },
    }),
    createMessage({
      id: "m3",
      sender: "Build",
      timestamp: "2026-04-19T10:00:02.000Z",
      content: "",
      meta: {
        kind: "agent-dispatch",
        targetAgentIds: "CodeReview",
      },
    }),
  ];

  const entries = collectIncrementalChatTranscript(previous, next);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.sender, "Build");
  assert.match(entries[0]?.content ?? "", /@CodeReview/);
});

test("collectIncrementalChatTranscript 在没有新增群聊消息时返回空数组", () => {
  const messages = [
    createMessage({
      id: "m1",
      sender: "system",
      timestamp: "2026-04-19T10:00:00.000Z",
      content: "Task 已创建并完成初始化",
    }),
  ];

  assert.deepEqual(collectIncrementalChatTranscript(messages, messages), []);
});

test("renderChatStreamEntries 输出的是群聊文本，不包含 agent runtime 历史字段", () => {
  const output = renderChatStreamEntries([
    {
      id: "m1",
      sender: "Build",
      timestamp: "2026-04-19T10:00:00.000Z",
      content: "Build 已完成。\n\n@CodeReview",
      kinds: ["agent-final", "agent-dispatch"],
      metaChain: [
        { kind: "agent-final" },
        { kind: "agent-dispatch", targetAgentIds: "CodeReview" },
      ],
    },
  ]);

  assert.match(output, /\[2026\/04\/19/);
  assert.match(output, /Build/);
  assert.match(output, /@CodeReview/);
  assert.match(output, /┌ \[\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\] Build ─+/);
  assert.match(output, /└/);
  assert.doesNotMatch(output, /│\s*│\n│ {4}Build 已完成。/);
  assert.match(output, /│ {4}Build 已完成。/);
  assert.match(output, /│ {4}@CodeReview/);
  assert.doesNotMatch(output, /tool|thinking|step|activeToolNames/i);
});

test("renderChatStreamEntries 的标题左对齐，正文上下不保留空白 padding", () => {
  const output = renderChatStreamEntries([
    {
      id: "m3",
      sender: "user",
      timestamp: "2026-04-20T01:47:01.000Z",
      content: "入口应该是ba啊",
      kinds: ["user"],
      metaChain: [{ kind: "user" }],
    },
  ]);

  assert.match(output, /┌ \[\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\] user ─+/);
  assert.doesNotMatch(output, /┌[^\n]+\n│\s*│\n│ {4}入口应该是ba啊/);
  assert.doesNotMatch(output, /│ {4}入口应该是ba啊\n│\s*│\n└/);
  assert.match(output, /│ {4}入口应该是ba啊/);
});

test("renderChatStreamEntries 不再输出状态行样式文本", () => {
  const output = renderChatStreamEntries([
    {
      id: "m2",
      sender: "system",
      timestamp: "2026-04-19T10:00:03.000Z",
      content: "所有Agent任务已完成",
      kinds: ["system"],
      metaChain: [{ kind: "task-status" }],
    },
  ]);

  assert.doesNotMatch(output, /\[状态\]\s*(pending|running|waiting|finished|failed)/);
});

test("measureDisplayWidth 会把中文按终端双列宽处理，避免消息框右边界错位", () => {
  assert.equal(measureDisplayWidth("Build"), 5);
  assert.equal(measureDisplayWidth("可以。"), 6);
  assert.equal(measureDisplayWidth("你想把这轮协作测试聚焦在哪一类任务上？"), 38);
});
