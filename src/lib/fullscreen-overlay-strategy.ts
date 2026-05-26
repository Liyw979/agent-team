type FullscreenOverlayAncestorCssEffect = "backdrop-filter";

interface FullscreenOverlayStrategy {
  mountTarget: "body-portal" | "local-tree";
  shouldFillViewport: boolean;
}

export function resolveFullscreenOverlayStrategy(
  ancestorCssEffects: readonly FullscreenOverlayAncestorCssEffect[],
): FullscreenOverlayStrategy {
  if (ancestorCssEffects.includes("backdrop-filter")) {
    return {
      mountTarget: "body-portal",
      shouldFillViewport: true,
    };
  }

  return {
    mountTarget: "local-tree",
    shouldFillViewport: false,
  };
}
