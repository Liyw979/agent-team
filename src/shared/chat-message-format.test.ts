import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(new URL("./chat-message-format.ts", import.meta.url), "utf8");

test("聊天消息格式化只接受 string[] 目标列表，不再接受 string 或 undefined 混合输入", () => {
  assert.equal(SOURCE.includes("string[] | string | undefined"), false);
  assert.equal(SOURCE.includes("string[] | string"), false);
  assert.match(SOURCE, /parseTargetAgentIds\(value: string\[\]\): string\[\]/u);
  assert.match(SOURCE, /formatActionRequiredRequestContent\(content: string, targetAgentIds: string\[\]\): string/u);
});
