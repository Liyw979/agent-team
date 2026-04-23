import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { readLaunchTaskIdFromSearch } from "./web-api";

const WEB_API_SOURCE = fs.readFileSync(new URL("./web-api.ts", import.meta.url), "utf8");
const LEGACY_EVENT_NAME = ["Agent", "Flow", "Event"].join("");
const LEGACY_SUBSCRIBE_NAME = ["subscribe", "Agent", "Flow", "Events"].join("");

test("web-api 改用 AgentTeamEvent 与 subscribeAgentTeamEvents", () => {
  assert.match(WEB_API_SOURCE, /AgentTeamEvent/);
  assert.match(WEB_API_SOURCE, /export function subscribeAgentTeamEvents/);
  assert.match(WEB_API_SOURCE, /export function fetchUiSnapshot/);
  assert.match(WEB_API_SOURCE, /\/api\/ui-snapshot/);
  assert.doesNotMatch(WEB_API_SOURCE, new RegExp(LEGACY_EVENT_NAME));
  assert.doesNotMatch(WEB_API_SOURCE, new RegExp(LEGACY_SUBSCRIBE_NAME));
});

test("readLaunchTaskIdFromSearch 会把缺失或空白 taskId 统一归一成 null", () => {
  assert.equal(readLaunchTaskIdFromSearch(""), null);
  assert.equal(readLaunchTaskIdFromSearch("?taskId="), null);
  assert.equal(readLaunchTaskIdFromSearch("?taskId=%20%20%20"), null);
  assert.equal(readLaunchTaskIdFromSearch("?taskId=task-123"), "task-123");
});
