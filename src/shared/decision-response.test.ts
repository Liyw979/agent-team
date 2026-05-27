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
  assert.equal(parsed.body, "证据链已经完整，漏洞定性成立。");
  assert.equal(parsed.response, "结束当前分支。");
  assert.equal(parsed.trigger, APPROVED);
  assert.equal(parsed.rawBlock, content);
});

test("extractDecisionSignalBlock 支持识别示例回流 trigger", () => {
  const content =
    `判定未通过。${REVISE}请继续补测试。${REVISE_END}`;

  const parsed = assertFound(extractDecisionSignalBlock(content, [APPROVED, REVISE]));
  assert.equal(parsed.body, "判定未通过。");
  assert.equal(parsed.response, "请继续补测试。");
  assert.equal(parsed.trigger, REVISE);
  assert.equal(parsed.rawBlock, content);
});

test("extractDecisionSignalBlock 支持识别开头裸 trigger", () => {
  const parsed = assertFound(extractDecisionSignalBlock(`${APPROVED}结束当前分支。`, [APPROVED, REVISE]));

  assert.equal(parsed.body, "结束当前分支。");
  assert.equal(parsed.response, "结束当前分支。");
  assert.equal(parsed.trigger, APPROVED);
  assert.equal(parsed.rawBlock, `${APPROVED}结束当前分支。`);
});

test("extractDecisionSignalBlock 开头只有 trigger 没有正文时也视为有效 trigger", () => {
  const parsed = assertFound(extractDecisionSignalBlock(APPROVED, [APPROVED, REVISE]));

  assert.equal(parsed.body, "");
  assert.equal(parsed.response, "");
  assert.equal(parsed.trigger, APPROVED);
  assert.equal(parsed.rawBlock, APPROVED);
});

test("extractDecisionSignalBlock 会移除开头裸 trigger 后多余的结束标签", () => {
  const parsed = assertFound(extractDecisionSignalBlock(`${REVISE}\n请继续补充实现依据。\n${REVISE_END}`, [
    APPROVED,
    REVISE,
  ]));

  assert.equal(parsed.body, "请继续补充实现依据。");
  assert.equal(parsed.response, "请继续补充实现依据。");
  assert.equal(parsed.trigger, REVISE);
  assert.equal(parsed.rawBlock, `${REVISE}\n请继续补充实现依据。\n${REVISE_END}`);
});

test("extractDecisionSignalBlock 开头与尾部重复 trigger 时仍只返回既有 found 状态", () => {
  const parsed = assertFound(extractDecisionSignalBlock(
    `${REVISE}\n请继续补充实现依据。\n\n${REVISE}`,
    [APPROVED, REVISE],
  ));

  assert.equal(parsed.body, "请继续补充实现依据。");
  assert.equal(parsed.response, "请继续补充实现依据。");
  assert.equal(parsed.trigger, REVISE);
  assert.equal(parsed.rawBlock, `${REVISE}\n请继续补充实现依据。\n\n${REVISE}`);
});

test("extractDecisionSignalBlock 缺少结束标签但命中 trigger 时仍视为有效", () => {
  const parsed = assertFound(extractDecisionSignalBlock(`请继续补充。${REVISE}还有内容`, [APPROVED, REVISE]));
  assert.equal(parsed.body, "请继续补充。");
  assert.equal(parsed.response, "还有内容");
  assert.equal(parsed.trigger, REVISE);
  assert.equal(parsed.rawBlock, `请继续补充。${REVISE}还有内容`);
});

test("extractDecisionSignalBlock wrapped 区间外的内联 bare trigger 仍视为有效", () => {
  const parsed = assertFound(extractDecisionSignalBlock(`文字 ${APPROVED} 示例`, [APPROVED, REVISE]));
  assert.equal(parsed.body, "文字");
  assert.equal(parsed.response, "示例");
  assert.equal(parsed.trigger, APPROVED);
  assert.equal(parsed.rawBlock, `文字 ${APPROVED} 示例`);
});

test("extractDecisionSignalBlock 正文后只保留裸 trigger 时也视为有效", () => {
  const parsed = assertFound(extractDecisionSignalBlock(`请继续补充实现依据。\n\n${REVISE}`, [APPROVED, REVISE]));
  assert.equal(parsed.body, "请继续补充实现依据。");
  assert.equal(parsed.response, "请继续补充实现依据。");
  assert.equal(parsed.trigger, REVISE);
  assert.equal(parsed.rawBlock, `请继续补充实现依据。\n\n${REVISE}`);
});

test("extractDecisionSignalBlock 在缺少标签时返回 missing", () => {
  assert.deepEqual(extractDecisionSignalBlock("这是普通正文。", []), { kind: "missing" });
});

test("extractDecisionSignalBlock 支持按允许的 trigger 集合解析自定义标签", () => {
  const parsed = assertFound(extractDecisionSignalBlock(
    "误报论证需要继续回应。\n\n<abcd>请继续补充反驳。</abcd>",
    ["<abcd>"],
  ));

  assert.equal(parsed.body, "误报论证需要继续回应。");
  assert.equal(parsed.response, "请继续补充反驳。");
  assert.equal(parsed.trigger, "<abcd>");
  assert.equal(parsed.rawBlock, "误报论证需要继续回应。\n\n<abcd>请继续补充反驳。</abcd>");
});

test("extractDecisionSignalBlock 支持解析正文后跟成对自定义标签块", () => {
  const parsed = assertFound(extractDecisionSignalBlock(
    "aaaaa<trigger> bbbbb</trigger>",
    ["<trigger>"],
  ));

  assert.equal(parsed.body, "aaaaa");
  assert.equal(parsed.response, "bbbbb");
  assert.equal(parsed.trigger, "<trigger>");
  assert.equal(parsed.rawBlock, "aaaaa<trigger> bbbbb</trigger>");
});

test("extractDecisionSignalBlock 遇到 mixed-trigger 时仍只返回既有 found 状态", () => {
  const parsed = assertFound(extractDecisionSignalBlock(
    `前文${REVISE}旧回流意见${REVISE_END}后文${APPROVED}`,
    [APPROVED, REVISE],
  ));

  assert.equal(parsed.trigger, APPROVED);
  assert.equal(parsed.body, "前文旧回流意见后文");
  assert.equal(parsed.response, "前文旧回流意见后文");
  assert.equal(parsed.rawBlock, `前文${REVISE}旧回流意见${REVISE_END}后文${APPROVED}`);
});

test("extractDecisionSignalBlock 直接按 allowed tag 扫描正文中的 trigger", () => {
  const parsed = assertFound(extractDecisionSignalBlock(
    `${REVISE}请检查字符串 ${APPROVED} 是否出现在日志中${REVISE_END}`,
    [APPROVED, REVISE],
  ));

  assert.equal(parsed.trigger, APPROVED);
  assert.equal(parsed.body, "请检查字符串");
  assert.equal(parsed.response, "是否出现在日志中");
  assert.equal(parsed.rawBlock, `${REVISE}请检查字符串 ${APPROVED} 是否出现在日志中${REVISE_END}`);
});

test("extractDecisionSignalBlock 开头 wrapped trigger 后仍会保留 closing tag 之后的正文", () => {
  const parsed = assertFound(extractDecisionSignalBlock(
    `${REVISE}请继续补证。${REVISE_END}补充说明`,
    [APPROVED, REVISE],
  ));

  assert.equal(parsed.trigger, REVISE);
  assert.equal(parsed.body, "请继续补证。\n\n补充说明");
  assert.equal(parsed.response, "请继续补证。\n\n补充说明");
  assert.equal(parsed.rawBlock, `${REVISE}请继续补证。${REVISE_END}补充说明`);
});

test("extractDecisionSignalBlock 会按 allowed tag 识别正文里的完整 trigger 包裹对", () => {
  const parsed = assertFound(extractDecisionSignalBlock(
    `${REVISE}请检查示例 ${APPROVED}done${APPROVED_END} 是否出现在文档中${REVISE_END}`,
    [APPROVED, REVISE],
  ));

  assert.equal(parsed.trigger, APPROVED);
  assert.equal(parsed.body, "请检查示例");
  assert.equal(parsed.response, "done\n\n是否出现在文档中");
  assert.equal(
    parsed.rawBlock,
    `${REVISE}请检查示例 ${APPROVED}done${APPROVED_END} 是否出现在文档中${REVISE_END}`,
  );
});

test("extractDecisionSignalBlock 对同名 trigger 按最早 closing tag 截取", () => {
  const parsed = assertFound(extractDecisionSignalBlock(
    `${REVISE}请检查示例 ${REVISE}done${REVISE_END} 是否出现在文档中${REVISE_END}`,
    [APPROVED, REVISE],
  ));

  assert.equal(parsed.trigger, REVISE);
  assert.equal(parsed.body, "请检查示例");
  assert.equal(parsed.response, `done\n\n是否出现在文档中${REVISE_END}`);
  assert.equal(
    parsed.rawBlock,
    `${REVISE}请检查示例 ${REVISE}done${REVISE_END} 是否出现在文档中${REVISE_END}`,
  );
});

test("extractDecisionSignalBlock 对同名裸 start trigger 按 allowed tag 继续扫描", () => {
  const parsed = assertFound(extractDecisionSignalBlock(
    `${REVISE}请检查 ${REVISE} 是否出现在文档中${REVISE_END}`,
    [APPROVED, REVISE],
  ));

  assert.equal(parsed.trigger, REVISE);
  assert.equal(parsed.body, "请检查");
  assert.equal(parsed.response, "是否出现在文档中");
  assert.equal(
    parsed.rawBlock,
    `${REVISE}请检查 ${REVISE} 是否出现在文档中${REVISE_END}`,
  );
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
    "请继续补充实现依据。",
  );
  assert.equal(
    stripDecisionResponseMarkup(
      `继续处理。\n\n${REVISE}请继续补充实现依据。${REVISE_END}`,
      [APPROVED, REVISE],
    ),
    "继续处理。\n\n请继续补充实现依据。",
  );
  assert.equal(
    stripDecisionResponseMarkup(`当前分支可以结束。\n\n${APPROVED}结束当前分支。${APPROVED_END}`, [APPROVED, REVISE]),
    "当前分支可以结束。\n\n结束当前分支。",
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
    "请继续补充实现依据。",
  );
  assert.equal(
    stripDecisionResponseMarkup(`文字 ${APPROVED} 示例`, [APPROVED, REVISE]),
    "文字\n\n示例",
  );
  assert.equal(
    stripDecisionResponseMarkup("继续处理。\n\n<chalenge>请继续补充实现依据。</chalenge>", []),
    "继续处理。\n\n<chalenge>请继续补充实现依据。</chalenge>",
  );
  assert.equal(
    stripDecisionResponseMarkup("aaaaa<trigger> bbbbb</trigger>", ["<trigger>"]),
    "aaaaa\n\nbbbbb",
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
    "请继续补证。\n\n补充说明",
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
    `${REVISE}请检查示例 ${REVISE}done${REVISE_END} 是否出现在文档中${REVISE_END}`,
  );
  assert.equal(
    stripDecisionResponseMarkup(
      `${REVISE}请检查 ${REVISE} 是否出现在文档中${REVISE_END}`,
      [APPROVED, REVISE],
    ),
    `${REVISE}请检查 ${REVISE} 是否出现在文档中${REVISE_END}`,
  );
});
