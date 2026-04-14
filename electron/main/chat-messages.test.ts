import test from "node:test";
import assert from "node:assert/strict";

import type { MessageRecord } from "@shared/types";

import { mergeTaskChatMessages } from "../../src/lib/chat-messages";
import { formatRevisionRequestContent } from "../../shared/chat-message-format";

function createMessage(overrides: Partial<MessageRecord>): MessageRecord {
  return {
    id: overrides.id ?? "message-id",
    projectId: overrides.projectId ?? "project-id",
    taskId: overrides.taskId ?? "task-id",
    content: overrides.content ?? "",
    sender: overrides.sender ?? "BA",
    timestamp: overrides.timestamp ?? "2026-04-14T12:00:00.000Z",
    meta: overrides.meta,
  };
}

test("合并整改消息时只保留一份具体修改意见与一份 mention", () => {
  const summary = "具体修改意见：暂无修改意见，因为尚未完成润色工作。请先完成需求润色，然后检查实现。";
  const remediationMessage = formatRevisionRequestContent(
    `审视不通过，请根据以下意见继续处理。\n\n当前阶段高层结果：\n${summary}\n\n具体修改意见：\n暂无修改意见，因为尚未完成润色工作。请先完成需求润色，然后检查实现。`,
    "Build",
  );

  const merged = mergeTaskChatMessages([
    createMessage({
      id: "agent-final",
      content: summary,
      meta: {
        kind: "agent-final",
        reviewDecision: "needs_revision",
        finalMessage: summary,
      },
    }),
    createMessage({
      id: "revision-request",
      content: remediationMessage,
      meta: {
        kind: "revision-request",
        targetAgentId: "Build",
      },
    }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.content, `${summary}\n\n@Build`);
});

test("合并整改消息时保留高层结果并追加一份反馈", () => {
  const summary = "需求已完成初步润色。";
  const merged = mergeTaskChatMessages([
    createMessage({
      id: "agent-final",
      content: summary,
      meta: {
        kind: "agent-final",
        reviewDecision: "needs_revision",
        finalMessage: summary,
      },
    }),
    createMessage({
      id: "revision-request",
      content: formatRevisionRequestContent(
        `审视不通过，请根据以下意见继续处理。\n\n当前阶段高层结果：\n${summary}\n\n具体修改意见：\n请补充实现并完成验证。`,
        "Build",
      ),
      meta: {
        kind: "revision-request",
        targetAgentId: "Build",
      },
    }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0]?.content,
    "需求已完成初步润色。\n\n具体修改意见：\n请补充实现并完成验证。\n\n@Build",
  );
});
