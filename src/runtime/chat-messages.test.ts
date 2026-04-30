import test from "node:test";
import assert from "node:assert/strict";

import type {
  ActionRequiredRequestMessageRecord,
  AgentDispatchMessageRecord,
  AgentFinalMessageRecord,
} from "@shared/types";

import { mergeTaskChatMessages } from "../lib/chat-messages";
import { formatActionRequiredRequestContent } from "../shared/chat-message-format";
const EXAMPLE_TRIGGER_LABEL = "<continue>";
const EXAMPLE_TRIGGER_END_LABEL = "</continue>";
const EXAMPLE_COMPLETE_TRIGGER_LABEL = "<complete>";
const EXAMPLE_COMPLETE_TRIGGER_END_LABEL = "</complete>";
const DEFAULT_TASK_ID = "task-id";
const DEFAULT_TIMESTAMP = "2026-04-14T12:00:00.000Z";
const DEFAULT_SENDER = "BA";

function createDefaultAgentFinalMessage(
  id: string,
  content: string,
  sender: string,
  timestamp: string,
): AgentFinalMessageRecord {
  return {
    id,
    taskId: DEFAULT_TASK_ID,
    content,
    sender,
    timestamp,
    kind: "agent-final",
    runCount: 1,
    status: "completed",
    routingKind: "default",
    responseNote: "",
    rawResponse: content,
  };
}

function createNamedDefaultAgentFinalMessage(
  id: string,
  content: string,
  sender: string,
  timestamp: string,
  senderDisplayName: string,
): AgentFinalMessageRecord {
  return {
    ...createDefaultAgentFinalMessage(id, content, sender, timestamp),
    senderDisplayName,
  };
}

function createLabeledAgentFinalMessage(
  id: string,
  content: string,
  rawResponse: string,
  responseNote: string,
  trigger: string,
  sender: string,
  timestamp: string,
): AgentFinalMessageRecord {
  return {
    id,
    taskId: DEFAULT_TASK_ID,
    content,
    sender,
    timestamp,
    kind: "agent-final",
    runCount: 1,
    status: "completed",
    routingKind: "labeled",
    trigger,
    responseNote,
    rawResponse,
  };
}

function createAgentDispatchMessage(
  id: string,
  content: string,
  targetAgentIds: string[],
  dispatchDisplayContent: string,
  sender: string,
  timestamp: string,
): AgentDispatchMessageRecord {
  return {
    id,
    taskId: DEFAULT_TASK_ID,
    content,
    sender,
    timestamp,
    kind: "agent-dispatch",
    targetAgentIds,
    targetRunCounts: targetAgentIds.map(() => 1),
    dispatchDisplayContent,
  };
}

function createActionRequiredRequestMessage(
  id: string,
  content: string,
  followUpMessageId: string,
  targetAgentIds: string[],
  sender: string,
  timestamp: string,
): ActionRequiredRequestMessageRecord {
  return {
    id,
    taskId: DEFAULT_TASK_ID,
    content,
    sender,
    timestamp,
    kind: "action-required-request",
    followUpMessageId,
    targetAgentIds,
    targetRunCounts: targetAgentIds.map(() => 1),
  };
}

test("聊天合并层只依赖消息显式字段，不依赖 meta 杂物箱", () => {
  const merged = mergeTaskChatMessages([
    createLabeledAgentFinalMessage(
      "decision-final",
      "当前证据仍不足以证明越权成立。",
      `${EXAMPLE_TRIGGER_LABEL}当前证据仍不足以证明越权成立。${EXAMPLE_TRIGGER_END_LABEL}`,
      "当前证据仍不足以证明越权成立。",
      "<continue>",
      "漏洞挑战-1",
      DEFAULT_TIMESTAMP,
    ),
    createAgentDispatchMessage(
      "decision-dispatch",
      "",
      ["讨论总结-1"],
      "漏洞挑战-1 -> 漏洞论证-1 已连续交流 4 次",
      "漏洞挑战-1",
      DEFAULT_TIMESTAMP,
    ),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0]?.content,
    "当前证据仍不足以证明越权成立。\n\n@讨论总结-1",
  );
});

test("合并回应消息时只保留一份回应与一份 mention", () => {
  const summary =
    `${EXAMPLE_TRIGGER_LABEL}暂无进一步结论，因为尚未完成润色工作。请先完成需求润色，然后再回应实现是否成立。` +
    EXAMPLE_TRIGGER_END_LABEL;
  const remediationMessage = formatActionRequiredRequestContent(
    "暂无进一步结论，因为尚未完成润色工作。请先完成需求润色，然后再回应实现是否成立。",
    ["Build"],
  );

  const merged = mergeTaskChatMessages([
    createLabeledAgentFinalMessage(
      "agent-final",
      "暂无进一步结论，因为尚未完成润色工作。请先完成需求润色，然后再回应实现是否成立。",
      summary,
      "暂无进一步结论，因为尚未完成润色工作。请先完成需求润色，然后再回应实现是否成立。",
      "<continue>",
      DEFAULT_SENDER,
      DEFAULT_TIMESTAMP,
    ),
    createActionRequiredRequestMessage(
      "action-required-request",
      remediationMessage,
      "agent-final",
      ["Build"],
      DEFAULT_SENDER,
      DEFAULT_TIMESTAMP,
    ),
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
    createLabeledAgentFinalMessage(
      "agent-final",
      summary,
      `${EXAMPLE_TRIGGER_LABEL}${summary}${EXAMPLE_TRIGGER_END_LABEL}`,
      summary,
      "<continue>",
      DEFAULT_SENDER,
      DEFAULT_TIMESTAMP,
    ),
    createActionRequiredRequestMessage(
      "action-required-request",
      formatActionRequiredRequestContent(
        "请补充实现依据，并说明验证为何足以支持当前结论。",
        ["Build"],
      ),
      "agent-final",
      ["Build"],
      DEFAULT_SENDER,
      DEFAULT_TIMESTAMP,
    ),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0]?.content,
    "需求已完成初步润色。\n\n请补充实现依据，并说明验证为何足以支持当前结论。\n\n@Build",
  );
});

test("agent-final 已包含继续处理正文时，合并 action-required-request 不会重复追加同一段回应", () => {
  const finalBody = "当前只能确认这里没有看到强制拒绝缺失主机标识的分支。";
  const decisionBody =
    "还需要补证：缺失 host 的 HTTP/2 请求是否真的会进入目标敏感应用。";
  const merged = mergeTaskChatMessages([
    createLabeledAgentFinalMessage(
      "agent-final-with-body-and-response",
      `${finalBody}\n\n${decisionBody}`,
      `${finalBody}\n\n${EXAMPLE_TRIGGER_LABEL}${decisionBody}${EXAMPLE_TRIGGER_END_LABEL}`,
      decisionBody,
      "<continue>",
      "漏洞挑战-1",
      DEFAULT_TIMESTAMP,
    ),
    createActionRequiredRequestMessage(
      "action-required-request-after-complete-final",
      `${decisionBody}\n\n@漏洞论证-1`,
      "agent-final-with-body-and-response",
      ["漏洞论证-1"],
      "漏洞挑战-1",
      DEFAULT_TIMESTAMP,
    ),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0]?.content,
    `${finalBody}\n\n${decisionBody}\n\n@漏洞论证-1`,
  );
});

test("decisionAgent 的回流消息即使被其他消息隔开，也应继续合并回原结果卡片", () => {
  const decisionContent =
    "我不认同现在可以直接交付。请继续补充这些信息后再确认是否达到可交付标准。";

  const merged = mergeTaskChatMessages([
    createLabeledAgentFinalMessage(
      "task-decision-final",
      decisionContent,
      `${EXAMPLE_TRIGGER_LABEL}${decisionContent}${EXAMPLE_TRIGGER_END_LABEL}`,
      decisionContent,
      "<continue>",
      "TaskReview",
      "2026-04-17T02:20:45.000Z",
    ),
    createLabeledAgentFinalMessage(
      "unit-test-final",
      "测试已经有了，整体也符合大部分标准。",
      `${EXAMPLE_COMPLETE_TRIGGER_LABEL}测试已经有了，整体也符合大部分标准。${EXAMPLE_COMPLETE_TRIGGER_END_LABEL}`,
      "测试已经有了，整体也符合大部分标准。",
      "<complete>",
      "UnitTest",
      "2026-04-17T02:20:52.000Z",
    ),
    createActionRequiredRequestMessage(
      "task-decision-action-required-request",
      formatActionRequiredRequestContent(decisionContent, ["Build"]),
      "task-decision-final",
      ["Build"],
      "TaskReview",
      "2026-04-17T02:20:52.500Z",
    ),
  ]);

  assert.equal(merged.length, 2);
  assert.equal(
    merged[0]?.content,
    "我不认同现在可以直接交付。请继续补充这些信息后再确认是否达到可交付标准。\n\n@Build",
  );
  assert.deepEqual(merged[0]?.kinds, [
    "agent-final",
    "action-required-request",
  ]);
  assert.equal(merged[1]?.sender, "UnitTest");
});

test("agent-final 已包含继续处理正文时，即使被其他消息隔开，回流消息也不会重复追加同一段回应", () => {
  const finalBody = "我不认同现在可以直接交付。";
  const decisionBody = "请继续补充这些信息后再确认是否达到可交付标准。";

  const merged = mergeTaskChatMessages([
    createLabeledAgentFinalMessage(
      "task-decision-final-with-body-and-response",
      `${finalBody}\n\n${decisionBody}`,
      `${finalBody}\n\n${EXAMPLE_TRIGGER_LABEL}${decisionBody}${EXAMPLE_TRIGGER_END_LABEL}`,
      decisionBody,
      "<continue>",
      "TaskReview",
      "2026-04-17T02:20:45.000Z",
    ),
    createLabeledAgentFinalMessage(
      "unit-test-final-between-decision",
      "测试已经有了，整体也符合大部分标准。",
      `${EXAMPLE_COMPLETE_TRIGGER_LABEL}测试已经有了，整体也符合大部分标准。${EXAMPLE_COMPLETE_TRIGGER_END_LABEL}`,
      "测试已经有了，整体也符合大部分标准。",
      "<complete>",
      "UnitTest",
      "2026-04-17T02:20:52.000Z",
    ),
    createActionRequiredRequestMessage(
      "task-decision-action-required-request-with-duplicate-body",
      `${decisionBody}\n\n@Build`,
      "task-decision-final-with-body-and-response",
      ["Build"],
      "TaskReview",
      "2026-04-17T02:20:52.500Z",
    ),
  ]);

  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.content, `${finalBody}\n\n${decisionBody}\n\n@Build`);
  assert.equal(merged[1]?.sender, "UnitTest");
});

test("all_completed 辩论里示例结束 trigger 后立刻补发的 action-required-request 也应合并回原结果卡片", () => {
  const finalBody = "这个可疑点成立，属于真实的鉴权缺口，不是误报。";

  const merged = mergeTaskChatMessages([
    createLabeledAgentFinalMessage(
      "challenge-final-complete",
      finalBody,
      `${EXAMPLE_COMPLETE_TRIGGER_LABEL}${finalBody}${EXAMPLE_COMPLETE_TRIGGER_END_LABEL}`,
      finalBody,
      "<complete>",
      "漏洞挑战-4",
      "2026-04-25T06:46:03.997Z",
    ),
    createActionRequiredRequestMessage(
      "challenge-followup-action-required-request",
      `${finalBody}\n\n@漏洞论证-4`,
      "challenge-final-complete",
      ["漏洞论证-4"],
      "漏洞挑战-4",
      "2026-04-25T06:46:04.025Z",
    ),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.content, `${finalBody}\n\n@漏洞论证-4`);
  assert.deepEqual(merged[0]?.kinds, [
    "agent-final",
    "action-required-request",
  ]);
});

test("action-required-request 的 followUpMessageId 对不上时，即使 sender 相同也不能误合并", () => {
  const merged = mergeTaskChatMessages([
    createLabeledAgentFinalMessage(
      "challenge-final-complete",
      "第一条结论。",
      `${EXAMPLE_COMPLETE_TRIGGER_LABEL}第一条结论。${EXAMPLE_COMPLETE_TRIGGER_END_LABEL}`,
      "第一条结论。",
      "<complete>",
      "漏洞挑战-4",
      "2026-04-25T06:46:03.997Z",
    ),
    createActionRequiredRequestMessage(
      "challenge-followup-action-required-request-wrong-link",
      "第二条继续请求。\n\n@漏洞论证-4",
      "another-agent-final",
      ["漏洞论证-4"],
      "漏洞挑战-4",
      "2026-04-25T06:46:04.025Z",
    ),
  ]);

  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.content, "第一条结论。");
  assert.equal(merged[1]?.content, "第二条继续请求。\n\n@漏洞论证-4");
});

test("action-required-request 单独展示时会保留正文并追加 mention", () => {
  const merged = mergeTaskChatMessages([
    createActionRequiredRequestMessage(
      "action-required-request",
      formatActionRequiredRequestContent("请补充实现依据。", ["Build"]),
      "standalone-agent-final",
      ["Build"],
      DEFAULT_SENDER,
      DEFAULT_TIMESTAMP,
    ),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.content, "请补充实现依据。\n\n@Build");
});

test("action-required-request 单独展示时会保留非结构化孤立结束标签，再追加 mention", () => {
  const merged = mergeTaskChatMessages([
    createActionRequiredRequestMessage(
      "action-required-request",
      `${EXAMPLE_TRIGGER_END_LABEL}请补充实现依据。\n\n@Build`,
      "standalone-agent-final",
      ["Build"],
      DEFAULT_SENDER,
      DEFAULT_TIMESTAMP,
    ),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0]?.content,
    `${EXAMPLE_TRIGGER_END_LABEL}请补充实现依据。\n\n@Build`,
  );
});

test("agent-final 展示时会移除结构化 trigger 标签，只保留正文", () => {
  const merged = mergeTaskChatMessages([
    createLabeledAgentFinalMessage(
      "agent-final",
      "继续处理。\n\n请补充实现依据。",
      `继续处理。\n\n${EXAMPLE_TRIGGER_LABEL}请补充实现依据。${EXAMPLE_TRIGGER_END_LABEL}`,
      "请补充实现依据。",
      "<continue>",
      DEFAULT_SENDER,
      DEFAULT_TIMESTAMP,
    ),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.content, "继续处理。\n\n请补充实现依据。");
});

test("agent-final 展示时会保留非结构化孤立结束标签", () => {
  const merged = mergeTaskChatMessages([
    createDefaultAgentFinalMessage(
      "agent-final",
      `${EXAMPLE_TRIGGER_END_LABEL}继续处理。\n\n请补充实现依据。`,
      DEFAULT_SENDER,
      DEFAULT_TIMESTAMP,
    ),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0]?.content,
    `${EXAMPLE_TRIGGER_END_LABEL}继续处理。\n\n请补充实现依据。`,
  );
});

test("合并 agent-final 与 agent-dispatch 时保留 BA 正文并追加派发目标", () => {
  const summary = `这是分析过程。

## 正式结果
给定 a = 1、b = 2 时，返回 c = 3`;

  const merged = mergeTaskChatMessages([
    createDefaultAgentFinalMessage(
      "agent-final",
      summary,
      DEFAULT_SENDER,
      DEFAULT_TIMESTAMP,
    ),
    createAgentDispatchMessage(
      "agent-dispatch",
      "@Build",
      ["Build"],
      "@Build",
      DEFAULT_SENDER,
      DEFAULT_TIMESTAMP,
    ),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0]?.content,
    "这是分析过程。\n\n## 正式结果\n给定 a = 1、b = 2 时，返回 c = 3\n\n@Build",
  );
});

test("spawn 实例消息在聊天展示中优先使用 senderDisplayName，保留模板名和实例 id", () => {
  const merged = mergeTaskChatMessages([
    createNamedDefaultAgentFinalMessage(
      "spawn-task-decision-final",
      "这版已经达到可交付标准。",
      "TaskReview-1",
      DEFAULT_TIMESTAMP,
      "TaskReview-1",
    ),
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
    createDefaultAgentFinalMessage(
      "agent-final",
      summary,
      DEFAULT_SENDER,
      DEFAULT_TIMESTAMP,
    ),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.content, summary);
});

test("聊天消息里的正文空行需要保留，不能在消息链路里被压缩", () => {
  const merged = mergeTaskChatMessages([
    createDefaultAgentFinalMessage(
      "agent-final-blank-lines",
      "第一段\n\n第二段\n\n```ts\nconst done = true;\n```",
      "Build",
      DEFAULT_TIMESTAMP,
    ),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0]?.content,
    "第一段\n\n第二段\n\n```ts\nconst done = true;\n```",
  );
});

test("action_required 判定正文命中结论标题时，聊天展示不能只截取最后的结论章节", () => {
  const merged = mergeTaskChatMessages([
    createLabeledAgentFinalMessage(
      "agent-final-needs-continue-heading",
      "## 结论\n所以我仍然维持上一轮的收敛判断：\n目前代码证明的是“缺失主机名时回退默认虚拟主机的实现行为”，\n但还不足以仅凭源码坐实真实可利用的虚拟主机绕过漏洞。",
      `${EXAMPLE_TRIGGER_LABEL}## 结论\n所以我仍然维持上一轮的收敛判断：\n目前代码证明的是“缺失主机名时回退默认虚拟主机的实现行为”，\n但还不足以仅凭源码坐实真实可利用的虚拟主机绕过漏洞。${EXAMPLE_TRIGGER_END_LABEL}`,
      "## 结论\n所以我仍然维持上一轮的收敛判断：\n目前代码证明的是“缺失主机名时回退默认虚拟主机的实现行为”，\n但还不足以仅凭源码坐实真实可利用的虚拟主机绕过漏洞。",
      "<continue>",
      "漏洞挑战-1",
      DEFAULT_TIMESTAMP,
    ),
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
    createLabeledAgentFinalMessage(
      "decisionAgent-final",
      decisionBody,
      `${EXAMPLE_TRIGGER_LABEL}${decisionBody}${EXAMPLE_TRIGGER_END_LABEL}`,
      decisionBody,
      "<continue>",
      "漏洞挑战-1",
      DEFAULT_TIMESTAMP,
    ),
    createAgentDispatchMessage(
      "dispatch-to-summary",
      "",
      ["讨论总结-1"],
      loopLimitNotice,
      "漏洞挑战-1",
      DEFAULT_TIMESTAMP,
    ),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.content, `${decisionBody}\n\n@讨论总结-1`);
});

test("实现结果后连续派发 decisionAgent 时，群聊会去掉尾部追问并折叠重复 mention", () => {
  const merged = mergeTaskChatMessages([
    createDefaultAgentFinalMessage(
      "build-final",
      `已把重复校验收成一条统一路径。

验证结果：
\`.venv/bin/python -m pytest\`
\`10 passed\`

如果你愿意，我可以继续把函数和测试再压到一个更极简、但仍可读的版本。`,
      "Build",
      "2026-04-24T15:54:14.000Z",
    ),
    createAgentDispatchMessage(
      "build-dispatch-1",
      "@UnitTest @TaskReview",
      ["UnitTest", "TaskReview"],
      "@UnitTest @TaskReview",
      "Build",
      "2026-04-24T15:54:21.000Z",
    ),
    createAgentDispatchMessage(
      "build-dispatch-2",
      "@UnitTest @TaskReview",
      ["UnitTest", "TaskReview"],
      "@UnitTest @TaskReview",
      "Build",
      "2026-04-24T15:54:21.100Z",
    ),
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
    createAgentDispatchMessage(
      "build-dispatch-with-trailing-mention",
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
      ["UnitTest", "TaskReview"],
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
      "Build",
      "2026-04-24T15:54:21.886Z",
    ),
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
