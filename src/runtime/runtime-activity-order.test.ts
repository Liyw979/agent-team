import test from "node:test";
import assert from "node:assert/strict";

import { pickRecentPartIndexes } from "./runtime-activity-order";

test("pickRecentPartIndexes 会保留最近 part 的原始顺序", () => {
  assert.deepEqual(
    pickRecentPartIndexes(4, 4),
    [0, 1, 2, 3],
  );
});

test("pickRecentPartIndexes 会截取最近 N 个 part 且保持原始顺序", () => {
  assert.deepEqual(
    pickRecentPartIndexes(6, 4),
    [2, 3, 4, 5],
  );
});
