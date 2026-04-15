import test from "node:test";
import assert from "node:assert/strict";

import { getMentionOptions } from "./chat-mentions";

test("mention 候选列表保持当前项目 Agent 顺序", () => {
  const options = getMentionOptions(["Build", "安全负责人", "漏洞分析人员"], "");

  assert.deepEqual(options, ["Build", "安全负责人", "漏洞分析人员"]);
});

test("mention 候选列表筛选时保持原有顺序而不重排", () => {
  const options = getMentionOptions(["Build", "安全负责人", "漏洞分析人员"], "人");

  assert.deepEqual(options, ["安全负责人", "漏洞分析人员"]);
});
