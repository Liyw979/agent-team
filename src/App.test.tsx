import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const APP_SOURCE = fs.readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

test("App 已裁成单 Task 展示面板", () => {
  assert.doesNotMatch(APP_SOURCE, /SidebarList/);
  assert.doesNotMatch(APP_SOURCE, /AgentConfigModal/);
  assert.doesNotMatch(APP_SOURCE, /saveTopology/);
  assert.doesNotMatch(APP_SOURCE, /createProject|deleteProject|deleteTask/);
});

test("App 保留聊天输入与 attach 按钮", () => {
  assert.match(APP_SOURCE, /<ChatWindow/);
  assert.match(APP_SOURCE, /"attach"/);
  assert.match(APP_SOURCE, /纯展示面板，不提供配置入口/);
  assert.match(APP_SOURCE, /Agent 历史记录/);
  assert.match(APP_SOURCE, /buildAgentHistoryItems/);
  assert.doesNotMatch(APP_SOURCE, /openLangGraphStudio/);
  assert.doesNotMatch(APP_SOURCE, /LangGraph UI/);
});

test("App 不再从 bootstrap.project 读取当前工作区", () => {
  assert.doesNotMatch(APP_SOURCE, /bootstrap\?\.project/);
  assert.doesNotMatch(APP_SOURCE, /project\.project\.id/);
  assert.doesNotMatch(APP_SOURCE, /ProjectSnapshot/);
});

test("App 改走浏览器 fetch 与 EventSource，而不是旧的桌面桥接 API", () => {
  assert.match(APP_SOURCE, /from "\.\/lib\/web-api"/);
  assert.match(APP_SOURCE, /bootstrapTask/);
  assert.match(APP_SOURCE, /subscribeAgentFlowEvents/);
  assert.doesNotMatch(APP_SOURCE, /window\.agentFlow/);
});
