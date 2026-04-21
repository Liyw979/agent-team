import test from "node:test";
import assert from "node:assert/strict";

import { getTopologyPanelBodyClassName, getTopologyPanelBodyPadding } from "./topology-panel-layout";

test("拓扑面板内容区应比普通面板更贴边，避免四周留白过大", () => {
  const padding = getTopologyPanelBodyPadding();

  assert.deepEqual(padding, {
    x: 6,
    y: 4,
  });
  assert.ok(padding.x < 20);
  assert.ok(padding.y < 8);
  assert.equal(getTopologyPanelBodyClassName(), "px-[6px] py-[4px]");
});
