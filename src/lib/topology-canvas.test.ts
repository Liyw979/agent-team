import test from "node:test";
import assert from "node:assert/strict";

import { buildTopologyCanvasLayout } from "./topology-canvas";

test("buildTopologyCanvasLayout 会按面板宽高把节点横向纵向铺满", () => {
  const layout = buildTopologyCanvasLayout({
    nodes: ["BA", "Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      { source: "BA", target: "Build", triggerOn: "association" },
      { source: "Build", target: "CodeReview", triggerOn: "approved" },
    ],
    availableWidth: 1860,
    availableHeight: 360,
    columnGap: 20,
    sidePadding: 20,
    topPadding: 10,
    bottomPadding: 10,
  });

  assert.equal(layout.width, 1860);
  assert.equal(layout.height, 360);
  assert.deepEqual(
    layout.nodes.map((node) => ({
      id: node.id,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    })),
    [
      { id: "BA", x: 20, y: 10, width: 348, height: 340 },
      { id: "Build", x: 388, y: 10, width: 348, height: 340 },
      { id: "CodeReview", x: 756, y: 10, width: 348, height: 340 },
      { id: "UnitTest", x: 1124, y: 10, width: 348, height: 340 },
      { id: "TaskReview", x: 1492, y: 10, width: 348, height: 340 },
    ],
  );
  assert.equal(layout.edges.length, 0);
});

test("buildTopologyCanvasLayout 在小屏下不能把最后一个节点排到视口外", () => {
  const layout = buildTopologyCanvasLayout({
    nodes: ["BA", "Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [],
    availableWidth: 1024,
    availableHeight: 360,
    columnWidth: 248,
    minNodeWidth: 248,
    minNodeHeight: 308,
    columnGap: 18,
    sidePadding: 0,
    topPadding: 0,
    bottomPadding: 0,
    nodeHeight: 308,
  });

  const lastNode = layout.nodes.at(-1);
  assert.ok(lastNode);
  assert.equal(layout.width, 1024);
  assert.ok(lastNode.x + lastNode.width <= 1024);
});

test("buildTopologyCanvasLayout 在换成两行时也必须继续铺满视口而不是把节点排到面板外", () => {
  const layout = buildTopologyCanvasLayout({
    nodes: ["BA", "Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [],
    availableWidth: 900,
    availableHeight: 360,
    columnWidth: 248,
    minNodeWidth: 248,
    minNodeHeight: 308,
    columnGap: 18,
    sidePadding: 0,
    topPadding: 0,
    bottomPadding: 0,
    nodeHeight: 308,
  });

  const rowTops = [...new Set(layout.nodes.map((node) => node.y))];
  assert.equal(layout.width, 900);
  assert.equal(layout.height, 360);
  assert.deepEqual(rowTops, [0, 187]);
  assert.deepEqual(
    rowTops.map((rowTop) => layout.nodes.filter((node) => node.y === rowTop).length),
    [3, 2],
  );
  assert.ok(layout.nodes.every((node) => node.x + node.width <= 900));
  assert.ok(layout.nodes.every((node) => node.y + node.height <= 360));
});

test("buildTopologyCanvasLayout 在高度比默认卡片更小时也必须压回视口内", () => {
  const layout = buildTopologyCanvasLayout({
    nodes: ["BA", "Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [],
    availableWidth: 1254,
    availableHeight: 300,
    columnWidth: 248,
    minNodeWidth: 248,
    minNodeHeight: 308,
    columnGap: 18,
    sidePadding: 0,
    topPadding: 0,
    bottomPadding: 0,
    nodeHeight: 308,
  });

  assert.equal(layout.width, 1254);
  assert.equal(layout.height, 300);
  assert.ok(layout.nodes.every((node) => node.x + node.width <= 1254));
  assert.ok(layout.nodes.every((node) => node.y + node.height <= 300));
});
