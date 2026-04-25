export function getTopologyCanvasViewportMeasurementKey(input: {
  topologyNodeCount: number;
  topologyNodeRecordCount: number;
  hasRenderableCanvas: boolean;
}) {
  return `${input.topologyNodeCount}:${input.topologyNodeRecordCount}:${input.hasRenderableCanvas ? "renderable" : "empty"}`;
}
