export type AppPanelMode = "default" | "chat-only" | "topology-only";

interface AppPanelVisibility {
  showTopologyPanel: boolean;
  showChatPanel: boolean;
}

export function resolveAppPanelVisibility(mode: AppPanelMode): AppPanelVisibility {
  if (mode === "chat-only") {
    return {
      showTopologyPanel: false,
      showChatPanel: true,
    };
  }

  if (mode === "topology-only") {
    return {
      showTopologyPanel: true,
      showChatPanel: false,
    };
  }

  return {
    showTopologyPanel: true,
    showChatPanel: true,
  };
}
