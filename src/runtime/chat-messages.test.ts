import test from "node:test";
import assert from "node:assert/strict";

import type {MessageRecord} from "@shared/types";

import {mergeTaskChatMessages} from "../lib/chat-messages";
import {formatActionRequiredRequestContent} from "../shared/chat-message-format";
import {REVIEW_CONTINUE_END_LABEL, REVIEW_CONTINUE_LABEL,} from "../shared/review-response";

function createMessage(overrides: Partial<MessageRecord> & { kind: MessageRecord["kind"] }): MessageRecord {
  const id = overrides.id ?? "message-id";
  const taskId = overrides.taskId ?? "task-id";
  const content = overrides.content ?? "";
  const sender = overrides.sender ?? "BA";
  const timestamp = overrides.timestamp ?? "2026-04-14T12:00:00.000Z";

  switch (overrides.kind) {
    case "agent-final": {
      const message: MessageRecord = {
        id,
        taskId,
        content,
        sender,
        timestamp,
        kind: "agent-final",
        status: overrides.status ?? "completed",
        reviewDecision: overrides.reviewDecision ?? "complete",
        reviewOpinion: overrides.reviewOpinion ?? "",
        rawResponse: overrides.rawResponse ?? content,
        ...(overrides.senderDisplayName ? { senderDisplayName: overrides.senderDisplayName } : {}),
      };
      return message;
    }
    case "agent-dispatch": {
      const message: MessageRecord = {
        id,
        taskId,
        content,
        sender,
        timestamp,
        kind: "agent-dispatch",
        targetAgentIds: overrides.targetAgentIds ?? [],
        dispatchDisplayContent: overrides.dispatchDisplayContent ?? content,
        ...(overrides.senderDisplayName ? { senderDisplayName: overrides.senderDisplayName } : {}),
      };
      return message;
    }
    case "continue-request": {
      return {
        id,
        taskId,
        content,
        sender,
        timestamp,
        kind: "continue-request",
        targetAgentIds: overrides.targetAgentIds ?? [],
        ...(overrides.senderDisplayName ? {senderDisplayName: overrides.senderDisplayName} : {}),
      };
    }
    case "user":
      return {
        id,
        taskId,
        content,
        sender: "user",
        timestamp,
        kind: "user",
        scope: "task",
        taskTitle: "demo",
        targetAgentIds: overrides.targetAgentIds ?? [],
      };
    case "task-completed":
      return {
        id,
        taskId,
        content,
        sender: "system",
        timestamp,
        kind: "task-completed",
        status: overrides.status === "failed" ? "failed" : "finished",
      };
    case "task-created":
      return {
        id,
        taskId,
        content,
        sender: "system",
        timestamp,
        kind: "task-created",
      };
    case "orchestrator-waiting":
      return {
        id,
        taskId,
        content,
        sender: "system",
        timestamp,
        kind: "orchestrator-waiting",
      };
    case "system-message":
      return {
        id,
        taskId,
        content,
        sender: "system",
        timestamp,
        kind: "system-message",
      };
  }
}

test("聊天合并层只依赖消息显式字段，不依赖 meta 杂物箱", () => {
  const merged = mergeTaskChatMessages([
    createMessage({
      id: "review-final",
      sender: "反方-1",
      content: "当前证据仍不足以证明越权成立。",
      kind: "agent-final",
      reviewDecision: "continue",
    }),
    createMessage({
      id: "review-dispatch",
      sender: "反方-1",
      content: "",
      kind: "agent-dispatch",
      targetAgentIds: ["裁决总结-1"],
      dispatchDisplayContent: "反方-1 -> 正方-1 已连续交流 4 次",
    }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0]?.content,
    "当前证据仍不足以证明越权成立。\n\n@裁决总结-1",
  );
});

test("合并回应消息时只保留一份回应与一份 mention", () => {
  const summary =
    `${REVIEW_CONTINUE_LABEL}暂无进一步结论，因为尚未完成润色工作。请先完成需求润色，然后再回应实现是否成立。`
    + REVIEW_CONTINUE_END_LABEL;
  const remediationMessage = formatActionRequiredRequestContent(
    "暂无进一步结论，因为尚未完成润色工作。请先完成需求润色，然后再回应实现是否成立。",
    ["Build"],
  );

  const merged = mergeTaskChatMessages([
    createMessage({
      id: "agent-final",
      content: summary,
      kind: "agent-final",
      reviewDecision: "continue",
    }),
    createMessage({
      id: "continue-request",
      content: remediationMessage,
      kind: "continue-request",
      targetAgentIds: ["Build"],
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
      kind: "agent-final",
      reviewDecision: "continue",
    }),
    createMessage({
      id: "continue-request",
      content: formatActionRequiredRequestContent(
        "请补充实现依据，并说明验证为何足以支持当前结论。",
        ["Build"],
      ),
      kind: "continue-request",
      targetAgentIds: ["Build"],
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
      kind: "agent-final",
      reviewDecision: "continue",
    }),
    createMessage({
      id: "unit-test-final",
      sender: "UnitTest",
      timestamp: "2026-04-17T02:20:52.000Z",
      content: "测试已经有了，整体也符合大部分标准。",
      kind: "agent-final",
      reviewDecision: "complete",
    }),
    createMessage({
      id: "task-review-continue-request",
      sender: "TaskReview",
      timestamp: "2026-04-17T02:20:52.500Z",
      content: formatActionRequiredRequestContent(reviewContent, ["Build"]),
      kind: "continue-request",
      targetAgentIds: ["Build"],
    }),
  ]);

  assert.equal(merged.length, 2);
  assert.equal(
    merged[0]?.content,
    "我不认同现在可以直接交付。请继续补充这些信息后再确认是否达到可交付标准。\n\n@Build",
  );
  assert.deepEqual(merged[0]?.kinds, ["agent-final", "continue-request"]);
  assert.equal(merged[1]?.sender, "UnitTest");
});

test("continue-request 单独展示时会移除标签后再追加 mention", () => {
  const merged = mergeTaskChatMessages([
    createMessage({
      id: "continue-request",
      content: formatActionRequiredRequestContent(
        "请补充实现依据。",
        ["Build"],
      ),
      kind: "continue-request",
      targetAgentIds: ["Build"],
    }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0]?.content,
    "请补充实现依据。\n\n@Build",
  );
});

test("continue-request 单独展示时也会移除孤立的结束标签后再追加 mention", () => {
  const merged = mergeTaskChatMessages([
    createMessage({
      id: "continue-request",
      content: `${REVIEW_CONTINUE_END_LABEL}请补充实现依据。\n\n@Build`,
      kind: "continue-request",
      targetAgentIds: ["Build"],
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
      content: "继续处理。\n\n请补充实现依据。",
      kind: "agent-final",
      reviewDecision: "continue",
    }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.content, "继续处理。\n\n请补充实现依据。");
});

test("agent-final 展示时也会移除孤立的结束标签", () => {
  const merged = mergeTaskChatMessages([
    createMessage({
      id: "agent-final",
      content: "继续处理。\n\n请补充实现依据。",
      kind: "agent-final",
      reviewDecision: "continue",
    }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.content, "继续处理。\n\n请补充实现依据。");
});

test("合并 agent-final 与 agent-dispatch 时保留 BA 正文并追加派发目标", () => {
  const summary = `这是分析过程。

## 正式结果
给定 a = 1、b = 2 时，返回 c = 3`;

  const merged = mergeTaskChatMessages([
    createMessage({
      id: "agent-final",
      content: summary,
      kind: "agent-final",
    }),
    createMessage({
      id: "agent-dispatch",
      content: "@Build",
      kind: "agent-dispatch",
      targetAgentIds: ["Build"],
    }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0]?.content,
    "这是分析过程。\n\n## 正式结果\n给定 a = 1、b = 2 时，返回 c = 3\n\n@Build",
  );
});

test("spawn 实例消息在聊天展示中优先使用 senderDisplayName，保留模板名和实例 id", () => {
  const merged = mergeTaskChatMessages([
    createMessage({
      id: "spawn-task-review-final",
      sender: "TaskReview-1",
      content: "这版已经达到可交付标准。",
      kind: "agent-final",
      senderDisplayName: "TaskReview-1",
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
      kind: "agent-final",
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
      content: "第一段\n\n第二段\n\n```ts\nconst done = true;\n```",
      kind: "agent-final",
    }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0]?.content,
    "第一段\n\n第二段\n\n```ts\nconst done = true;\n```",
  );
});

test("action_required 审查正文命中结论标题时，聊天展示不能只截取最后的结论章节", () => {
  const merged = mergeTaskChatMessages([
    createMessage({
      id: "agent-final-needs-revision-heading",
      sender: "反方-1",
      content: "## 结论\n所以我仍然维持上一轮的收敛判断：\n目前代码证明的是“缺失主机名时回退默认虚拟主机的实现行为”，\n但还不足以仅凭源码坐实真实可利用的虚拟主机绕过漏洞。",
      kind: "agent-final",
      reviewDecision: "continue",
    }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0]?.content,
    "## 结论\n所以我仍然维持上一轮的收敛判断：\n目前代码证明的是“缺失主机名时回退默认虚拟主机的实现行为”，\n但还不足以仅凭源码坐实真实可利用的虚拟主机绕过漏洞。",
  );
});

test("回流超限转给 approved 下游时，群聊只保留 reviewer 正文并追加目标 mention", () => {
  const reviewBody = "当前证据仍不足以证明越权成立。";
  const loopLimitNotice = "反方-1 -> 正方-1 已连续交流 4 次";

  const merged = mergeTaskChatMessages([
    createMessage({
      id: "reviewer-final",
      sender: "反方-1",
      content: reviewBody,
      kind: "agent-final",
      reviewDecision: "continue",
    }),
    createMessage({
      id: "dispatch-to-summary",
      sender: "反方-1",
      content: "",
      kind: "agent-dispatch",
      targetAgentIds: ["裁决总结-1"],
      dispatchDisplayContent: loopLimitNotice,
    }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0]?.content,
    `${reviewBody}\n\n@裁决总结-1`,
  );
});
