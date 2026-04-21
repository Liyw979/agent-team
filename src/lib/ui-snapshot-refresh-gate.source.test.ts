import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const SOURCE = fs.readFileSync(new URL("./ui-snapshot-refresh-gate.ts", import.meta.url), "utf8");

test("ui snapshot refresh gate 只接受严格更新的请求号", () => {
  assert.match(SOURCE, /requestId <= input\.latestAcceptedRequestId/);
  assert.match(SOURCE, /accepted: false/);
  assert.match(SOURCE, /accepted: true/);
});
