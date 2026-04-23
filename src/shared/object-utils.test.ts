import test from "node:test";
import assert from "node:assert/strict";

import { withOptionalString } from "./object-utils";

test("withOptionalString 会忽略仅包含空白的字符串，避免把缺失值编码成空串", () => {
  assert.deepEqual(withOptionalString({}, "taskId", "   "), {});
});

test("withOptionalString 会保留有效字符串", () => {
  assert.deepEqual(withOptionalString({}, "taskId", "task-123"), {
    taskId: "task-123",
  });
});
