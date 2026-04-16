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
        content: "Task 已创建并完成初始化, Zellij Session: oap-d82886-552138",
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
      "Ocustrater",
      "2026/4/16 16:31:59",
      "Task 已创建并完成初始化, Zellij Session: oap-d82886-552138",
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
