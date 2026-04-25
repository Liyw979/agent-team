import test from "node:test";
import assert from "node:assert/strict";

import { getTopologyCanvasViewportMeasurementKey } from "./topology-canvas-viewport-measure";

test("拓扑从空白占位切到有可见节点时，视口测量键必须变化，确保会重新挂上测量逻辑", () => {
  const beforeRender = getTopologyCanvasViewportMeasurementKey({
    topologyNodeCount: 4,
    topologyNodeRecordCount: 4,
    hasRenderableCanvas: false,
  });
  const afterRender = getTopologyCanvasViewportMeasurementKey({
    topologyNodeCount: 4,
    topologyNodeRecordCount: 4,
    hasRenderableCanvas: true,
  });

  assert.notEqual(afterRender, beforeRender);
});
