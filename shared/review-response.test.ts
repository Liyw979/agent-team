import test from "node:test";
import assert from "node:assert/strict";

import {
  REVIEW_RESPONSE_LABEL,
  REVIEW_RESPONSE_END_LABEL,
  extractTrailingReviewResponseBlock,
} from "./review-response";

test("extractTrailingReviewResponseBlock 支持识别行内 revision_request", () => {
  const content =
    "目前缺少测试文件，无法完成单测审查。"
    + `${REVIEW_RESPONSE_LABEL}请把 temp_add.js 和对应测试文件一起发出来。${REVIEW_RESPONSE_END_LABEL}`;

  const parsed = extractTrailingReviewResponseBlock(content);
  assert.notEqual(parsed, null);
  assert.equal(parsed?.body, "目前缺少测试文件，无法完成单测审查。");
  assert.equal(parsed?.response, "请把 temp_add.js 和对应测试文件一起发出来。");
  assert.equal(
    parsed?.rawBlock,
    `${REVIEW_RESPONSE_LABEL}请把 temp_add.js 和对应测试文件一起发出来。${REVIEW_RESPONSE_END_LABEL}`,
  );
});

test("extractTrailingReviewResponseBlock 缺少结束标签时不会误命中", () => {
  const parsed = extractTrailingReviewResponseBlock(`请继续补充。${REVIEW_RESPONSE_LABEL}还有内容`);
  assert.equal(parsed, null);
});
