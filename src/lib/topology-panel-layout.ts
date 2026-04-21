export interface TopologyPanelBodyPadding {
  x: number;
  y: number;
}

export function getTopologyPanelBodyPadding(): TopologyPanelBodyPadding {
  return {
    x: 6,
    y: 4,
  };
}

export function getTopologyPanelBodyClassName() {
  const padding = getTopologyPanelBodyPadding();
  return `px-[${padding.x}px] py-[${padding.y}px]`;
}
