import test from "node:test";
import assert from "node:assert/strict";

import { getAppShellPadding, getAppShellClassName } from "./app-shell-layout";

test("应用主区域外边距应明显小于 20px，避免整个页面离窗口四周过远", () => {
  const padding = getAppShellPadding();

  assert.deepEqual(padding, {
    x: 6,
    y: 6,
  });
  assert.ok(padding.x < 20);
  assert.ok(padding.y < 20);
  assert.equal(getAppShellClassName(), "px-[6px] py-[6px]");
});
