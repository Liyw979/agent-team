export interface AppShellPadding {
  x: number;
  y: number;
}

export function getAppShellPadding(): AppShellPadding {
  return {
    x: 6,
    y: 6,
  };
}

export function getAppShellClassName() {
  const padding = getAppShellPadding();
  return `px-[${padding.x}px] py-[${padding.y}px]`;
}
