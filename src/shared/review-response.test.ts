import test from "node:test";
import assert from "node:assert/strict";

import {
  REVIEW_COMPLETE_END_LABEL,
  REVIEW_COMPLETE_LABEL,
  REVIEW_CONTINUE_END_LABEL,
  REVIEW_CONTINUE_LABEL,
  extractTrailingReviewSignalBlock,
  stripReviewResponseMarkup,
} from "./review-response";

test("extractTrailingReviewSignalBlock 不识别非法标签", () => {
  const content =
    "目前缺少测试文件，无法完成单测审查。"
    + "<invalid>请把 temp_add.js 和对应测试文件一起发出来。</invalid>";

  const parsed = extractTrailingReviewSignalBlock(content);
  assert.equal(parsed, null);
});

test("extractTrailingReviewSignalBlock 支持识别 complete", () => {
  const content =
    "证据链已经完整，漏洞定性成立。"
    + `${REVIEW_COMPLETE_LABEL}结束当前分支。${REVIEW_COMPLETE_END_LABEL}`;

  const parsed = extractTrailingReviewSignalBlock(content);
  assert.notEqual(parsed, null);
  assert.equal(parsed?.body, "证据链已经完整，漏洞定性成立。");
  assert.equal(parsed?.response, "结束当前分支。");
  assert.equal(parsed?.kind, "complete");
  assert.equal(
    parsed?.rawBlock,
    `${REVIEW_COMPLETE_LABEL}结束当前分支。${REVIEW_COMPLETE_END_LABEL}`,
  );
});

test("extractTrailingReviewSignalBlock 支持识别 canonical continue", () => {
  const content =
    `审查未通过。${REVIEW_CONTINUE_LABEL}请继续补测试。${REVIEW_CONTINUE_END_LABEL}`;

  const parsed = extractTrailingReviewSignalBlock(content);
  assert.notEqual(parsed, null);
  assert.equal(parsed?.body, "审查未通过。");
  assert.equal(parsed?.response, "请继续补测试。");
  assert.equal(parsed?.kind, "continue");
  assert.equal(
    parsed?.rawBlock,
    `${REVIEW_CONTINUE_LABEL}请继续补测试。${REVIEW_CONTINUE_END_LABEL}`,
  );
});

test("extractTrailingReviewSignalBlock 支持识别前置 complete 标签", () => {
  const parsed = extractTrailingReviewSignalBlock(`${REVIEW_COMPLETE_LABEL}结束当前分支。`);

  assert.notEqual(parsed, null);
  assert.equal(parsed?.body, "");
  assert.equal(parsed?.response, "结束当前分支。");
  assert.equal(parsed?.kind, "complete");
  assert.equal(parsed?.rawBlock, `${REVIEW_COMPLETE_LABEL}结束当前分支。`);
});

test("extractTrailingReviewSignalBlock 会忽略开头合法标签后重复追加的尾部裸 continue", () => {
  const parsed = extractTrailingReviewSignalBlock(
    `${REVIEW_CONTINUE_LABEL}\n请继续补充实现依据。\n\n${REVIEW_CONTINUE_LABEL}`,
  );

  assert.notEqual(parsed, null);
  assert.equal(parsed?.body, "");
  assert.equal(parsed?.response, "请继续补充实现依据。");
  assert.equal(parsed?.kind, "continue");
  assert.equal(
    parsed?.rawBlock,
    `${REVIEW_CONTINUE_LABEL}\n请继续补充实现依据。\n\n${REVIEW_CONTINUE_LABEL}`,
  );
});

test("extractTrailingReviewSignalBlock 缺少结束标签时也能识别尾部 continue", () => {
  const parsed = extractTrailingReviewSignalBlock(`请继续补充。${REVIEW_CONTINUE_LABEL}还有内容`);
  assert.notEqual(parsed, null);
  assert.equal(parsed?.body, "请继续补充。");
  assert.equal(parsed?.response, "还有内容");
  assert.equal(parsed?.kind, "continue");
  assert.equal(parsed?.rawBlock, `${REVIEW_CONTINUE_LABEL}还有内容`);
});

test("extractTrailingReviewSignalBlock 支持识别正文后只保留裸 continue 标签", () => {
  const parsed = extractTrailingReviewSignalBlock(`请继续补充实现依据。\n\n${REVIEW_CONTINUE_LABEL}`);

  assert.notEqual(parsed, null);
  assert.equal(parsed?.body, "请继续补充实现依据。");
  assert.equal(parsed?.response, "请继续补充实现依据。");
  assert.equal(parsed?.kind, "continue");
  assert.equal(parsed?.rawBlock, REVIEW_CONTINUE_LABEL);
});

test("extractTrailingReviewSignalBlock 在缺少标签时返回 null", () => {
  assert.equal(extractTrailingReviewSignalBlock("这是普通正文。"), null);
});

test("stripReviewResponseMarkup 会去掉 continue 和 complete 标签并保留正文", () => {
  assert.equal(
    stripReviewResponseMarkup(`继续处理。\n\n${REVIEW_CONTINUE_LABEL}请继续补充实现依据。`),
    "继续处理。\n\n请继续补充实现依据。",
  );
  assert.equal(
    stripReviewResponseMarkup(
      `继续处理。\n\n${REVIEW_CONTINUE_LABEL}请继续补充实现依据。${REVIEW_CONTINUE_END_LABEL}`,
    ),
    "继续处理。\n\n请继续补充实现依据。",
  );
  assert.equal(
    stripReviewResponseMarkup(`当前分支可以结束。\n\n${REVIEW_COMPLETE_LABEL}结束当前分支。${REVIEW_COMPLETE_END_LABEL}`),
    "当前分支可以结束。\n\n结束当前分支。",
  );
  assert.equal(
    stripReviewResponseMarkup(`继续处理。\n\n${REVIEW_CONTINUE_END_LABEL}请继续补充实现依据。`),
    "继续处理。\n\n请继续补充实现依据。",
  );
  assert.equal(
    stripReviewResponseMarkup(`请继续补充实现依据。\n\n${REVIEW_CONTINUE_LABEL}`),
    "请继续补充实现依据。",
  );
  assert.equal(
    stripReviewResponseMarkup("继续处理。\n\n<invalid>请继续补充实现依据。</invalid>"),
    "继续处理。\n\n<invalid>请继续补充实现依据。</invalid>",
  );
});
