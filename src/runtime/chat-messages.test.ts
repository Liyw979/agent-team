import test from "node:test";
import assert from "node:assert/strict";

import type {MessageRecord} from "@shared/types";

import {mergeTaskChatMessages} from "../lib/chat-messages";
import {formatActionRequiredRequestContent} from "../shared/chat-message-format";
import {DECISION_CONTINUE_END_LABEL, DECISION_CONTINUE_LABEL,} from "../shared/decision-response";

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
        decision: overrides.decision ?? "complete",
        decisionNote: overrides.decisionNote ?? "",
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
        status: "failed",
      };
    case "task-round-finished":
      return {
        id,
        taskId,
        content,
        sender: "system",
        timestamp,
        kind: "task-round-finished",
        finishReason: overrides.finishReason ?? "round_finished",
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
      id: "decision-final",
      sender: "漏洞挑战-1",
      content: "当前证据仍不足以证明越权成立。",
      kind: "agent-final",
      decision: "continue",
    }),
    createMessage({
      id: "decision-dispatch",
      sender: "漏洞挑战-1",
      content: "",
      kind: "agent-dispatch",
      targetAgentIds: ["讨论总结-1"],
      dispatchDisplayContent: "漏洞挑战-1 -> 漏洞论证-1 已连续交流 4 次",
    }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0]?.content,
    "当前证据仍不足以证明越权成立。\n\n@讨论总结-1",
  );
});

test("合并回应消息时只保留一份回应与一份 mention", () => {
  const summary =
    `${DECISION_CONTINUE_LABEL}暂无进一步结论，因为尚未完成润色工作。请先完成需求润色，然后再回应实现是否成立。`
    + DECISION_CONTINUE_END_LABEL;
  const remediationMessage = formatActionRequiredRequestContent(
    "暂无进一步结论，因为尚未完成润色工作。请先完成需求润色，然后再回应实现是否成立。",
    ["Build"],
  );

  const merged = mergeTaskChatMessages([
    createMessage({
      id: "agent-final",
      content: summary,
      kind: "agent-final",
      decision: "continue",
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
      decision: "continue",
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

test("agent-final 已包含继续处理正文时，合并 continue-request 不会重复追加同一段回应", () => {
  const finalBody = "当前只能确认这里没有看到强制拒绝缺失主机标识的分支。";
  const decisionBody = "还需要补证：缺失 host 的 HTTP/2 请求是否真的会进入目标敏感应用。";
  const merged = mergeTaskChatMessages([
    createMessage({
      id: "agent-final-with-body-and-response",
      sender: "漏洞挑战-1",
      content: `${finalBody}\n\n${DECISION_CONTINUE_LABEL}${decisionBody}${DECISION_CONTINUE_END_LABEL}`,
      kind: "agent-final",
      decision: "continue",
    }),
    createMessage({
      id: "continue-request-after-complete-final",
      sender: "漏洞挑战-1",
      content: `${decisionBody}\n\n@漏洞论证-1`,
      kind: "continue-request",
      targetAgentIds: ["漏洞论证-1"],
    }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0]?.content,
    `${finalBody}\n\n${decisionBody}\n\n@漏洞论证-1`,
  );
});

test("decisionAgent 的回流消息即使被其他消息隔开，也应继续合并回原结果卡片", () => {
  const decisionContent = "我不认同现在可以直接交付。请继续补充这些信息后再确认是否达到可交付标准。";

  const merged = mergeTaskChatMessages([
    createMessage({
      id: "task-decision-final",
      sender: "TaskReview",
      timestamp: "2026-04-17T02:20:45.000Z",
      content: decisionContent,
      kind: "agent-final",
      decision: "continue",
    }),
    createMessage({
      id: "unit-test-final",
      sender: "UnitTest",
      timestamp: "2026-04-17T02:20:52.000Z",
      content: "测试已经有了，整体也符合大部分标准。",
      kind: "agent-final",
      decision: "complete",
    }),
    createMessage({
      id: "task-decision-continue-request",
      sender: "TaskReview",
      timestamp: "2026-04-17T02:20:52.500Z",
      content: formatActionRequiredRequestContent(decisionContent, ["Build"]),
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

test("agent-final 已包含继续处理正文时，即使被其他消息隔开，回流消息也不会重复追加同一段回应", () => {
  const finalBody = "我不认同现在可以直接交付。";
  const decisionBody = "请继续补充这些信息后再确认是否达到可交付标准。";

  const merged = mergeTaskChatMessages([
    createMessage({
      id: "task-decision-final-with-body-and-response",
      sender: "TaskReview",
      timestamp: "2026-04-17T02:20:45.000Z",
      content: `${finalBody}\n\n${DECISION_CONTINUE_LABEL}${decisionBody}${DECISION_CONTINUE_END_LABEL}`,
      kind: "agent-final",
      decision: "continue",
    }),
    createMessage({
      id: "unit-test-final-between-decision",
      sender: "UnitTest",
      timestamp: "2026-04-17T02:20:52.000Z",
      content: "测试已经有了，整体也符合大部分标准。",
      kind: "agent-final",
      decision: "complete",
    }),
    createMessage({
      id: "task-decision-continue-request-with-duplicate-body",
      sender: "TaskReview",
      timestamp: "2026-04-17T02:20:52.500Z",
      content: `${decisionBody}\n\n@Build`,
      kind: "continue-request",
      targetAgentIds: ["Build"],
    }),
  ]);

  assert.equal(merged.length, 2);
  assert.equal(
    merged[0]?.content,
    `${finalBody}\n\n${decisionBody}\n\n@Build`,
  );
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
      content: `${DECISION_CONTINUE_END_LABEL}请补充实现依据。\n\n@Build`,
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
      decision: "continue",
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
      decision: "continue",
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
      id: "spawn-task-decision-final",
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

test("action_required 判定正文命中结论标题时，聊天展示不能只截取最后的结论章节", () => {
  const merged = mergeTaskChatMessages([
    createMessage({
      id: "agent-final-needs-revision-heading",
      sender: "漏洞挑战-1",
      content: "## 结论\n所以我仍然维持上一轮的收敛判断：\n目前代码证明的是“缺失主机名时回退默认虚拟主机的实现行为”，\n但还不足以仅凭源码坐实真实可利用的虚拟主机绕过漏洞。",
      kind: "agent-final",
      decision: "continue",
    }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0]?.content,
    "## 结论\n所以我仍然维持上一轮的收敛判断：\n目前代码证明的是“缺失主机名时回退默认虚拟主机的实现行为”，\n但还不足以仅凭源码坐实真实可利用的虚拟主机绕过漏洞。",
  );
});

test("回流超限转给 approved 下游时，群聊只保留 decisionAgent 正文并追加目标 mention", () => {
  const decisionBody = "当前证据仍不足以证明越权成立。";
  const loopLimitNotice = "漏洞挑战-1 -> 漏洞论证-1 已连续交流 4 次";

  const merged = mergeTaskChatMessages([
    createMessage({
      id: "decisionAgent-final",
      sender: "漏洞挑战-1",
      content: decisionBody,
      kind: "agent-final",
      decision: "continue",
    }),
    createMessage({
      id: "dispatch-to-summary",
      sender: "漏洞挑战-1",
      content: "",
      kind: "agent-dispatch",
      targetAgentIds: ["讨论总结-1"],
      dispatchDisplayContent: loopLimitNotice,
    }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0]?.content,
    `${decisionBody}\n\n@讨论总结-1`,
  );
});

test("实现结果后连续派发 decisionAgent 时，群聊会去掉尾部追问并折叠重复 mention", () => {
  const merged = mergeTaskChatMessages([
    createMessage({
      id: "build-final",
      sender: "Build",
      timestamp: "2026-04-24T15:54:14.000Z",
      content: `已把重复校验收成一条统一路径。

验证结果：
\`.venv/bin/python -m pytest\`
\`10 passed\`

如果你愿意，我可以继续把函数和测试再压到一个更极简、但仍可读的版本。`,
      kind: "agent-final",
    }),
    createMessage({
      id: "build-dispatch-1",
      sender: "Build",
      timestamp: "2026-04-24T15:54:21.000Z",
      content: "@UnitTest @TaskReview",
      kind: "agent-dispatch",
      targetAgentIds: ["UnitTest", "TaskReview"],
    }),
    createMessage({
      id: "build-dispatch-2",
      sender: "Build",
      timestamp: "2026-04-24T15:54:21.100Z",
      content: "@UnitTest @TaskReview",
      kind: "agent-dispatch",
      targetAgentIds: ["UnitTest", "TaskReview"],
    }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0]?.content,
    `已把重复校验收成一条统一路径。

验证结果：
\`.venv/bin/python -m pytest\`
\`10 passed\`

@UnitTest @TaskReview`,
  );
});

test("单条 dispatch 自身已包含尾部 mention 时，聊天展示不会再重复追加一遍", () => {
  const merged = mergeTaskChatMessages([
    createMessage({
      id: "build-dispatch-with-trailing-mention",
      sender: "Build",
      timestamp: "2026-04-24T15:54:21.886Z",
      content: `已把重复校验收成一条统一路径。

现在 \`add_tool.py\` 里：
- 只保留一个对外函数 \`add(a, b)\`
- 用一个小循环统一校验 \`a\` 和 \`b\`
- 仍然严格排除 \`bool\`

验证结果：
- \`.venv/bin/python -m pytest\`
- \`10 passed\`

如果你愿意，我可以继续把函数和测试再压到一个更极简、但仍可读的版本。

@UnitTest @TaskReview`,
      kind: "agent-dispatch",
      targetAgentIds: ["UnitTest", "TaskReview"],
    }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0]?.content,
    `已把重复校验收成一条统一路径。

现在 \`add_tool.py\` 里：
- 只保留一个对外函数 \`add(a, b)\`
- 用一个小循环统一校验 \`a\` 和 \`b\`
- 仍然严格排除 \`bool\`

验证结果：
- \`.venv/bin/python -m pytest\`
- \`10 passed\`

如果你愿意，我可以继续把函数和测试再压到一个更极简、但仍可读的版本。

@UnitTest @TaskReview`,
  );
});
