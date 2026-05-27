import { test } from "bun:test";
import assert from "node:assert/strict";

import type {
  AgentDispatchMessageRecord,
  AgentFinalMessageRecord,
  TopologyTrigger,
} from "@shared/types";
import { toUtcIsoTimestamp } from "@shared/types";

import { mergeTaskChatMessages } from "../lib/chat-messages";

const TASK_ID = "task-id";
const TIMESTAMP = "2026-04-14T12:00:00.000Z";
const DEFAULT_DISPLAY_NAME = { kind: "default" } as const;
const CONTENT_RESPONSE = { kind: "content" } as const;
const CONTENT_DISPLAY = { kind: "content" } as const;

type AgentFinalMessageInputBase = {
  id: string;
  sender: string;
  content: string;
  displayName:
    | { kind: "default" }
    | { kind: "custom"; value: string };
  response:
    | { kind: "content" }
    | { kind: "raw"; rawResponse: string };
};

type AgentFinalMessageInput = AgentFinalMessageInputBase & (
  | { routingKind: "default" }
  | { routingKind: "triggered"; trigger: TopologyTrigger }
);

function createAgentFinalMessage(input: AgentFinalMessageInput): AgentFinalMessageRecord {
  const rawResponse = input.response.kind === "raw" ? input.response.rawResponse : input.content;
  const displayName = input.displayName.kind === "custom"
    ? { senderDisplayName: input.displayName.value }
    : {};
  const base: Omit<AgentFinalMessageRecord, "routingKind" | "trigger"> = {
    id: input.id,
    taskId: TASK_ID,
    content: input.content,
    sender: input.sender,
    timestamp: toUtcIsoTimestamp(TIMESTAMP),
    kind: "agent-final" as const,
    runCount: 1,
    status: "completed",
    rawResponse,
    ...displayName,
  };
  if (input.routingKind === "triggered") {
    return {
      ...base,
      routingKind: "triggered",
      trigger: input.trigger,
    } satisfies AgentFinalMessageRecord;
  }

  return {
    ...base,
    routingKind: "default",
  } satisfies AgentFinalMessageRecord;
}

function createAgentDispatchMessage(input: {
  id: string;
  sender: string;
  content: string;
  targetAgentIds: string[];
  displayContent:
    | { kind: "content" }
    | { kind: "custom"; value: string };
}): AgentDispatchMessageRecord {
  return {
    id: input.id,
    taskId: TASK_ID,
    content: input.content,
    sender: input.sender,
    timestamp: toUtcIsoTimestamp(TIMESTAMP),
    kind: "agent-dispatch",
    targetAgentIds: input.targetAgentIds,
    targetRunCounts: input.targetAgentIds.map(() => 1),
    dispatchDisplayContent: input.displayContent.kind === "custom" ? input.displayContent.value : input.content,
  };
}

function requireArrayItem<T>(items: T[], index: number, description: string): T {
  const item = items[index];
  if (!item) {
    assert.fail(`${description} 不存在：${index}`);
  }
  return item;
}

test("agent-final 后接 agent-dispatch 时会合并为单条聊天消息，并保留 mention", () => {
  const merged = mergeTaskChatMessages([
    createAgentFinalMessage({
      id: "final",
      sender: "误报论证-1",
      content: "当前证据仍不足以证明越权成立。",
      displayName: DEFAULT_DISPLAY_NAME,
      response: CONTENT_RESPONSE,
      routingKind: "triggered",
      trigger: "<continue>",
    }),
    createAgentDispatchMessage({
      id: "dispatch",
      sender: "误报论证-1",
      content: "@讨论总结-1",
      targetAgentIds: ["讨论总结-1"],
      displayContent: CONTENT_DISPLAY,
    }),
  ]);

  assert.equal(merged.length, 1);
  const first = requireArrayItem(merged, 0, "第一条合并消息");
  assert.equal(
    first.content,
    "当前证据仍不足以证明越权成立。\n\n@讨论总结-1",
  );
  assert.deepEqual(first.kinds, ["agent-final", "agent-dispatch"]);
});

test("连续 agent-dispatch 会合并 mention 集合，并去重正文", () => {
  const merged = mergeTaskChatMessages([
    createAgentDispatchMessage({
      id: "dispatch-1",
      sender: "Build",
      content: "请先做代码审查。\n\n@CodeReview",
      targetAgentIds: ["CodeReview"],
      displayContent: CONTENT_DISPLAY,
    }),
    createAgentDispatchMessage({
      id: "dispatch-2",
      sender: "Build",
      content: "请先做代码审查。\n\n@UnitTest",
      targetAgentIds: ["UnitTest"],
      displayContent: CONTENT_DISPLAY,
    }),
  ]);

  assert.equal(merged.length, 1);
  const first = requireArrayItem(merged, 0, "第一条合并消息");
  assert.equal(
    first.content,
    "请先做代码审查。\n\n@CodeReview @UnitTest",
  );
  assert.deepEqual(first.kinds, ["agent-dispatch", "agent-dispatch"]);
});

test("不同 sender 的消息不会被错误合并", () => {
  const merged = mergeTaskChatMessages([
    createAgentFinalMessage({
      id: "final-1",
      sender: "Build",
      content: "Build 已完成实现。",
      displayName: DEFAULT_DISPLAY_NAME,
      response: CONTENT_RESPONSE,
      routingKind: "default",
    }),
    createAgentDispatchMessage({
      id: "dispatch-1",
      sender: "CodeReview",
      content: "@TaskReview",
      targetAgentIds: ["TaskReview"],
      displayContent: CONTENT_DISPLAY,
    }),
  ]);

  assert.equal(merged.length, 2);
});

test("final 正文末尾的跟进建议会在与 dispatch 合并时保留", () => {
  const merged = mergeTaskChatMessages([
    createAgentFinalMessage({
      id: "final",
      sender: "Build",
      content: "实现已完成。\n\n如果你需要，我也可以继续补测试。",
      displayName: DEFAULT_DISPLAY_NAME,
      response: CONTENT_RESPONSE,
      routingKind: "default",
    }),
    createAgentDispatchMessage({
      id: "dispatch",
      sender: "Build",
      content: "@CodeReview",
      targetAgentIds: ["CodeReview"],
      displayContent: CONTENT_DISPLAY,
    }),
  ]);

  assert.equal(merged.length, 1);
  const first = requireArrayItem(merged, 0, "第一条合并消息");
  assert.equal(first.content, "实现已完成。\n\n如果你需要，我也可以继续补测试。\n\n@CodeReview");
});

test("triggered agent-final 展示直接使用已归一化正文，不重新解析 rawResponse", () => {
  const merged = mergeTaskChatMessages([
    createAgentFinalMessage({
      id: "final",
      sender: "线索发现",
      content: "发现新的可疑点，继续后续流程。",
      displayName: DEFAULT_DISPLAY_NAME,
      response: {
        kind: "raw",
        rawResponse: "<continue>发现新的可疑点，继续后续流程。",
      },
      routingKind: "triggered",
      trigger: "<continue>",
    }),
  ]);

  assert.equal(merged.length, 1);
  const first = requireArrayItem(merged, 0, "第一条合并消息");
  assert.equal(first.content, "发现新的可疑点，继续后续流程。");
});

test("triggered agent-final 已包含补充说明正文时，与 dispatch 合并只追加 mention", () => {
  const content = "当前只能确认这里没有看到强制拒绝缺失主机标识的分支。\n\n还需要补证：缺失 host 的 HTTP/2 请求是否真的会进入目标敏感应用。";
  const merged = mergeTaskChatMessages([
    createAgentFinalMessage({
      id: "final",
      sender: "误报论证-1",
      content,
      displayName: DEFAULT_DISPLAY_NAME,
      response: {
        kind: "raw",
        rawResponse: `<continue>${content}</continue>`,
      },
      routingKind: "triggered",
      trigger: "<continue>",
    }),
    createAgentDispatchMessage({
      id: "dispatch",
      sender: "误报论证-1",
      content: "@漏洞论证-1",
      targetAgentIds: ["漏洞论证-1"],
      displayContent: CONTENT_DISPLAY,
    }),
  ]);

  assert.equal(merged.length, 1);
  const first = requireArrayItem(merged, 0, "第一条合并消息");
  assert.equal(first.content, `${content}\n\n@漏洞论证-1`);
});

test("triggered agent-final 的 rawResponse 尾部重复 trigger 时仍按正文与 dispatch 合并", () => {
  const content = "当前只能确认这里没有看到强制拒绝缺失主机标识的分支。\n\n还需要补证：缺失 host 的 HTTP/2 请求是否真的会进入目标敏感应用。";
  const merged = mergeTaskChatMessages([
    createAgentFinalMessage({
      id: "final",
      sender: "误报论证-1",
      content,
      displayName: DEFAULT_DISPLAY_NAME,
      response: {
        kind: "raw",
        rawResponse: `<continue>\n${content}\n\n<continue>`,
      },
      routingKind: "triggered",
      trigger: "<continue>",
    }),
    createAgentDispatchMessage({
      id: "dispatch",
      sender: "误报论证-1",
      content: "@漏洞论证-1",
      targetAgentIds: ["漏洞论证-1"],
      displayContent: CONTENT_DISPLAY,
    }),
  ]);

  assert.equal(merged.length, 1);
  const first = requireArrayItem(merged, 0, "第一条合并消息");
  assert.equal(first.content, `${content}\n\n@漏洞论证-1`);
});

test("triggered agent-final 的正文包含其他 trigger 示例时，与 dispatch 合并保留示例文本", () => {
  const content = "请检查示例 <complete>done</complete> 是否出现在文档中";
  const merged = mergeTaskChatMessages([
    createAgentFinalMessage({
      id: "final",
      sender: "误报论证-1",
      content,
      displayName: DEFAULT_DISPLAY_NAME,
      response: {
        kind: "raw",
        rawResponse: `<continue>${content}</continue>`,
      },
      routingKind: "triggered",
      trigger: "<continue>",
    }),
    createAgentDispatchMessage({
      id: "dispatch",
      sender: "误报论证-1",
      content: "@漏洞论证-1",
      targetAgentIds: ["漏洞论证-1"],
      displayContent: CONTENT_DISPLAY,
    }),
  ]);

  assert.equal(merged.length, 1);
  const first = requireArrayItem(merged, 0, "第一条合并消息");
  assert.equal(first.content, `${content}\n\n@漏洞论证-1`);
});

test("triggered agent-final 的正文包含同名 trigger 示例时，与 dispatch 合并保留示例文本", () => {
  const content = "请检查示例 <continue>done</continue> 是否出现在文档中";
  const merged = mergeTaskChatMessages([
    createAgentFinalMessage({
      id: "final",
      sender: "误报论证-1",
      content,
      displayName: DEFAULT_DISPLAY_NAME,
      response: {
        kind: "raw",
        rawResponse: `<continue>${content}</continue>`,
      },
      routingKind: "triggered",
      trigger: "<continue>",
    }),
    createAgentDispatchMessage({
      id: "dispatch",
      sender: "误报论证-1",
      content: "@漏洞论证-1",
      targetAgentIds: ["漏洞论证-1"],
      displayContent: CONTENT_DISPLAY,
    }),
  ]);

  assert.equal(merged.length, 1);
  const first = requireArrayItem(merged, 0, "第一条合并消息");
  assert.equal(first.content, `${content}\n\n@漏洞论证-1`);
});

test("triggered agent-final 的开头包裹 trigger 后仍有尾随正文时，与 dispatch 合并保留尾随正文", () => {
  const content = "请继续补证。\n\n补充说明";
  const merged = mergeTaskChatMessages([
    createAgentFinalMessage({
      id: "final",
      sender: "误报论证-1",
      content,
      displayName: DEFAULT_DISPLAY_NAME,
      response: {
        kind: "raw",
        rawResponse: "<continue>请继续补证。</continue>补充说明",
      },
      routingKind: "triggered",
      trigger: "<continue>",
    }),
    createAgentDispatchMessage({
      id: "dispatch",
      sender: "误报论证-1",
      content: "@漏洞论证-1",
      targetAgentIds: ["漏洞论证-1"],
      displayContent: CONTENT_DISPLAY,
    }),
  ]);

  assert.equal(merged.length, 1);
  const first = requireArrayItem(merged, 0, "第一条合并消息");
  assert.equal(first.content, "请继续补证。\n\n补充说明\n\n@漏洞论证-1");
});

test("triggered agent-final 的正文从第一个字符开始就是 trigger 示例时不会误删示例文本", () => {
  const merged = mergeTaskChatMessages([
    createAgentFinalMessage({
      id: "final",
      sender: "线索发现",
      content: "<continue>done</continue> 是示例",
      displayName: DEFAULT_DISPLAY_NAME,
      response: {
        kind: "raw",
        rawResponse: "<continue><continue>done</continue> 是示例</continue>",
      },
      routingKind: "triggered",
      trigger: "<continue>",
    }),
  ]);

  assert.equal(merged.length, 1);
  const first = requireArrayItem(merged, 0, "第一条合并消息");
  assert.equal(first.content, "<continue>done</continue> 是示例");
});

test("agent-final 展示时会保留非结构化孤立结束标签", () => {
  const merged = mergeTaskChatMessages([
    createAgentFinalMessage({
      id: "final",
      sender: "BA",
      content: "</continue>继续处理。\n\n请补充实现依据。",
      displayName: DEFAULT_DISPLAY_NAME,
      response: CONTENT_RESPONSE,
      routingKind: "default",
    }),
  ]);

  assert.equal(merged.length, 1);
  const first = requireArrayItem(merged, 0, "第一条合并消息");
  assert.equal(first.content, "</continue>继续处理。\n\n请补充实现依据。");
});

test("agent-final 与 agent-dispatch 合并时会保留正文并追加目标 mention", () => {
  const content = "这是分析过程。\n\n## 正式结果\n给定 a = 1、b = 2 时，返回 c = 3";
  const merged = mergeTaskChatMessages([
    createAgentFinalMessage({
      id: "final",
      sender: "BA",
      content,
      displayName: DEFAULT_DISPLAY_NAME,
      response: CONTENT_RESPONSE,
      routingKind: "default",
    }),
    createAgentDispatchMessage({
      id: "dispatch",
      sender: "BA",
      content: "@Build",
      targetAgentIds: ["Build"],
      displayContent: CONTENT_DISPLAY,
    }),
  ]);

  assert.equal(merged.length, 1);
  const first = requireArrayItem(merged, 0, "第一条合并消息");
  assert.equal(first.content, `${content}\n\n@Build`);
});

test("group 实例消息优先使用 senderDisplayName", () => {
  const merged = mergeTaskChatMessages([
    createAgentFinalMessage({
      id: "final",
      sender: "TaskReview-1",
      content: "这版已经达到可交付标准。",
      displayName: { kind: "custom", value: "TaskReview-1" },
      response: CONTENT_RESPONSE,
      routingKind: "default",
    }),
  ]);

  assert.equal(merged.length, 1);
  const first = requireArrayItem(merged, 0, "第一条合并消息");
  assert.equal(first.sender, "TaskReview-1");
});

test("未命中正式交付标题时保留完整结构化正文", () => {
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
    createAgentFinalMessage({
      id: "final",
      sender: "BA",
      content: summary,
      displayName: DEFAULT_DISPLAY_NAME,
      response: CONTENT_RESPONSE,
      routingKind: "default",
    }),
  ]);

  assert.equal(merged.length, 1);
  const first = requireArrayItem(merged, 0, "第一条合并消息");
  assert.equal(first.content, summary);
});

test("聊天消息里的正文空行会保留", () => {
  const merged = mergeTaskChatMessages([
    createAgentFinalMessage({
      id: "final",
      sender: "Build",
      content: "第一段\n\n第二段\n\n```ts\nconst done = true;\n```",
      displayName: DEFAULT_DISPLAY_NAME,
      response: CONTENT_RESPONSE,
      routingKind: "default",
    }),
  ]);

  assert.equal(merged.length, 1);
  const first = requireArrayItem(merged, 0, "第一条合并消息");
  assert.equal(first.content, "第一段\n\n第二段\n\n```ts\nconst done = true;\n```");
});

test("trigger 判定正文命中结论标题时不会只截取最后的结论章节", () => {
  const content = "## 结论\n所以我仍然维持上一轮判断：\n目前代码证明的行为还不足以坐实真实可利用漏洞。";
  const merged = mergeTaskChatMessages([
    createAgentFinalMessage({
      id: "final",
      sender: "误报论证-1",
      content,
      displayName: DEFAULT_DISPLAY_NAME,
      response: {
        kind: "raw",
        rawResponse: `<continue>${content}</continue>`,
      },
      routingKind: "triggered",
      trigger: "<continue>",
    }),
  ]);

  assert.equal(merged.length, 1);
  const first = requireArrayItem(merged, 0, "第一条合并消息");
  assert.equal(first.content, content);
});

test("超限转派到其他 trigger 下游时只保留正文并追加目标 mention", () => {
  const merged = mergeTaskChatMessages([
    createAgentFinalMessage({
      id: "final",
      sender: "误报论证-1",
      content: "当前证据仍不足以证明越权成立。",
      displayName: DEFAULT_DISPLAY_NAME,
      response: CONTENT_RESPONSE,
      routingKind: "triggered",
      trigger: "<continue>",
    }),
    createAgentDispatchMessage({
      id: "dispatch",
      sender: "误报论证-1",
      content: "",
      targetAgentIds: ["讨论总结-1"],
      displayContent: { kind: "custom", value: "误报论证-1 -> 漏洞论证-1 已连续交流 4 次" },
    }),
  ]);

  assert.equal(merged.length, 1);
  const first = requireArrayItem(merged, 0, "第一条合并消息");
  assert.equal(first.content, "当前证据仍不足以证明越权成立。\n\n@讨论总结-1");
});

test("实现结果后连续派发 decisionAgent 时会保留尾部追问并折叠重复 mention", () => {
  const merged = mergeTaskChatMessages([
    createAgentFinalMessage({
      id: "final",
      sender: "Build",
      content: "已完成实现。\n\n验证结果：\n`10 passed`\n\n如果你愿意，我可以继续补测试。",
      displayName: DEFAULT_DISPLAY_NAME,
      response: CONTENT_RESPONSE,
      routingKind: "default",
    }),
    createAgentDispatchMessage({
      id: "dispatch-1",
      sender: "Build",
      content: "@UnitTest @TaskReview",
      targetAgentIds: ["UnitTest", "TaskReview"],
      displayContent: CONTENT_DISPLAY,
    }),
    createAgentDispatchMessage({
      id: "dispatch-2",
      sender: "Build",
      content: "@UnitTest @TaskReview",
      targetAgentIds: ["UnitTest", "TaskReview"],
      displayContent: CONTENT_DISPLAY,
    }),
  ]);

  assert.equal(merged.length, 1);
  const first = requireArrayItem(merged, 0, "第一条合并消息");
  assert.equal(first.content, "已完成实现。\n\n验证结果：\n`10 passed`\n\n如果你愿意，我可以继续补测试。\n\n@UnitTest @TaskReview");
});

test("单条 dispatch 自身已包含尾部 mention 时不会重复追加", () => {
  const content = "已完成实现。\n\n@UnitTest @TaskReview";
  const merged = mergeTaskChatMessages([
    createAgentDispatchMessage({
      id: "dispatch",
      sender: "Build",
      content,
      targetAgentIds: ["UnitTest", "TaskReview"],
      displayContent: CONTENT_DISPLAY,
    }),
  ]);

  assert.equal(merged.length, 1);
  const first = requireArrayItem(merged, 0, "第一条合并消息");
  assert.equal(first.content, content);
});

test("连续 dispatch 在正文相同且 mention 重叠时会去重 mention", () => {
  const merged = mergeTaskChatMessages([
    createAgentDispatchMessage({
      id: "dispatch-1",
      sender: "Build",
      content: "请先做代码审查。\n\n@CodeReview @UnitTest",
      targetAgentIds: ["CodeReview", "UnitTest"],
      displayContent: CONTENT_DISPLAY,
    }),
    createAgentDispatchMessage({
      id: "dispatch-2",
      sender: "Build",
      content: "请先做代码审查。\n\n@UnitTest @TaskReview",
      targetAgentIds: ["UnitTest", "TaskReview"],
      displayContent: CONTENT_DISPLAY,
    }),
  ]);

  assert.equal(merged.length, 1);
  const first = requireArrayItem(merged, 0, "第一条合并消息");
  assert.equal(first.content, "请先做代码审查。\n\n@CodeReview @UnitTest @TaskReview");
});
