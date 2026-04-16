import test from "node:test";
import assert from "node:assert/strict";

import {
  getOpenAgentTerminalButtonLabel,
  getOpenAgentTerminalButtonTitle,
} from "./App";

test("团队成员卡片按钮文案使用终端而不是 Pane", () => {
  assert.equal(getOpenAgentTerminalButtonLabel(false), "打开终端");
  assert.equal(getOpenAgentTerminalButtonLabel(true), "打开中...");
  assert.equal(
    getOpenAgentTerminalButtonTitle("Build", true),
    "打开 Build 对应的 OpenCode 独立终端窗口",
  );
  assert.equal(getOpenAgentTerminalButtonTitle("Build", false), "请先选择一个 Task");
  assert.doesNotMatch(getOpenAgentTerminalButtonLabel(false), /Pane/);
  assert.doesNotMatch(getOpenAgentTerminalButtonTitle("Build", true), /Pane/);
});
