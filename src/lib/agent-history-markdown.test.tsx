import test from "node:test";
import assert from "node:assert/strict";

import { renderAgentHistoryDetailToStaticHtml } from "./agent-history-markdown";

test("拓扑历史详情会把 Markdown 渲染成 HTML", () => {
  const html = renderAgentHistoryDetailToStaticHtml("**已验证**\n\n- 补充断言");

  assert.match(html, /<strong>已验证<\/strong>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<li>补充断言<\/li>/);
});
