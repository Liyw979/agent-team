import type { TopologyEdge } from "@shared/types";

export interface TopologyCanvasNodeLayout {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  anchorY: number;
}

export interface TopologyCanvasEdgeLayout {
  id: string;
  source: string;
  target: string;
  triggerOn: TopologyEdge["triggerOn"];
  path: string;
  labelX: number;
  labelY: number;
}

export interface TopologyCanvasLayout {
  width: number;
  height: number;
  nodes: TopologyCanvasNodeLayout[];
  edges: TopologyCanvasEdgeLayout[];
}

export function buildTopologyCanvasLayout(input: {
  nodes: string[];
  edges: TopologyEdge[];
  columnWidth?: number;
  columnGap?: number;
  sidePadding?: number;
  topPadding?: number;
  laneHeight?: number;
  nodeHeight?: number;
}): TopologyCanvasLayout {
  const columnWidth = input.columnWidth ?? 260;
  const columnGap = input.columnGap ?? 36;
  const sidePadding = input.sidePadding ?? 28;
  const topPadding = input.topPadding ?? 22;
  const laneHeight = input.laneHeight ?? 56;
  const nodeHeight = input.nodeHeight ?? 308;
  const nodeY = topPadding + laneHeight;
  const width =
    Math.max(1, input.nodes.length) * columnWidth
    + Math.max(0, input.nodes.length - 1) * columnGap
    + sidePadding * 2;
  const height = nodeY + nodeHeight + 20;

  const nodes = input.nodes.map((id, index) => {
    const x = sidePadding + index * (columnWidth + columnGap);
    return {
      id,
      x,
      y: nodeY,
      width: columnWidth,
      height: nodeHeight,
      centerX: x + columnWidth / 2,
      anchorY: nodeY + 10,
    } satisfies TopologyCanvasNodeLayout;
  });
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));

  const edges = input.edges.flatMap((edge, index) => {
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target) {
      return [];
    }

    if (source.id === target.id) {
      const loopWidth = 26 + (index % 3) * 10;
      const loopHeight = 24 + (index % 3) * 8;
      const path = [
        `M ${source.centerX} ${source.anchorY}`,
        `C ${source.centerX + loopWidth} ${source.anchorY - 8}, ${source.centerX + loopWidth} ${source.anchorY - loopHeight}, ${source.centerX} ${source.anchorY - loopHeight}`,
        `C ${source.centerX - loopWidth} ${source.anchorY - loopHeight}, ${source.centerX - loopWidth} ${source.anchorY - 8}, ${source.centerX} ${source.anchorY}`,
      ].join(" ");

      return [{
        id: `${edge.source}-${edge.target}-${edge.triggerOn}`,
        source: edge.source,
        target: edge.target,
        triggerOn: edge.triggerOn,
        path,
        labelX: source.centerX,
        labelY: source.anchorY - loopHeight - 10,
      } satisfies TopologyCanvasEdgeLayout];
    }

    const distance = Math.abs(target.centerX - source.centerX);
    const direction = target.centerX > source.centerX ? 1 : -1;
    const laneLift = topPadding + 10 + (index % 4) * 8 + Math.min(4, Math.round(distance / 180)) * 5;
    const controlReach = Math.max(36, Math.min(104, distance * 0.22));
    const path = [
      `M ${source.centerX} ${source.anchorY}`,
      `C ${source.centerX + direction * controlReach} ${laneLift}, ${target.centerX - direction * controlReach} ${laneLift}, ${target.centerX} ${target.anchorY}`,
    ].join(" ");

    return [{
      id: `${edge.source}-${edge.target}-${edge.triggerOn}`,
      source: edge.source,
      target: edge.target,
      triggerOn: edge.triggerOn,
      path,
      labelX: (source.centerX + target.centerX) / 2,
      labelY: laneLift - 10,
    } satisfies TopologyCanvasEdgeLayout];
  });

  return {
    width,
    height,
    nodes,
    edges,
  };
}
