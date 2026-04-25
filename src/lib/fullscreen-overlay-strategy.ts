type FullscreenOverlayAncestorCssEffect = "backdrop-filter";

interface FullscreenOverlayStrategyInput {
  ancestorCssEffects: FullscreenOverlayAncestorCssEffect[];
}

interface FullscreenOverlayStrategy {
  mountTarget: "body-portal" | "local-tree";
  shouldFillViewport: boolean;
}

export function resolveFullscreenOverlayStrategy(
  input: FullscreenOverlayStrategyInput,
): FullscreenOverlayStrategy {
  if (input.ancestorCssEffects.includes("backdrop-filter")) {
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
