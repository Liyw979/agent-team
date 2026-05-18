import { test } from "bun:test";
import assert from "node:assert/strict";
import { resolveAppPanelVisibility } from "./app-panel-visibility";

test("默认模式展示拓扑与消息两个主面板", () => {
  assert.deepEqual(resolveAppPanelVisibility("default"), {
    showTopologyPanel: true,
    showChatPanel: true,
  });
});

test("消息放大模式只显示消息面板", () => {
  assert.deepEqual(resolveAppPanelVisibility("chat-only"), {
    showTopologyPanel: false,
    showChatPanel: true,
  });
});

test("拓扑全屏模式只显示拓扑面板", () => {
  assert.deepEqual(resolveAppPanelVisibility("topology-only"), {
    showTopologyPanel: true,
    showChatPanel: false,
  });
});
