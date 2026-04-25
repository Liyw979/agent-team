import assert from "node:assert/strict";
import test from "node:test";

import { parseDecision, stripStructuredSignals } from "./decision-parser";

test("decision agent 未返回合法标签时默认按 continue 处理", () => {
  const parsedDecision = parseDecision(
    "这是普通判定正文，标签写错了。\n\n<chalenge>请继续补充实现依据。</chalenge>",
    true,
  );

  assert.deepEqual(parsedDecision, {
    cleanContent: "这是普通判定正文，标签写错了。\n\n<chalenge>请继续补充实现依据。</chalenge>",
    decision: "continue",
    opinion: "这是普通判定正文，标签写错了。\n\n<chalenge>请继续补充实现依据。</chalenge>",
    rawDecisionBlock: null,
    validationError: null,
  });
});

test("非判定 agent 未返回标签时仍按普通通过处理", () => {
  const parsedDecision = parseDecision("普通执行结果正文", false);

  assert.deepEqual(parsedDecision, {
    cleanContent: "普通执行结果正文",
    decision: "complete",
    opinion: null,
    rawDecisionBlock: null,
    validationError: null,
  });
});

test("decision agent 返回 complete 标签时应判定为 complete", () => {
  const parsedDecision = parseDecision("结论已经稳定。\n\n<complete>结束当前分支。</complete>", true);

  assert.deepEqual(parsedDecision, {
    cleanContent: "结论已经稳定。",
    decision: "complete",
    opinion: "结束当前分支。",
    rawDecisionBlock: "<complete>结束当前分支。</complete>",
    validationError: null,
  });
});

test("decision agent 在正文末尾只返回裸 continue 标签时仍应判定为 continue", () => {
  const parsedDecision = parseDecision(
    "下一步还需要补的证据\n\n上传目录是否被部署到了 Tomcat webroot。\n\n<continue>",
    true,
  );

  assert.deepEqual(parsedDecision, {
    cleanContent: "下一步还需要补的证据\n\n上传目录是否被部署到了 Tomcat webroot。",
    decision: "continue",
    opinion: "下一步还需要补的证据\n\n上传目录是否被部署到了 Tomcat webroot。",
    rawDecisionBlock: "<continue>",
    validationError: null,
  });
});

test("decision agent 原文以 continue 开头且末尾重复裸 continue 时仍应判定为 continue", () => {
  const parsedDecision = parseDecision(
    "<continue>\n下一步还需要补的证据\n\n上传目录是否被部署到了 Tomcat webroot。\n\n<continue>",
    true,
  );

  assert.deepEqual(parsedDecision, {
    cleanContent: "",
    decision: "continue",
    opinion: "下一步还需要补的证据\n\n上传目录是否被部署到了 Tomcat webroot。",
    rawDecisionBlock:
      "<continue>\n下一步还需要补的证据\n\n上传目录是否被部署到了 Tomcat webroot。\n\n<continue>",
    validationError: null,
  });
});

test("stripStructuredSignals 会移除运行时结构化控制信号", () => {
  assert.equal(
    stripStructuredSignals("正文\nTASK_DONE\nNEXT_AGENTS: Build\nSESSION_REF: abc"),
    "正文",
  );
});
