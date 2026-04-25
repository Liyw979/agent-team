import test from "node:test";
import assert from "node:assert/strict";

import {
  DECISION_COMPLETE_END_LABEL,
  DECISION_COMPLETE_LABEL,
  DECISION_CONTINUE_END_LABEL,
  DECISION_CONTINUE_LABEL,
  extractTrailingDecisionSignalBlock,
  stripDecisionResponseMarkup,
} from "./decision-response";

test("extractTrailingDecisionSignalBlock 不再识别错拼的 chalenge", () => {
  const content =
    "目前缺少测试文件，无法完成单测判定。"
    + "<chalenge>请把 temp_add.js 和对应测试文件一起发出来。</chalenge>";

  const parsed = extractTrailingDecisionSignalBlock(content);
  assert.equal(parsed, null);
});

test("extractTrailingDecisionSignalBlock 支持识别 complete", () => {
  const content =
    "证据链已经完整，漏洞定性成立。"
    + `${DECISION_COMPLETE_LABEL}结束当前分支。${DECISION_COMPLETE_END_LABEL}`;

  const parsed = extractTrailingDecisionSignalBlock(content);
  assert.notEqual(parsed, null);
  assert.equal(parsed?.body, "证据链已经完整，漏洞定性成立。");
  assert.equal(parsed?.response, "结束当前分支。");
  assert.equal(parsed?.kind, "complete");
  assert.equal(
    parsed?.rawBlock,
    `${DECISION_COMPLETE_LABEL}结束当前分支。${DECISION_COMPLETE_END_LABEL}`,
  );
});

test("extractTrailingDecisionSignalBlock 支持识别 canonical continue", () => {
  const content =
    `判定未通过。${DECISION_CONTINUE_LABEL}请继续补测试。${DECISION_CONTINUE_END_LABEL}`;

  const parsed = extractTrailingDecisionSignalBlock(content);
  assert.notEqual(parsed, null);
  assert.equal(parsed?.body, "判定未通过。");
  assert.equal(parsed?.response, "请继续补测试。");
  assert.equal(parsed?.kind, "continue");
  assert.equal(
    parsed?.rawBlock,
    `${DECISION_CONTINUE_LABEL}请继续补测试。${DECISION_CONTINUE_END_LABEL}`,
  );
});

test("extractTrailingDecisionSignalBlock 支持识别前置 complete 标签", () => {
  const parsed = extractTrailingDecisionSignalBlock(`${DECISION_COMPLETE_LABEL}结束当前分支。`);

  assert.notEqual(parsed, null);
  assert.equal(parsed?.body, "");
  assert.equal(parsed?.response, "结束当前分支。");
  assert.equal(parsed?.kind, "complete");
  assert.equal(parsed?.rawBlock, `${DECISION_COMPLETE_LABEL}结束当前分支。`);
});

test("extractTrailingDecisionSignalBlock 会忽略开头合法标签后重复追加的尾部裸 continue", () => {
  const parsed = extractTrailingDecisionSignalBlock(
    `${DECISION_CONTINUE_LABEL}\n请继续补充实现依据。\n\n${DECISION_CONTINUE_LABEL}`,
  );

  assert.notEqual(parsed, null);
  assert.equal(parsed?.body, "");
  assert.equal(parsed?.response, "请继续补充实现依据。");
  assert.equal(parsed?.kind, "continue");
  assert.equal(
    parsed?.rawBlock,
    `${DECISION_CONTINUE_LABEL}\n请继续补充实现依据。\n\n${DECISION_CONTINUE_LABEL}`,
  );
});

test("extractTrailingDecisionSignalBlock 缺少结束标签时也能识别尾部 continue", () => {
  const parsed = extractTrailingDecisionSignalBlock(`请继续补充。${DECISION_CONTINUE_LABEL}还有内容`);
  assert.notEqual(parsed, null);
  assert.equal(parsed?.body, "请继续补充。");
  assert.equal(parsed?.response, "还有内容");
  assert.equal(parsed?.kind, "continue");
  assert.equal(parsed?.rawBlock, `${DECISION_CONTINUE_LABEL}还有内容`);
});

test("extractTrailingDecisionSignalBlock 支持识别正文后只保留裸 continue 标签", () => {
  const parsed = extractTrailingDecisionSignalBlock(`请继续补充实现依据。\n\n${DECISION_CONTINUE_LABEL}`);

  assert.notEqual(parsed, null);
  assert.equal(parsed?.body, "请继续补充实现依据。");
  assert.equal(parsed?.response, "请继续补充实现依据。");
  assert.equal(parsed?.kind, "continue");
  assert.equal(parsed?.rawBlock, DECISION_CONTINUE_LABEL);
});

test("extractTrailingDecisionSignalBlock 在缺少标签时返回 null", () => {
  assert.equal(extractTrailingDecisionSignalBlock("这是普通正文。"), null);
});

test("stripDecisionResponseMarkup 会去掉 continue 和 complete 标签并保留正文", () => {
  assert.equal(
    stripDecisionResponseMarkup(`继续处理。\n\n${DECISION_CONTINUE_LABEL}请继续补充实现依据。`),
    "继续处理。\n\n请继续补充实现依据。",
  );
  assert.equal(
    stripDecisionResponseMarkup(
      `继续处理。\n\n${DECISION_CONTINUE_LABEL}请继续补充实现依据。${DECISION_CONTINUE_END_LABEL}`,
    ),
    "继续处理。\n\n请继续补充实现依据。",
  );
  assert.equal(
    stripDecisionResponseMarkup(`当前分支可以结束。\n\n${DECISION_COMPLETE_LABEL}结束当前分支。${DECISION_COMPLETE_END_LABEL}`),
    "当前分支可以结束。\n\n结束当前分支。",
  );
  assert.equal(
    stripDecisionResponseMarkup(`继续处理。\n\n${DECISION_CONTINUE_END_LABEL}请继续补充实现依据。`),
    "继续处理。\n\n请继续补充实现依据。",
  );
  assert.equal(
    stripDecisionResponseMarkup(`请继续补充实现依据。\n\n${DECISION_CONTINUE_LABEL}`),
    "请继续补充实现依据。",
  );
  assert.equal(
    stripDecisionResponseMarkup("继续处理。\n\n<chalenge>请继续补充实现依据。</chalenge>"),
    "继续处理。\n\n<chalenge>请继续补充实现依据。</chalenge>",
  );
});
