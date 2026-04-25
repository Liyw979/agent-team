import test from "node:test";
import assert from "node:assert/strict";
import { resolveFullscreenOverlayStrategy } from "./fullscreen-overlay-strategy";

test("带有 backdrop-filter 的祖先会让 agent 全屏详情层受限在面板内，因此必须改走 body portal", () => {
  assert.deepEqual(
    resolveFullscreenOverlayStrategy({
      ancestorCssEffects: ["backdrop-filter"],
    }),
    {
      mountTarget: "body-portal",
      shouldFillViewport: true,
    },
  );
});
