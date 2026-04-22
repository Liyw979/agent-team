import test from "node:test";
import assert from "node:assert/strict";

import type { MessageRecord } from "@shared/types";

import { mergeTaskChatMessages } from "../lib/chat-messages";
import { formatRevisionRequestContent } from "../shared/chat-message-format";
import {
  REVIEW_NEEDS_REVISION_END_LABEL,
  REVIEW_NEEDS_REVISION_LABEL,
} from "../shared/review-response";

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

test("合并回应消息时只保留一份回应与一份 mention", () => {
  const summary =
    `${REVIEW_NEEDS_REVISION_LABEL}暂无进一步结论，因为尚未完成润色工作。请先完成需求润色，然后再回应实现是否成立。`
    + REVIEW_NEEDS_REVISION_END_LABEL;
  const remediationMessage = formatRevisionRequestContent(
    "暂无进一步结论，因为尚未完成润色工作。请先完成需求润色，然后再回应实现是否成立。",
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
  assert.equal(
    merged[0]?.content,
    "暂无进一步结论，因为尚未完成润色工作。请先完成需求润色，然后再回应实现是否成立。\n\n@Build",
  );
});

test("合并回应消息时保留结果正文并追加一份回应", () => {
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
        "请补充实现依据，并说明验证为何足以支持当前结论。",
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
    "需求已完成初步润色。\n\n请补充实现依据，并说明验证为何足以支持当前结论。\n\n@Build",
  );
});

test("reviewer 的回流消息即使被其他消息隔开，也应继续合并回原结果卡片", () => {
  const reviewContent = "我不认同现在可以直接交付。请继续补充这些信息后再确认是否达到可交付标准。";

  const merged = mergeTaskChatMessages([
    createMessage({
      id: "task-review-final",
      sender: "TaskReview",
      timestamp: "2026-04-17T02:20:45.000Z",
      content: reviewContent,
      meta: {
        kind: "agent-final",
        reviewDecision: "needs_revision",
        finalMessage: reviewContent,
      },
    }),
    createMessage({
      id: "unit-test-final",
      sender: "UnitTest",
      timestamp: "2026-04-17T02:20:52.000Z",
      content: "测试已经有了，整体也符合大部分标准。",
      meta: {
        kind: "agent-final",
        reviewDecision: "approved",
        finalMessage: "测试已经有了，整体也符合大部分标准。",
      },
    }),
    createMessage({
      id: "task-review-revision-request",
      sender: "TaskReview",
      timestamp: "2026-04-17T02:20:52.500Z",
      content: formatRevisionRequestContent(reviewContent, "Build"),
      meta: {
        kind: "revision-request",
        targetAgentId: "Build",
      },
    }),
  ]);

  assert.equal(merged.length, 2);
  assert.equal(
    merged[0]?.content,
    "我不认同现在可以直接交付。请继续补充这些信息后再确认是否达到可交付标准。\n\n@Build",
  );
  assert.deepEqual(merged[0]?.kinds, ["agent-final", "revision-request"]);
  assert.equal(merged[1]?.sender, "UnitTest");
});

test("revision-request 单独展示时会移除标签后再追加 mention", () => {
  const merged = mergeTaskChatMessages([
    createMessage({
      id: "revision-request",
      content: formatRevisionRequestContent(
        "请补充实现依据。",
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
    "请补充实现依据。\n\n@Build",
  );
});

test("revision-request 单独展示时也会移除孤立的结束标签后再追加 mention", () => {
  const merged = mergeTaskChatMessages([
    createMessage({
      id: "revision-request",
      content: `${REVIEW_NEEDS_REVISION_END_LABEL}请补充实现依据。\n\n@Build`,
      meta: {
        kind: "revision-request",
        targetAgentId: "Build",
      },
    }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0]?.content,
    "请补充实现依据。\n\n@Build",
  );
});

test("agent-final 展示时会移除整改标签，只保留正文", () => {
  const merged = mergeTaskChatMessages([
    createMessage({
      id: "agent-final",
      content: "请补充实现依据。",
      meta: {
        kind: "agent-final",
        reviewDecision: "needs_revision",
        finalMessage: `审视不通过。\n\n${REVIEW_NEEDS_REVISION_LABEL}请补充实现依据。`,
      },
    }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.content, "审视不通过。\n\n请补充实现依据。");
});

test("agent-final 展示时也会移除孤立的结束标签", () => {
  const merged = mergeTaskChatMessages([
    createMessage({
      id: "agent-final",
      content: "请补充实现依据。",
      meta: {
        kind: "agent-final",
        reviewDecision: "needs_revision",
        finalMessage: `审视不通过。\n\n${REVIEW_NEEDS_REVISION_END_LABEL}请补充实现依据。`,
      },
    }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.content, "审视不通过。\n\n请补充实现依据。");
});

test("合并 agent-final 与 agent-dispatch 时保留 BA 正文并追加派发目标", () => {
  const summary = `这是分析过程。

## 正式结果
给定 a = 1、b = 2 时，返回 c = 3`;

  const merged = mergeTaskChatMessages([
    createMessage({
      id: "agent-final",
      content: summary,
      meta: {
        kind: "agent-final",
        finalMessage: summary,
      },
    }),
    createMessage({
      id: "agent-dispatch",
      content: "@Build",
      meta: {
        kind: "agent-dispatch",
        sourceAgentId: "BA",
        targetAgentIds: "Build",
      },
    }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0]?.content,
    "## 正式结果\n给定 a = 1、b = 2 时，返回 c = 3\n\n@Build",
  );
});

test("spawn 实例消息在聊天展示中优先使用 senderDisplayName，保留模板名和实例 id", () => {
  const merged = mergeTaskChatMessages([
    createMessage({
      id: "spawn-task-review-final",
      sender: "TaskReview-1",
      content: "这版已经达到可交付标准。",
      meta: {
        kind: "agent-final",
        finalMessage: "这版已经达到可交付标准。",
        senderDisplayName: "TaskReview-1",
      },
    }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.sender, "TaskReview-1");
});

test("未命中正式交付标题时保留完整结构化正文，不截断到备注章节", () => {
  const summary = `下面是将你的原始 User Story 润色后的可执行需求说明，供实现方直接推进。

## 需求名称
在当前项目中以临时文件形式实现一个加法工具

## 目标
提供一个最小可用的加法能力：调用该工具时传入 a 和 b，返回它们的和 c。

## 备注
如果你希望，我可以继续把这份需求进一步整理成：
- 接口定义
- 测试用例
- 验收清单`;

  const merged = mergeTaskChatMessages([
    createMessage({
      id: "agent-final",
      content: summary,
      meta: {
        kind: "agent-final",
        finalMessage: summary,
      },
    }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.content, summary);
});

test("聊天消息里的正文空行需要保留，不能在消息链路里被压缩", () => {
  const merged = mergeTaskChatMessages([
    createMessage({
      id: "agent-final-blank-lines",
      sender: "Build",
      content: "原始消息",
      meta: {
        kind: "agent-final",
        finalMessage: "第一段\n\n第二段\n\n```ts\nconst done = true;\n```",
      },
    }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0]?.content,
    "第一段\n\n第二段\n\n```ts\nconst done = true;\n```",
  );
});
