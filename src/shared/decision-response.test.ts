import { test } from "bun:test";
import assert from "node:assert/strict";

import {
  type DecisionSignalBlockResult,
  extractDecisionSignalBlock,
  stripDecisionResponseMarkup,
} from "./decision-response";

const APPROVED = "<approved>";
const APPROVED_END = "</approved>";
const REVISE = "<revise>";
const REVISE_END = "</revise>";

function assertFound(parsed: DecisionSignalBlockResult) {
  assert.equal(parsed.kind, "found");
  return parsed;
}

test("extractDecisionSignalBlock 不再识别错拼的 chalenge", () => {
  const content =
    "目前缺少测试文件，无法完成单测判定。"
    + "<chalenge>请把 temp_add.js 和对应测试文件一起发出来。</chalenge>";

  const parsed = extractDecisionSignalBlock(content, [APPROVED, REVISE]);
  assert.deepEqual(parsed, { kind: "missing" });
});

test("extractDecisionSignalBlock 支持识别示例结束 trigger", () => {
  const content =
    "证据链已经完整，漏洞定性成立。"
    + `${APPROVED}结束当前分支。${APPROVED_END}`;

  const parsed = assertFound(extractDecisionSignalBlock(content, [APPROVED, REVISE]));
  assert.equal(parsed.contentWithoutTrigger, "证据链已经完整，漏洞定性成立。结束当前分支。</approved>");
  assert.equal(parsed.trigger, APPROVED);
});

test("extractDecisionSignalBlock 支持识别示例回流 trigger", () => {
  const content =
    `判定未通过。${REVISE}请继续补测试。${REVISE_END}`;

  const parsed = assertFound(extractDecisionSignalBlock(content, [APPROVED, REVISE]));
  assert.equal(parsed.contentWithoutTrigger, "判定未通过。请继续补测试。</revise>");
  assert.equal(parsed.trigger, REVISE);
});

test("extractDecisionSignalBlock 支持识别开头裸 trigger", () => {
  const parsed = assertFound(extractDecisionSignalBlock(`${APPROVED}结束当前分支。`, [APPROVED, REVISE]));

  assert.equal(parsed.contentWithoutTrigger, "结束当前分支。");
  assert.equal(parsed.trigger, APPROVED);
});

test("extractDecisionSignalBlock 开头只有 trigger 没有正文时也视为有效 trigger", () => {
  const parsed = assertFound(extractDecisionSignalBlock(APPROVED, [APPROVED, REVISE]));

  assert.equal(parsed.contentWithoutTrigger, "");
  assert.equal(parsed.trigger, APPROVED);
});

test("extractDecisionSignalBlock 保留开头裸 trigger 后的 closing tag", () => {
  const parsed = assertFound(extractDecisionSignalBlock(`${REVISE}\n请继续补充实现依据。\n${REVISE_END}`, [
    APPROVED,
    REVISE,
  ]));

  assert.equal(parsed.contentWithoutTrigger, "请继续补充实现依据。\n</revise>");
  assert.equal(parsed.trigger, REVISE);
});

test("extractDecisionSignalBlock 开头与尾部重复 trigger 时仍只返回既有 found 状态", () => {
  const parsed = assertFound(extractDecisionSignalBlock(
    `${REVISE}\n请继续补充实现依据。\n\n${REVISE}`,
    [APPROVED, REVISE],
  ));

  assert.equal(parsed.contentWithoutTrigger, "请继续补充实现依据。\n\n<revise>");
  assert.equal(parsed.trigger, REVISE);
});

test("extractDecisionSignalBlock 缺少结束标签但命中 trigger 时仍视为有效", () => {
  const parsed = assertFound(extractDecisionSignalBlock(`请继续补充。${REVISE}还有内容`, [APPROVED, REVISE]));
  assert.equal(parsed.contentWithoutTrigger, "请继续补充。还有内容");
  assert.equal(parsed.trigger, REVISE);
});

test("extractDecisionSignalBlock wrapped 区间外的内联 bare trigger 仍视为有效", () => {
  const parsed = assertFound(extractDecisionSignalBlock(`文字 ${APPROVED} 示例`, [APPROVED, REVISE]));
  assert.equal(parsed.contentWithoutTrigger, "文字  示例");
  assert.equal(parsed.trigger, APPROVED);
});

test("extractDecisionSignalBlock 正文后只保留裸 trigger 时也视为有效", () => {
  const parsed = assertFound(extractDecisionSignalBlock(`请继续补充实现依据。\n\n${REVISE}`, [APPROVED, REVISE]));
  assert.equal(parsed.contentWithoutTrigger, "请继续补充实现依据。");
  assert.equal(parsed.trigger, REVISE);
});

test("extractDecisionSignalBlock 在缺少标签时返回 missing", () => {
  assert.deepEqual(extractDecisionSignalBlock("这是普通正文。", []), { kind: "missing" });
});

test("extractDecisionSignalBlock 支持按允许的 trigger 集合解析自定义标签", () => {
  const parsed = assertFound(extractDecisionSignalBlock(
    "误报论证需要继续回应。\n\n<abcd>请继续补充反驳。</abcd>",
    ["<abcd>"],
  ));

  assert.equal(parsed.contentWithoutTrigger, "误报论证需要继续回应。\n\n请继续补充反驳。</abcd>");
  assert.equal(parsed.trigger, "<abcd>");
});

test("extractDecisionSignalBlock 支持解析正文后跟成对自定义标签块", () => {
  const parsed = assertFound(extractDecisionSignalBlock(
    "aaaaa<trigger> bbbbb</trigger>",
    ["<trigger>"],
  ));

  assert.equal(parsed.contentWithoutTrigger, "aaaaa bbbbb</trigger>");
  assert.equal(parsed.trigger, "<trigger>");
});

test("extractDecisionSignalBlock 遇到 mixed-trigger 时仍只返回既有 found 状态", () => {
  const parsed = assertFound(extractDecisionSignalBlock(
    `前文${REVISE}旧回流意见${REVISE_END}后文${APPROVED}`,
    [APPROVED, REVISE],
  ));

  assert.equal(parsed.trigger, REVISE);
  assert.equal(parsed.contentWithoutTrigger, "前文旧回流意见</revise>后文<approved>");
});

test("extractDecisionSignalBlock 直接按 allowed tag 扫描正文中的 trigger", () => {
  const parsed = assertFound(extractDecisionSignalBlock(
    `${REVISE}请检查字符串 ${APPROVED} 是否出现在日志中${REVISE_END}`,
    [APPROVED, REVISE],
  ));

  assert.equal(parsed.trigger, REVISE);
  assert.equal(parsed.contentWithoutTrigger, "请检查字符串 <approved> 是否出现在日志中</revise>");
});

test("extractDecisionSignalBlock 开头 wrapped trigger 后仍会保留 closing tag 之后的正文", () => {
  const parsed = assertFound(extractDecisionSignalBlock(
    `${REVISE}请继续补证。${REVISE_END}补充说明`,
    [APPROVED, REVISE],
  ));

  assert.equal(parsed.trigger, REVISE);
  assert.equal(parsed.contentWithoutTrigger, "请继续补证。</revise>补充说明");
});

test("extractDecisionSignalBlock 会按 allowed tag 识别正文里的完整 trigger 包裹对", () => {
  const parsed = assertFound(extractDecisionSignalBlock(
    `${REVISE}请检查示例 ${APPROVED}done${APPROVED_END} 是否出现在文档中${REVISE_END}`,
    [APPROVED, REVISE],
  ));

  assert.equal(parsed.trigger, REVISE);
  assert.equal(parsed.contentWithoutTrigger, "请检查示例 <approved>done</approved> 是否出现在文档中</revise>");
});

test("extractDecisionSignalBlock 对同名 trigger 只按第一次起始 trigger 切分", () => {
  const parsed = assertFound(extractDecisionSignalBlock(
    `${REVISE}请检查示例 ${REVISE}done${REVISE_END} 是否出现在文档中${REVISE_END}`,
    [APPROVED, REVISE],
  ));

  assert.equal(parsed.trigger, REVISE);
  assert.equal(parsed.contentWithoutTrigger, `请检查示例 ${REVISE}done${REVISE_END} 是否出现在文档中${REVISE_END}`);
});

test("extractDecisionSignalBlock 遇到顺序同名 trigger 块时只移除首个起始 trigger", () => {
  const parsed = assertFound(extractDecisionSignalBlock(
    `${REVISE}abc${REVISE_END} middle ${REVISE}inner${REVISE_END}`,
    [APPROVED, REVISE],
  ));

  assert.equal(parsed.trigger, REVISE);
  assert.equal(parsed.contentWithoutTrigger, `abc${REVISE_END} middle ${REVISE}inner${REVISE_END}`);
});

test("extractDecisionSignalBlock 对同名裸 start trigger 按 allowed tag 继续扫描", () => {
  const parsed = assertFound(extractDecisionSignalBlock(
    `${REVISE}请检查 ${REVISE} 是否出现在文档中${REVISE_END}`,
    [APPROVED, REVISE],
  ));

  assert.equal(parsed.trigger, REVISE);
  assert.equal(parsed.contentWithoutTrigger, `请检查 ${REVISE} 是否出现在文档中${REVISE_END}`);
});

test("stripDecisionResponseMarkup 会去掉示例 trigger 标签并保留正文", () => {
  assert.equal(
    stripDecisionResponseMarkup(`继续处理。\n\n${REVISE}请继续补充实现依据。`, [APPROVED, REVISE]),
    "继续处理。\n\n请继续补充实现依据。",
  );
  assert.equal(
    stripDecisionResponseMarkup(`${REVISE}\n请继续补充实现依据。`, [APPROVED, REVISE]),
    "请继续补充实现依据。",
  );
  assert.equal(
    stripDecisionResponseMarkup(`${REVISE}\n请继续补充实现依据。\n${REVISE_END}`, [APPROVED, REVISE]),
    "请继续补充实现依据。\n</revise>",
  );
  assert.equal(
    stripDecisionResponseMarkup(
      `继续处理。\n\n${REVISE}请继续补充实现依据。${REVISE_END}`,
      [APPROVED, REVISE],
    ),
    "继续处理。\n\n请继续补充实现依据。</revise>",
  );
  assert.equal(
    stripDecisionResponseMarkup(`当前分支可以结束。\n\n${APPROVED}结束当前分支。${APPROVED_END}`, [APPROVED, REVISE]),
    "当前分支可以结束。\n\n结束当前分支。</approved>",
  );
  assert.equal(
    stripDecisionResponseMarkup(`继续处理。\n\n${REVISE_END}请继续补充实现依据。`, [APPROVED, REVISE]),
    `继续处理。\n\n${REVISE_END}请继续补充实现依据。`,
  );
  assert.equal(
    stripDecisionResponseMarkup(`请继续补充实现依据。\n\n${REVISE}`, [APPROVED, REVISE]),
    "请继续补充实现依据。",
  );
  assert.equal(
    stripDecisionResponseMarkup(`${REVISE}\n请继续补充实现依据。\n\n${REVISE}`, [APPROVED, REVISE]),
    "请继续补充实现依据。\n\n<revise>",
  );
  assert.equal(
    stripDecisionResponseMarkup(`文字 ${APPROVED} 示例`, [APPROVED, REVISE]),
    "文字  示例",
  );
  assert.equal(
    stripDecisionResponseMarkup("继续处理。\n\n<chalenge>请继续补充实现依据。</chalenge>", []),
    "继续处理。\n\n<chalenge>请继续补充实现依据。</chalenge>",
  );
  assert.equal(
    stripDecisionResponseMarkup("aaaaa<trigger> bbbbb</trigger>", ["<trigger>"]),
    "aaaaa bbbbb</trigger>",
  );
  assert.equal(
    stripDecisionResponseMarkup(`前文${REVISE}旧回流意见${REVISE_END}后文${APPROVED}`, [APPROVED, REVISE]),
    `前文${REVISE}旧回流意见${REVISE_END}后文${APPROVED}`,
  );
  assert.equal(
    stripDecisionResponseMarkup(
      `${REVISE}请检查字符串 ${APPROVED} 是否出现在日志中${REVISE_END}`,
      [APPROVED, REVISE],
    ),
    `${REVISE}请检查字符串 ${APPROVED} 是否出现在日志中${REVISE_END}`,
  );
  assert.equal(
    stripDecisionResponseMarkup(`${REVISE}请继续补证。${REVISE_END}补充说明`, [APPROVED, REVISE]),
    "请继续补证。</revise>补充说明",
  );
  assert.equal(
    stripDecisionResponseMarkup(
      `${REVISE}请检查示例 ${APPROVED}done${APPROVED_END} 是否出现在文档中${REVISE_END}`,
      [APPROVED, REVISE],
    ),
    `${REVISE}请检查示例 ${APPROVED}done${APPROVED_END} 是否出现在文档中${REVISE_END}`,
  );
  assert.equal(
    stripDecisionResponseMarkup(
      `${REVISE}请检查示例 ${REVISE}done${REVISE_END} 是否出现在文档中${REVISE_END}`,
      [APPROVED, REVISE],
    ),
    `请检查示例 ${REVISE}done${REVISE_END} 是否出现在文档中${REVISE_END}`,
  );
  assert.equal(
    stripDecisionResponseMarkup(
      `${REVISE}请检查 ${REVISE} 是否出现在文档中${REVISE_END}`,
      [APPROVED, REVISE],
    ),
    `请检查 ${REVISE} 是否出现在文档中${REVISE_END}`,
  );
  assert.equal(
    stripDecisionResponseMarkup(`${REVISE}正文。结论：继续保持 ${REVISE}。`, [APPROVED, REVISE]),
    `正文。结论：继续保持 ${REVISE}。`,
  );
  assert.equal(
    stripDecisionResponseMarkup(`前文${REVISE}示例${REVISE_END}后文${REVISE}`, [APPROVED, REVISE]),
    `前文示例${REVISE_END}后文${REVISE}`,
  );
  assert.equal(
    stripDecisionResponseMarkup(
      `${REVISE}abc${REVISE_END} middle ${REVISE}inner${REVISE_END}`,
      [APPROVED, REVISE],
    ),
    `abc${REVISE_END} middle ${REVISE}inner${REVISE_END}`,
  );
});
