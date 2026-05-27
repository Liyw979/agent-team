import { test } from "bun:test";
import assert from "node:assert/strict";

import { mergeTaskChatMessages } from "./chat-messages";
import { toUtcIsoTimestamp, type AgentFinalMessageRecord, type AgentDispatchMessageRecord } from "@shared/types";

const TIMESTAMP = toUtcIsoTimestamp("2026-05-21T00:00:00.000Z");

function createAgentFinalMessage(content: string): AgentFinalMessageRecord {
  return {
    id: "final",
    sender: "Build",
    timestamp: TIMESTAMP,
    content,
    kind: "agent-final",
    runCount: 1,
    status: "completed",
    rawResponse: content,
    senderDisplayName: "Build",
    routingKind: "default",
  };
}

function createAgentDispatchMessage(content: string): AgentDispatchMessageRecord {
  return {
    id: "dispatch",
    sender: "Build",
    timestamp: TIMESTAMP,
    content,
    kind: "agent-dispatch",
    targetAgentIds: ["Review"],
    targetRunCounts: [1],
    dispatchDisplayContent: content,
    senderDisplayName: "Build",
  };
}

function requireFirstMessage(messages: ReturnType<typeof mergeTaskChatMessages>) {
  assert.equal(messages.length, 1);
  const first = messages[0];
  assert.ok(first);
  return first;
}

test("mergeTaskChatMessages 会保留尾部继续协助提议", () => {
  const content = `已把重复校验收成一条统一路径。

验证结果：
\`10 passed\`

如果你愿意，我可以继续把函数和测试再压到一个更极简、但仍可读的版本。`;

  const messages = mergeTaskChatMessages([createAgentFinalMessage(content)]);
  const first = requireFirstMessage(messages);

  assert.equal(first.content, content);
});

test("mergeTaskChatMessages 合并转派时也会保留尾部继续协助提议", () => {
  const content = `结论

这个 sink 不能再按“仅内部探活，无外部利用”来否定。

如果你愿意，我下一步可以继续把这条链路整理成一版漏洞分析报告格式。`;

  const messages = mergeTaskChatMessages([
    createAgentFinalMessage(content),
    createAgentDispatchMessage("@Review"),
  ]);
  const first = requireFirstMessage(messages);

  assert.equal(first.content, `${content}\n\n@Review`);
});

test("mergeTaskChatMessages 会保留完整正文和尾部分隔线", () => {
  const content = `背景说明

## 结论
这里是最终判断。
---`;

  const messages = mergeTaskChatMessages([createAgentFinalMessage(content)]);
  const first = requireFirstMessage(messages);

  assert.equal(first.content, content);
});

test("mergeTaskChatMessages 会展示已清理正文并保留尾部分隔线", () => {
  const messages = mergeTaskChatMessages([
    {
      ...createAgentFinalMessage("正文\n\n继续处理。\n\n如果你愿意，我可以继续补测试。\n---"),
      routingKind: "triggered" as const,
      trigger: "<continue>" as const,
      rawResponse: "<continue>正文\n\n继续处理。</continue>",
    },
  ]);
  const first = requireFirstMessage(messages);

  assert.equal(first.content, "正文\n\n继续处理。\n\n如果你愿意，我可以继续补测试。\n---");
});
