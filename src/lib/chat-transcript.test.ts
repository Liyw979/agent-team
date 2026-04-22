import test from "node:test";
import assert from "node:assert/strict";

import { formatChatTranscript } from "./chat-transcript";

test("formatChatTranscript 会把聊天消息整理成可复制的对话记录", () => {
  const transcript = formatChatTranscript(
    [
      {
        id: "m1",
        sender: "system",
        timestamp: "2026-04-16T16:31:59.000Z",
        content: "Task 已创建并完成初始化",
        kinds: [],
        metaChain: [],
      },
      {
        id: "m2",
        sender: "Build",
        timestamp: "2026-04-16T16:33:11.000Z",
        content: "已经在项目根目录创建了临时加法工具 `temp_add.py`。",
        kinds: ["agent-final"],
        metaChain: [],
      },
    ],
    {
      locale: "zh-CN",
      timeZone: "UTC",
    },
  );

  assert.equal(
    transcript,
    [
      "Orchestrator",
      "2026/4/16 16:31:59",
      "Task 已创建并完成初始化",
      "",
      "Build",
      "2026/4/16 16:33:11",
      "已经在项目根目录创建了临时加法工具 `temp_add.py`。",
    ].join("\n"),
  );
});

test("formatChatTranscript 会在复制记录头部带上日志路径和网页地址", () => {
  const transcript = formatChatTranscript(
    [
      {
        id: "m1",
        sender: "Build",
        timestamp: "2026-04-16T16:33:11.000Z",
        content: "已经在项目根目录创建了临时加法工具 `temp_add.py`。",
        kinds: ["agent-final"],
        metaChain: [],
      },
    ],
    {
      locale: "zh-CN",
      timeZone: "UTC",
      logFilePath: "/Users/demo/Library/Application Support/agent-team/logs/tasks/task-123.log",
      taskUrl: "http://localhost:4310/?taskId=task-123",
    },
  );

  assert.equal(
    transcript,
    [
      "日志: /Users/demo/Library/Application Support/agent-team/logs/tasks/task-123.log",
      "url: http://localhost:4310/?taskId=task-123",
      "",
      "Build",
      "2026/4/16 16:33:11",
      "已经在项目根目录创建了临时加法工具 `temp_add.py`。",
    ].join("\n"),
  );
});

test("formatChatTranscript 在没有消息时返回空字符串", () => {
  assert.equal(formatChatTranscript([]), "");
});

test("formatChatTranscript 会保留 spawn 实例的 senderDisplayName", () => {
  const transcript = formatChatTranscript(
    [
      {
        id: "spawn-message",
        sender: "TaskReview-1",
        senderDisplayName: "TaskReview-1",
        timestamp: "2026-04-19T10:36:50.000Z",
        content: "我认可这版已经达到可交付标准。",
        kinds: ["agent-final"],
        metaChain: [],
      },
    ],
    {
      locale: "zh-CN",
      timeZone: "UTC",
    },
  );

  assert.equal(
    transcript,
    [
      "TaskReview-1",
      "2026/4/19 10:36:50",
      "我认可这版已经达到可交付标准。",
    ].join("\n"),
  );
});
