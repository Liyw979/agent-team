import test from "node:test";
import assert from "node:assert/strict";

import { buildTopologyCanvasLayout } from "./topology-canvas";

test("buildTopologyCanvasLayout 会按节点顺序生成从左到右的布局和边路径", () => {
  const layout = buildTopologyCanvasLayout({
    nodes: ["BA", "Build", "TaskReview"],
    edges: [
      { source: "BA", target: "Build", triggerOn: "association" },
      { source: "Build", target: "TaskReview", triggerOn: "approved" },
    ],
    columnWidth: 200,
    columnGap: 40,
    sidePadding: 20,
    topPadding: 10,
    laneHeight: 50,
    nodeHeight: 260,
  });

  assert.equal(layout.width, 720);
  assert.equal(layout.height, 340);
  assert.deepEqual(
    layout.nodes.map((node) => ({ id: node.id, x: node.x, y: node.y })),
    [
      { id: "BA", x: 20, y: 60 },
      { id: "Build", x: 260, y: 60 },
      { id: "TaskReview", x: 500, y: 60 },
    ],
  );
  assert.equal(layout.edges.length, 2);
  assert.match(layout.edges[0]?.path ?? "", /^M /);
  assert.match(layout.edges[1]?.path ?? "", /^M /);
});
