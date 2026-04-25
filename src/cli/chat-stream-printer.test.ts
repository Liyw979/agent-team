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
  kind: MessageRecord["kind"];
  targetAgentIds?: string[];
  finishReason?: string;
}): MessageRecord {
  if (input.kind === "user") {
    return {
      id: input.id,
      taskId: "task-1",
      sender: "user",
      timestamp: input.timestamp,
      content: input.content,
      kind: "user",
      scope: "task",
      taskTitle: "demo",
      targetAgentIds: input.targetAgentIds ?? [],
    };
  }
  if (input.kind === "agent-final") {
    return {
      id: input.id,
      taskId: "task-1",
      sender: input.sender,
      timestamp: input.timestamp,
      content: input.content,
      kind: "agent-final",
      status: "completed",
      decision: "complete",
      decisionNote: "",
      rawResponse: input.content,
    };
  }
  if (input.kind === "agent-dispatch") {
    return {
      id: input.id,
      taskId: "task-1",
      sender: input.sender,
      timestamp: input.timestamp,
      content: input.content,
      kind: "agent-dispatch",
      targetAgentIds: input.targetAgentIds ?? [],
      dispatchDisplayContent: input.content,
    };
  }
  if (input.kind === "continue-request") {
    return {
      id: input.id,
      taskId: "task-1",
      sender: input.sender,
      timestamp: input.timestamp,
      content: input.content,
      kind: "continue-request",
      targetAgentIds: input.targetAgentIds ?? [],
    };
  }
  if (input.kind === "task-completed") {
    return {
      id: input.id,
      taskId: "task-1",
      sender: "system",
      timestamp: input.timestamp,
      content: input.content,
      kind: "task-completed",
      status: "failed",
    };
  }
  if (input.kind === "task-round-finished") {
    return {
      id: input.id,
      taskId: "task-1",
      sender: "system",
      timestamp: input.timestamp,
      content: input.content,
      kind: "task-round-finished",
      finishReason: input.finishReason ?? "round_finished",
    };
  }
  if (input.kind === "task-created") {
    return {
      id: input.id,
      taskId: "task-1",
      sender: "system",
      timestamp: input.timestamp,
      content: input.content,
      kind: "task-created",
    };
  }
  return {
    id: input.id,
    taskId: "task-1",
    sender: "system",
    timestamp: input.timestamp,
    content: input.content,
    kind: "system-message",
  };
}

test("collectIncrementalChatTranscript 只返回新增的群聊合并消息", () => {
  const previous = [
    createMessage({
      id: "m1",
      sender: "user",
      timestamp: "2026-04-19T10:00:00.000Z",
      content: "@Build 请实现 DSL",
      kind: "user",
      targetAgentIds: ["Build"],
    }),
  ];
  const next = [
    ...previous,
    createMessage({
      id: "m2",
      sender: "Build",
      timestamp: "2026-04-19T10:00:01.000Z",
      content: "已完成首轮实现。",
      kind: "agent-final",
    }),
    createMessage({
      id: "m3",
      sender: "Build",
      timestamp: "2026-04-19T10:00:02.000Z",
      content: "",
      kind: "agent-dispatch",
      targetAgentIds: ["CodeReview"],
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
      kind: "system-message",
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
      messageChain: [
        {
          id: "m1-final",
          taskId: "task-1",
          sender: "Build",
          timestamp: "2026-04-19T10:00:00.000Z",
          content: "Build 已完成。",
          kind: "agent-final",
          status: "completed",
          decision: "complete",
          decisionNote: "",
          rawResponse: "Build 已完成。",
        },
        {
          id: "m1-dispatch",
          taskId: "task-1",
          sender: "Build",
          timestamp: "2026-04-19T10:00:00.000Z",
          content: "@CodeReview",
          kind: "agent-dispatch",
          targetAgentIds: ["CodeReview"],
          dispatchDisplayContent: "@CodeReview",
        },
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
      messageChain: [],
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
      content: "本轮已完成，可继续 @Agent 发起下一轮。",
      kinds: ["system-message"],
      messageChain: [],
    },
  ]);

  assert.doesNotMatch(output, /\[状态\]\s*(pending|running|finished|failed)/);
});

test("measureDisplayWidth 会把中文按终端双列宽处理，避免消息框右边界错位", () => {
  assert.equal(measureDisplayWidth("Build"), 5);
  assert.equal(measureDisplayWidth("可以。"), 6);
  assert.equal(measureDisplayWidth("你想把这轮协作测试聚焦在哪一类任务上？"), 38);
});
