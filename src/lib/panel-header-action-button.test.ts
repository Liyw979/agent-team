import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readSource(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("仍然存在头部操作按钮的面板统一复用同一套样式令牌", () => {
  const appSource = readSource("../App.tsx");
  const chatWindowSource = readSource("../components/ChatWindow.tsx");
  const topologyGraphSource = readSource("../components/TopologyGraph.tsx");

  assert.match(appSource, /PANEL_HEADER_ACTION_BUTTON_CLASS|getPanelHeaderActionButtonClass/);
  assert.match(chatWindowSource, /PANEL_HEADER_ACTION_BUTTON_CLASS|getPanelHeaderActionButtonClass/);
  assert.doesNotMatch(topologyGraphSource, /PANEL_HEADER_ACTION_BUTTON_CLASS|getPanelHeaderActionButtonClass/);
});
