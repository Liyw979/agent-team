import { test } from "bun:test";
import assert from "node:assert/strict";

import { buildTopologyCanvasLayout } from "./topology-canvas";

test("buildTopologyCanvasLayout 会按面板宽高把节点横向纵向铺满", () => {
  const layout = buildTopologyCanvasLayout({
    nodes: ["BA", "Build", "CodeReview", "UnitTest", "TaskReview"],
    edges: [
      { source: "BA", target: "Build", trigger: "<default>", messageMode: "last", maxTriggerRounds: 4 },
      { source: "Build", target: "CodeReview", trigger: "<complete>", messageMode: "last", maxTriggerRounds: 4 },
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

test("buildTopologyCanvasLayout 在只剩两个节点时也必须继续横向铺满整个拓扑区域", () => {
  const layout = buildTopologyCanvasLayout({
    nodes: ["线索发现", "误报论证"],
    edges: [],
    availableWidth: 2048,
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

  assert.equal(layout.width, 2048);
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
      { id: "线索发现", x: 0, y: 0, width: 1015, height: 360 },
      { id: "误报论证", x: 1033, y: 0, width: 1015, height: 360 },
    ],
  );
});

test("buildTopologyCanvasLayout 在只剩一个节点时也必须横向纵向同时铺满整个拓扑区域", () => {
  const layout = buildTopologyCanvasLayout({
    nodes: ["线索发现"],
    edges: [],
    availableWidth: 2048,
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

  assert.equal(layout.width, 2048);
  assert.equal(layout.height, 360);
  assert.deepEqual(layout.nodes, [
    {
      id: "线索发现",
      x: 0,
      y: 0,
      width: 2048,
      height: 360,
    },
  ]);
});

test("buildTopologyCanvasLayout 在五个节点横向铺排时将相邻卡片间距缩小到原来的一半", () => {
  const layout = buildTopologyCanvasLayout({
    nodes: ["线索发现", "线索完备性评估", "误报论证-9", "漏洞论证-8", "讨论总结-8"],
    edges: [],
    availableWidth: 1310,
    availableHeight: 214,
    columnWidth: 260,
    minNodeWidth: 260,
    minNodeHeight: 214,
    columnGap: 4.5,
    sidePadding: 0,
    topPadding: 0,
    bottomPadding: 0,
    nodeHeight: 214,
  });

  assert.equal(layout.width, 1310);
  assert.equal(layout.height, 214);
  assert.deepEqual(layout.nodes.map((node) => node.id), [
    "线索发现",
    "线索完备性评估",
    "误报论证-9",
    "漏洞论证-8",
    "讨论总结-8",
  ]);
  assert.ok(layout.nodes.every((node) => node.width === 258.4));
  assert.equal(layout.nodes[0]?.x, 0);
  assert.equal(layout.nodes.at(-1)?.x, 1051.6);
  const computedGap = (layout.nodes[1]?.x ?? 0) - (layout.nodes[0]?.x ?? 0) - (layout.nodes[0]?.width ?? 0);
  assert.ok(Math.abs(computedGap - 4.5) < 1e-9);
});
