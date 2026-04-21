import test from "node:test";
import assert from "node:assert/strict";

import { getAppWorkspaceLayoutMetrics } from "./app-workspace-layout";

test("主布局间距缩小 50%，团队面板宽度增加 20%", () => {
  const metrics = getAppWorkspaceLayoutMetrics();

  assert.deepEqual(metrics, {
    panelGapPx: 5,
    teamPanelMinWidthPx: 408,
    teamPanelMaxWidthPx: 456,
  });
});
