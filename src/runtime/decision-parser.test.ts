import assert from "node:assert/strict";
import { test } from "bun:test";

import { parseDecision, parseDefaultAgentResult, stripStructuredSignals } from "./decision-parser";

test("decision agent 未返回合法标签时必须判为 invalid", () => {
  const parsedDecision = parseDecision(
    "这是普通判定正文，标签写错了。\n\n<chalenge>请继续补充实现依据。</chalenge>",
    [],
  );

  assert.deepEqual(parsedDecision, {
    contentWithoutTrigger: "这是普通判定正文，标签写错了。\n\n<chalenge>请继续补充实现依据。</chalenge>",
    kind: "invalid",
    validationError: "当前 Agent 未配置任何可用 trigger",
  });
});

test("非判定 agent 未返回标签时仍按普通通过处理", () => {
  const parsedDecision = parseDefaultAgentResult("普通执行结果正文");

  assert.deepEqual(parsedDecision, {
    contentWithoutTrigger: "普通执行结果正文",
    kind: "valid",
    trigger: "<default>",
  });
});

test("decision agent 返回允许的结束 trigger 时应按该 trigger 解析", () => {
  const parsedDecision = parseDecision(
    "结论已经稳定。\n\n<complete>结束当前分支。</complete>",
    ["<complete>"],
  );

  assert.deepEqual(parsedDecision, {
    contentWithoutTrigger: "结论已经稳定。\n\n结束当前分支。",
    kind: "valid",
    trigger: "<complete>",
    rawDecisionBlock: "结论已经稳定。\n\n<complete>结束当前分支。</complete>",
  });
});

test("decision agent 支持开头裸 trigger label", () => {
  const parsedDecision = parseDecision(
    "<continue>\n下一步还需要补的证据\n\n上传目录是否被部署到了 Tomcat webroot。",
    ["<continue>"],
  );

  assert.deepEqual(parsedDecision, {
    contentWithoutTrigger: "下一步还需要补的证据\n\n上传目录是否被部署到了 Tomcat webroot。",
    kind: "valid",
    trigger: "<continue>",
    rawDecisionBlock: "<continue>\n下一步还需要补的证据\n\n上传目录是否被部署到了 Tomcat webroot。",
  });
});

test("decision agent 开头只有 trigger 没有正文时也按有效 trigger 处理", () => {
  const parsedDecision = parseDecision(
    "<complete>",
    ["<continue>", "<complete>"],
  );

  assert.deepEqual(parsedDecision, {
    contentWithoutTrigger: "",
    kind: "valid",
    trigger: "<complete>",
    rawDecisionBlock: "<complete>",
  });
});

test("decision agent 原文以 trigger label 开头且末尾重复裸 trigger 时也按有效 trigger 处理", () => {
  const parsedDecision = parseDecision(
    "<continue>\n下一步还需要补的证据\n\n上传目录是否被部署到了 Tomcat webroot。\n\n<continue>",
    ["<continue>"],
  );

  assert.deepEqual(parsedDecision, {
    contentWithoutTrigger: "下一步还需要补的证据\n\n上传目录是否被部署到了 Tomcat webroot。",
    kind: "valid",
    trigger: "<continue>",
    rawDecisionBlock: "<continue>\n下一步还需要补的证据\n\n上传目录是否被部署到了 Tomcat webroot。\n\n<continue>",
  });
});

test("decision agent 会移除开头裸 trigger 后多余的结束标签", () => {
  const parsedDecision = parseDecision(
    "<complete>\n当前分支已经完成判定，可以结束。\n</complete>",
    ["<continue>", "<complete>"],
  );

  assert.deepEqual(parsedDecision, {
    contentWithoutTrigger: "当前分支已经完成判定，可以结束。",
    kind: "valid",
    trigger: "<complete>",
    rawDecisionBlock: "<complete>\n当前分支已经完成判定，可以结束。\n</complete>",
  });
});

test("decision agent 支持根据允许的 trigger 解析自定义标签", () => {
  const parsedDecision = parseDecision(
    "证据已经补齐。\n\n<abcd>请误报论证继续回应。</abcd>",
    ["<abcd>"],
  );

  assert.deepEqual(parsedDecision, {
    contentWithoutTrigger: "证据已经补齐。\n\n请误报论证继续回应。",
    kind: "valid",
    trigger: "<abcd>",
    rawDecisionBlock: "证据已经补齐。\n\n<abcd>请误报论证继续回应。</abcd>",
  });
});

test("decision agent 支持解析正文后跟成对自定义标签块", () => {
  const parsedDecision = parseDecision(
    "aaaaa<trigger> bbbbb</trigger>",
    ["<trigger>"],
  );

  assert.deepEqual(parsedDecision, {
    contentWithoutTrigger: "aaaaa\n\nbbbbb",
    kind: "valid",
    trigger: "<trigger>",
    rawDecisionBlock: "aaaaa<trigger> bbbbb</trigger>",
  });
});

test("decision agent mixed-trigger 时必须以最后一次命中的 trigger 与回应语义为准", () => {
  const parsedDecision = parseDecision(
    "前文<continue>旧回流意见</continue>后文<complete>",
    ["<continue>", "<complete>"],
  );

  assert.deepEqual(parsedDecision, {
    contentWithoutTrigger: "前文旧回流意见后文",
    kind: "valid",
    trigger: "<complete>",
    rawDecisionBlock: "前文<continue>旧回流意见</continue>后文<complete>",
  });
});

test("decision agent wrapped 区间外的内联 bare trigger 仍按有效 trigger 处理", () => {
  const parsedDecision = parseDecision(
    "文字 <complete> 示例",
    ["<continue>", "<complete>"],
  );

  assert.deepEqual(parsedDecision, {
    contentWithoutTrigger: "文字\n\n示例",
    kind: "valid",
    trigger: "<complete>",
    rawDecisionBlock: "文字 <complete> 示例",
  });
});

test("decision agent 不会把其他 trigger 包裹块内的字面量误判成最终 trigger", () => {
  const parsedDecision = parseDecision(
    "<continue>请检查字符串 <complete> 是否出现在日志中</continue>",
    ["<continue>", "<complete>"],
  );

  assert.deepEqual(parsedDecision, {
    contentWithoutTrigger: "请检查字符串 <complete> 是否出现在日志中",
    kind: "valid",
    trigger: "<continue>",
    rawDecisionBlock: "<continue>请检查字符串 <complete> 是否出现在日志中</continue>",
  });
});

test("decision agent 开头 wrapped trigger 后仍会保留 closing tag 之后的正文", () => {
  const parsedDecision = parseDecision(
    "<continue>请继续补证。</continue>补充说明",
    ["<continue>", "<complete>"],
  );

  assert.deepEqual(parsedDecision, {
    contentWithoutTrigger: "请继续补证。\n\n补充说明",
    kind: "valid",
    trigger: "<continue>",
    rawDecisionBlock: "<continue>请继续补证。</continue>补充说明",
  });
});

test("decision agent 不会把正文里的完整 trigger 包裹对误判成最终 trigger", () => {
  const parsedDecision = parseDecision(
    "<continue>请检查示例 <complete>done</complete> 是否出现在文档中</continue>",
    ["<continue>", "<complete>"],
  );

  assert.deepEqual(parsedDecision, {
    contentWithoutTrigger: "请检查示例 <complete>done</complete> 是否出现在文档中",
    kind: "valid",
    trigger: "<continue>",
    rawDecisionBlock: "<continue>请检查示例 <complete>done</complete> 是否出现在文档中</continue>",
  });
});

test("decision agent 不会把正文里的同名 trigger 包裹对误判成最终 trigger", () => {
  const parsedDecision = parseDecision(
    "<continue>请检查示例 <continue>done</continue> 是否出现在文档中</continue>",
    ["<continue>", "<complete>"],
  );

  assert.deepEqual(parsedDecision, {
    contentWithoutTrigger: "请检查示例 <continue>done</continue> 是否出现在文档中",
    kind: "valid",
    trigger: "<continue>",
    rawDecisionBlock: "<continue>请检查示例 <continue>done</continue> 是否出现在文档中</continue>",
  });
});

test("decision agent 不会把正文里的同名裸 start trigger 误判成结构嵌套", () => {
  const parsedDecision = parseDecision(
    "<continue>请检查 <continue> 是否出现在文档中</continue>",
    ["<continue>", "<complete>"],
  );

  assert.deepEqual(parsedDecision, {
    contentWithoutTrigger: "请检查 <continue> 是否出现在文档中",
    kind: "valid",
    trigger: "<continue>",
    rawDecisionBlock: "<continue>请检查 <continue> 是否出现在文档中</continue>",
  });
});

test("存在自定义 trigger 时，未命中允许标签会直接判为 invalid", () => {
  const parsedDecision = parseDecision(
    "证据已经补齐，但忘记返回约定标签。",
    ["<abcd>"],
  );

  assert.deepEqual(parsedDecision, {
    contentWithoutTrigger: "证据已经补齐，但忘记返回约定标签。",
    kind: "invalid",
    validationError: "当前 Agent 必须返回以下 trigger 之一：<abcd>",
  });
});

test("存在自定义 trigger 时，返回未声明的示例 label 也会判为 invalid", () => {
  const parsedDecision = parseDecision(
    "<continue>请继续回应。</continue>",
    ["<abcd>"],
  );

  assert.deepEqual(parsedDecision, {
    contentWithoutTrigger: "<continue>请继续回应。</continue>",
    kind: "invalid",
    validationError: "当前 Agent 必须返回以下 trigger 之一：<abcd>",
  });
});

test("存在自定义 trigger 时，返回未声明的结束示例 label 也会判为 invalid", () => {
  const parsedDecision = parseDecision(
    "<complete>当前分支可以结束。</complete>",
    ["<abcd>"],
  );

  assert.deepEqual(parsedDecision, {
    contentWithoutTrigger: "<complete>当前分支可以结束。</complete>",
    kind: "invalid",
    validationError: "当前 Agent 必须返回以下 trigger 之一：<abcd>",
  });
});

test("stripStructuredSignals 会移除运行时结构化控制信号", () => {
  assert.equal(
    stripStructuredSignals("正文\nTASK_DONE\nNEXT_AGENTS: Build\nSESSION_REF: abc"),
    "正文",
  );
});
