import test from "node:test";
import assert from "node:assert/strict";

import {
  REVIEW_RESPONSE_LABEL,
  REVIEW_RESPONSE_END_LABEL,
  extractTrailingReviewResponseBlock,
  stripReviewResponseMarkup,
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

test("extractTrailingReviewResponseBlock 缺少结束标签时也能识别尾部 revision_request", () => {
  const parsed = extractTrailingReviewResponseBlock(`请继续补充。${REVIEW_RESPONSE_LABEL}还有内容`);
  assert.notEqual(parsed, null);
  assert.equal(parsed?.body, "请继续补充。");
  assert.equal(parsed?.response, "还有内容");
  assert.equal(parsed?.rawBlock, `${REVIEW_RESPONSE_LABEL}还有内容`);
});

test("stripReviewResponseMarkup 会去掉 revision_request 标签并保留正文", () => {
  assert.equal(
    stripReviewResponseMarkup(`审视不通过。\n\n${REVIEW_RESPONSE_LABEL}请继续补充实现依据。`),
    "审视不通过。\n\n请继续补充实现依据。",
  );
  assert.equal(
    stripReviewResponseMarkup(
      `审视不通过。\n\n${REVIEW_RESPONSE_LABEL}请继续补充实现依据。${REVIEW_RESPONSE_END_LABEL}`,
    ),
    "审视不通过。\n\n请继续补充实现依据。",
  );
  assert.equal(
    stripReviewResponseMarkup(`审视不通过。\n\n${REVIEW_RESPONSE_END_LABEL}请继续补充实现依据。`),
    "审视不通过。\n\n请继续补充实现依据。",
  );
});
