interface TopologyCanvasNodeLayout {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TopologyCanvasLayout {
  width: number;
  height: number;
  nodes: TopologyCanvasNodeLayout[];
  edges: [];
}

export function buildTopologyCanvasLayout(input: {
  nodes: string[];
  edges: Array<unknown>;
  availableWidth?: number;
  availableHeight?: number;
  columnWidth?: number;
  columnGap?: number;
  compactColumnGap?: number;
  rowGap?: number;
  sidePadding?: number;
  topPadding?: number;
  bottomPadding?: number;
  nodeHeight?: number;
  minNodeWidth?: number;
  compactMinNodeWidth?: number;
  minNodeHeight?: number;
  compactMinNodeHeight?: number;
}): TopologyCanvasLayout {
  const fallbackNodeWidth = input.columnWidth ?? 260;
  const columnGap = input.columnGap ?? 36;
  const compactColumnGap = input.compactColumnGap ?? Math.min(columnGap, 12);
  const rowGap = input.rowGap ?? 14;
  const sidePadding = input.sidePadding ?? 28;
  const topPadding = input.topPadding ?? 22;
  const bottomPadding = input.bottomPadding ?? 20;
  const fallbackNodeHeight = input.nodeHeight ?? 308;
  const minNodeWidth = input.minNodeWidth ?? fallbackNodeWidth;
  const compactMinNodeWidth = Math.min(
    input.compactMinNodeWidth ?? Math.min(fallbackNodeWidth, 180),
    fallbackNodeWidth,
  );
  const minNodeHeight = input.minNodeHeight ?? fallbackNodeHeight;
  const compactMinNodeHeight = Math.min(
    input.compactMinNodeHeight ?? Math.min(fallbackNodeHeight, 160),
    fallbackNodeHeight,
  );
  const availableWidth = input.availableWidth;
  const availableHeight = input.availableHeight;
  const nodeCount = Math.max(1, input.nodes.length);
  const innerAvailableWidth = availableWidth !== undefined
    ? Math.max(0, availableWidth - sidePadding * 2)
    : undefined;
  const innerAvailableHeight = availableHeight !== undefined
    ? Math.max(0, availableHeight - topPadding - bottomPadding)
    : undefined;
  const widthForColumns = (columns: number, gap: number) =>
    (innerAvailableWidth! - Math.max(0, columns - 1) * gap) / columns;
  const heightForRows = (rows: number) =>
    (innerAvailableHeight! - Math.max(0, rows - 1) * rowGap) / rows;
  const getRowItemCounts = (rows: number) => {
    const base = Math.floor(nodeCount / rows);
    const extra = nodeCount % rows;
    return Array.from({ length: rows }, (_, index) => base + (index < extra ? 1 : 0));
  };

  let rowCount = 1;
  let columns = nodeCount;
  let resolvedColumnGap = columnGap;

  if (innerAvailableWidth !== undefined) {
    const stretchedNodeWidth = widthForColumns(nodeCount, columnGap);
    if (stretchedNodeWidth >= minNodeWidth) {
      rowCount = 1;
      columns = nodeCount;
      resolvedColumnGap = columnGap;
    } else {
      resolvedColumnGap = compactColumnGap;
      let resolved = false;
      for (let candidateRows = 1; candidateRows <= nodeCount; candidateRows += 1) {
        const candidateColumns = Math.ceil(nodeCount / candidateRows);
        const candidateWidth = widthForColumns(candidateColumns, compactColumnGap);
        const candidateHeight = innerAvailableHeight !== undefined
          ? heightForRows(candidateRows)
          : fallbackNodeHeight;
        if (candidateWidth >= compactMinNodeWidth && candidateHeight >= compactMinNodeHeight) {
          rowCount = candidateRows;
          columns = candidateColumns;
          resolved = true;
          break;
        }
      }
      if (!resolved) {
        rowCount = Math.max(1, Math.min(nodeCount, Math.ceil(nodeCount / Math.max(1, Math.floor(
          (innerAvailableWidth + compactColumnGap) / (compactMinNodeWidth + compactColumnGap),
        )))));
        columns = Math.ceil(nodeCount / rowCount);
      }
    }
  }

  const nodeWidth = innerAvailableWidth !== undefined
    ? Math.max(0, widthForColumns(columns, resolvedColumnGap))
    : fallbackNodeWidth;
  const stretchedNodeHeight = innerAvailableHeight !== undefined
    ? Math.max(0, heightForRows(rowCount))
    : null;
  const nodeHeight = stretchedNodeHeight ?? fallbackNodeHeight;
  const width = availableWidth ?? columns * nodeWidth + Math.max(0, columns - 1) * resolvedColumnGap + sidePadding * 2;
  const height = availableHeight ?? topPadding + rowCount * nodeHeight + Math.max(0, rowCount - 1) * rowGap + bottomPadding;

  const rowItemCounts = getRowItemCounts(rowCount);
  let nodeIndex = 0;
  const nodes: TopologyCanvasNodeLayout[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    const rowItemCount = rowItemCounts[row] ?? 0;
    const rowGap = rowItemCount > 1 && innerAvailableWidth !== undefined
      ? Math.max(0, (innerAvailableWidth - rowItemCount * nodeWidth) / (rowItemCount - 1))
      : 0;
    const rowOffsetX = rowItemCount <= 1 && innerAvailableWidth !== undefined
      ? sidePadding + Math.max(0, (innerAvailableWidth - nodeWidth) / 2)
      : sidePadding;
    const y = topPadding + row * (nodeHeight + (rowCount > 1 ? input.rowGap ?? 14 : 0));

    for (let column = 0; column < rowItemCount; column += 1) {
      const id = input.nodes[nodeIndex];
      if (!id) {
        continue;
      }
      const x = rowOffsetX + column * (nodeWidth + rowGap);
      nodes.push({
        id,
        x,
        y,
        width: nodeWidth,
        height: nodeHeight,
      });
      nodeIndex += 1;
    }
  }

  return {
    width,
    height,
    nodes,
    edges: [],
  };
}
