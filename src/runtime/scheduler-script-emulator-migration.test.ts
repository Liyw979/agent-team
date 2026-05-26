import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  collectDecisionSnapshots,
  runSchedulerScriptDrived,
} from "../../test-support/runtime/scheduler-script-emulator";
import {
  compileBuiltinTopology,
} from "../../test-support/runtime/builtin-topology-test-helpers";
import { createTopology } from "../../test-support/runtime/topology-test-dsl";

const EXAMPLE_CONTINUE_LOOP_EDGE = {
  trigger: "<continue>",
  maxTriggerRounds: 4,
} as const;

const BUILD_MULTI_DECISION_DOWNSTREAM = {
  Build: {
    UnitTest: "<default>",
    TaskReview: "<default>",
    CodeReview: "<default>",
  },
  UnitTest: {
    Build: EXAMPLE_CONTINUE_LOOP_EDGE,
  },
  TaskReview: {
    Build: EXAMPLE_CONTINUE_LOOP_EDGE,
  },
  CodeReview: {
    Build: EXAMPLE_CONTINUE_LOOP_EDGE,
  },
} as const;

const BA_BUILD_MULTI_DECISION_DOWNSTREAM = {
  BA: {
    Build: "<default>",
  },
  ...BUILD_MULTI_DECISION_DOWNSTREAM,
} as const;

const BA_BUILD_SEQUENTIAL_APPROVAL_DOWNSTREAM = {
  BA: {
    Build: "<default>",
  },
  Build: {
    UnitTest: "<default>",
  },
  UnitTest: {
    Build: EXAMPLE_CONTINUE_LOOP_EDGE,
    CodeReview: "<complete>",
  },
  CodeReview: {
    Build: EXAMPLE_CONTINUE_LOOP_EDGE,
    TaskReview: "<complete>",
  },
  TaskReview: {
    Build: EXAMPLE_CONTINUE_LOOP_EDGE,
  },
} as const;

function renderTriggerBlock(trigger: string, content: string): string {
  return `${trigger}${content}</${trigger.slice(1, -1)}>`;
}

test("直接挂在 Build 下的后续节点会等 CodeReview 回合结束后再触发", async () => {
  const topology = createTopology({
    downstream: {
      BA: { Build: "<default>" },
      Build: {
        CodeReview: "<default>",
        UnitTest: "<default>",
        TaskReview: "<default>",
      },
      CodeReview: {
        Build: { trigger: "<continue>", maxTriggerRounds: 4 },
        UnitTest: "<approved>",
        TaskReview: "<approved>",
      },
    },
  });

  const script = [
    "user: @BA 请先完成实现，再经过 CodeReview，多轮修复结束后再进入其他判定。",
    "BA: 需求已澄清，交给 Build 继续实现。 @Build",
    "Build: Build 首轮实现完成， @CodeReview @UnitTest @TaskReview",
    "CodeReview: CodeReview 首轮未通过。 @Build",
    "UnitTest: UnitTest 已收到首轮 Build 结果。",
    "TaskReview: TaskReview 已收到首轮 Build 结果。",
    "Build: Build 已根据 CodeReview 意见修复完成。 @CodeReview",
    "CodeReview: 已确认通过，可以进入后续判定。\n\n<approved>继续后续判定</approved> @UnitTest @TaskReview",
    "UnitTest: UnitTest 已收到最终 Build 结果。",
    "TaskReview: TaskReview 已收到最终 Build 结果。",
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("旧 decisionAgent 的 trigger 目标会按 trigger 继续派发到不同的下游", async () => {
  const topology = createTopology({
    downstream: {
      Build: {
        JudgeA: "<default>",
        JudgeB: "<default>",
      },
      JudgeA: {
        Research: {
          trigger: "<revise>",
          maxTriggerRounds: 4,
        },
      },
    },
  });

  const script = [
    "user: @Build 请开始。",
    "Build: 首轮实现完成。 @JudgeA @JudgeB",
    "JudgeA: 证据还不够，我需要继续修订。 @Research",
    "JudgeB: 通过。",
    "Research: 已收到修订请求。",
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("scheduler script emulator 支持断言 execute_batch 与 finished 调度决策", async () => {
  const topology = createTopology({
    downstream: {
      BA: { Build: "<default>" },
      Build: {
        CodeReview: "<default>",
        UnitTest: "<default>",
      },
      CodeReview: {
        Build: EXAMPLE_CONTINUE_LOOP_EDGE,
        UnitTest: "<approved>",
      },
    },
  });

  const script = [
    "user: @BA 请先完成实现。",
    "BA: 需求已澄清，交给 Build。 @Build",
    "Build: 首轮实现完成。 @CodeReview @UnitTest",
    "CodeReview: 需要修复一个问题。 @Build",
    "UnitTest: 当前结果可接受。",
    "Build: 已修复 CodeReview 提到的问题。 @CodeReview",
    "CodeReview: 已通过当前判定。\n\n<approved>通过。</approved> @UnitTest",
    "UnitTest: 通过。",
  ];

  const trace = await runSchedulerScriptDrived({ topology, script });

  assert.deepEqual(collectDecisionSnapshots(trace), [
    { type: "execute_batch", source: { kind: "user" }, targets: ["BA"] },
    { type: "execute_batch", source: { kind: "agent", agentId: "BA" }, targets: ["Build"] },
    {
      type: "execute_batch",
      source: { kind: "agent", agentId: "Build" },
      targets: ["CodeReview", "UnitTest"],
    },
    { type: "execute_batch", source: { kind: "agent", agentId: "CodeReview" }, targets: ["Build"] },
    { type: "finished_with_reason", finishReason: "no_runnable_agents" },
    { type: "execute_batch", source: { kind: "agent", agentId: "Build" }, targets: ["CodeReview"] },
    { type: "execute_batch", source: { kind: "agent", agentId: "CodeReview" }, targets: ["UnitTest"] },
    { type: "finished_with_reason", finishReason: "all_agents_completed" },
  ]);

  const unitTestWaitingStep = trace.steps.find((step) => step.lineIndex === 4);
  if (!unitTestWaitingStep) {
    assert.fail("缺少 UnitTest 首轮回复对应的等待态步骤");
  }
  assert.equal(unitTestWaitingStep.afterDecision.type, "finished");
  if (unitTestWaitingStep.afterDecision.type !== "finished") {
    assert.fail("UnitTest 首轮回复后未进入等待态");
  }
  assert.equal(unitTestWaitingStep.afterDecision.finishReason, "no_runnable_agents");

  const approvedDispatchStep = trace.steps.find((step) => step.lineIndex === 6);
  if (!approvedDispatchStep || approvedDispatchStep.afterDecision.type !== "execute_batch") {
    assert.fail("缺少 CodeReview 通过后显式触发 approved 下游的调度步骤");
  }
  assert.deepEqual(
    approvedDispatchStep.afterDecision.batch.jobs.map((job) => job.agentId),
    ["UnitTest"],
  );
});

test("漏洞团队沿用纯文本 finding 正文时，group 仍会按既有语义继续展开", async () => {
  const topology = compileBuiltinTopology("vulnerability.yaml").topology;

  const script = [
    "user: @线索发现 请持续挖掘当前代码中的可疑漏洞点，直到没有新 finding 为止。",
    "线索发现: 发现第 1 个可疑点：上传文件名可能被直接拼进目标路径。 @误报论证-1",
    "误报论证-1: 当前材料还缺少从入口到落盘点的完整调用链。 @漏洞论证-1",
    "漏洞论证-1: 第一轮补证：上传入口会把原始文件名透传到保存逻辑。 @误报论证-1",
    "误报论证-1: 第二轮质疑：还缺少目标路径是否真正受控的证据。 @漏洞论证-1",
    "漏洞论证-1: <agree>第二轮补证：存储层直接执行 path.join(uploadRoot, filename)，未见对 .. 或分隔符的拦截。</agree> @讨论总结-1",
    "讨论总结-1: 当前这条更像真实漏洞。 @线索发现",
    "线索发现: 已检查 HTTP/2 请求入口、管理后台导出接口，暂时没有新的可疑点；内部任务执行入口仍缺少更细代码证据。 @线索完备性评估",
    `线索完备性评估: ${renderTriggerBlock("<complete>", "当前高价值入口已经覆盖，可以结束本轮。")}`,
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("rfc-scanner 拓扑里的双向 <continue> 对弈在第 5 轮会转给讨论总结，避免团队停住", async () => {
  const topology = compileBuiltinTopology("rfc-scanner.yaml").topology;

  const script = [
    "user: @线索发现 RFC 5321 第 2.3.8 节",
    "线索发现: <continue>发现了一个可疑点 @误报论证-1",
    "误报论证-1: <continue>需要继续补证据 @漏洞论证-1",
    "漏洞论证-1: <continue>第一轮补证 @误报论证-1",
    "误报论证-1: <continue>第二轮质疑 @漏洞论证-1",
    "漏洞论证-1: <continue>第二轮补证 @误报论证-1",
    "误报论证-1: <continue>第三轮质疑 @漏洞论证-1",
    "漏洞论证-1: <continue>第三轮补证 @误报论证-1",
    "误报论证-1: <continue>第四轮质疑 @漏洞论证-1",
    "漏洞论证-1: <continue>第四轮补证 @误报论证-1",
    "误报论证-1: <continue>第五轮质疑 @讨论总结-1",
    "讨论总结-1: 当前讨论达到回流上限，先归档这一轮结论。 @线索发现",
    "线索发现: <complete>当前没有新的可疑点 @线索完备性评估",
    "线索完备性评估: <complete>当前项目可以结束本轮挖掘。",
  ];

  const trace = await runSchedulerScriptDrived({ topology, script });
  const escalationStep = trace.steps.find((item) => item.lineIndex === 10);
  if (!escalationStep || escalationStep.afterDecision.type !== "execute_batch") {
    assert.fail("缺少第 5 轮回流转向讨论总结的调度步骤");
  }

  assert.deepEqual(escalationStep.afterDecision.batch.source, { kind: "agent", agentId: "误报论证-1" });
  assert.equal(escalationStep.afterDecision.batch.routingKind, "triggered");
  assert.equal(escalationStep.afterDecision.batch.trigger, "<complete>");
  assert.equal(escalationStep.afterDecision.batch.displayContent, "误报论证-1 -> 漏洞论证-1 已连续交流 4 次");
  assert.deepEqual(escalationStep.afterDecision.batch.jobs.map((job) => job.agentId), ["讨论总结-1"]);
});

test("rfc-scanner 拓扑接受前后重复 trigger 的挑战回复，并继续派发到漏洞论证", async () => {
  const topology = compileBuiltinTopology("rfc-scanner.yaml").topology;

  const script = [
    "user: @线索发现 RFC 5321 第 2.3.8 节",
    "线索发现: <continue>发现了一个可疑点 @误报论证-1",
    "误报论证-1: <continue>\n这更像协议严格性问题，不是安全漏洞。\n\n<continue> @漏洞论证-1",
    "漏洞论证-1: <agree>当前可以进入讨论总结。 @讨论总结-1",
    "讨论总结-1: 当前这轮讨论已经形成结论。 @线索发现",
    "线索发现: <complete>当前没有新的可疑点 @线索完备性评估",
    "线索完备性评估: <complete>当前项目可以结束本轮扫描。",
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("脚本模式支持用户首条直接 @decisionAgent 并沿 trigger 回路继续推进", async () => {
  const topology = createTopology({
    downstream: {
      安全负责人: {
        漏洞分析人员: {
          trigger: "<revise>",
          maxTriggerRounds: 4,
        },
        结论归档: "<closed>",
      },
      漏洞分析人员: {
        安全负责人: {
          trigger: "<revise>",
          maxTriggerRounds: 4,
        },
      },
    },
  });
  const script = [
    "user: @安全负责人 请先判断这个漏洞定性是否站得住。",
    "安全负责人: 证据链还不闭环，请继续补充代码与复现依据。 @漏洞分析人员",
    "漏洞分析人员: 我会继续补充请求构造、路由和复现证据。 @安全负责人",
    "安全负责人: 我已收到补充材料，请继续把缺失证据补齐。 @漏洞分析人员",
    "漏洞分析人员: 我已补齐本轮缺失证据。 @安全负责人",
    "安全负责人: 当前证据链已闭环，可以归档结论。\n\n<closed>当前证据链已闭环，可以结束本轮。</closed> @结论归档",
    "结论归档: 已收到结论并完成归档。",
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("通用调度脚本模式支持非 Build 的实现者反复修复 decisionAgent 意见", async () => {
  const topology = createTopology({
    downstream: {
      Implementer: {
        UnitTest: "<default>",
        TaskReview: "<default>",
        CodeReview: "<default>",
      },
      UnitTest: {
        Implementer: EXAMPLE_CONTINUE_LOOP_EDGE,
        TaskReview: "<approved>",
        CodeReview: "<approved>",
      },
    },
  });

  const script = [
    "user: @Implementer 请完成这个需求",
    "Implementer: 第 1 轮实现完成 @UnitTest @TaskReview @CodeReview",
    "UnitTest: 第 1 轮单测未通过 @Implementer",
    `TaskReview: ${renderTriggerBlock("<complete>", "认可")}`,
    `CodeReview: ${renderTriggerBlock("<complete>", "认可")}`,
    "Implementer: 已修复第 1 轮问题 @UnitTest",
    "UnitTest: 第 2 轮单测未通过 @Implementer",
    "Implementer: 已修复第 2 轮问题 @UnitTest",
    "UnitTest: 当前结果已经达标，可以进入其余评审。\n\n<approved>认可</approved> @TaskReview @CodeReview",
    `TaskReview: ${renderTriggerBlock("<complete>", "认可")}`,
    `CodeReview: ${renderTriggerBlock("<complete>", "认可")}`,
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("脚本模式要求 topology 显式给出边，脚本里的派发不能脱离 topology 单独存在", async () => {
  const topology = createTopology({
    extraNodes: ["TaskReview", "CodeReview"],
    downstream: {
      Implementer: { UnitTest: "<default>" },
      UnitTest: { Implementer: EXAMPLE_CONTINUE_LOOP_EDGE },
    },
  });

  const script = [
    "user: @Implementer 请完成这个需求",
    "Implementer: 第 1 轮实现完成 @UnitTest @TaskReview @CodeReview",
  ];

  await assert.rejects(
    () => runSchedulerScriptDrived({ topology, script }),
    /调度目标不匹配|无法唯一推断|没有对应的拓扑边/u,
  );
});

test("通用调度脚本模式支持 decisionAgent 通过后显式触发 approved 下游", async () => {
  const topology = createTopology({
    downstream: {
      BA: { Implementer: "<default>" },
      Implementer: { CodeReview: "<default>" },
      CodeReview: {
        Implementer: EXAMPLE_CONTINUE_LOOP_EDGE,
        TaskReview: "<complete>",
        UnitTest: "<complete>",
      },
    },
  });

  const script = [
    "user: @BA 请先澄清需求再推进实现",
    "BA: 需求已经澄清 @Implementer",
    "Implementer: 首轮实现完成 @CodeReview",
    "CodeReview: 还需要修复 @Implementer",
    "Implementer: 已根据意见修复 @CodeReview",
    "CodeReview: 通过并进入后续判定 @TaskReview @UnitTest",
    "TaskReview: 认可",
    "UnitTest: 认可",
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("脚本模式支持 decisionAgent 用开头 <complete> + 正文命中结束边", async () => {
  const topology = createTopology({
    downstream: {
      Build: { TaskReview: "<default>" },
      TaskReview: { __end__: "<complete>" },
    },
  });

  const script = [
    "user: @Build 请完成这个需求。",
    "Build: Build 首轮实现完成。 @TaskReview",
    "TaskReview: <complete>\n当前证据链已经完整，可以结束本轮判定。",
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("脚本模式支持 decisionAgent 显式返回自定义 label 并按该 label 派发下游", async () => {
  const topology = createTopology({
    downstream: {
      Build: {
        Judge: "<default>",
      },
      Judge: {
        Build: {
          trigger: "<revise>",
          maxTriggerRounds: 2,
        },
        Summary: "<approved>",
      },
    },
  });

  const script = [
    "user: @Build 请开始处理。",
    "Build: 初版结果已经完成。 @Judge",
    "Judge: 证据已经满足，可以进入总结。\n\n<approved>请输出最终结论。</approved> @Summary",
    "Summary: 最终结论已输出。",
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("脚本首条 user 显式 @ 的 Agent 只要存在于 topology.nodes 就允许作为起点", async () => {
  const topology = createTopology({
    extraNodes: ["BA"],
    downstream: {
      Implementer: { TaskReview: "<default>" },
    },
  });

  const script = [
    "user: @Implementer 请直接开始实现",
    "Implementer: 已完成实现 @TaskReview",
    "TaskReview: 认可",
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("当前调度不支持在 <continue> 对弈中由发起方直接跳到裁决", async () => {
  const topology = createTopology({
    downstream: {
      Discovery: { Challenger: "<default>" },
      Analyst: { Challenger: EXAMPLE_CONTINUE_LOOP_EDGE, Judge: "<complete>" },
      Challenger: { Analyst: EXAMPLE_CONTINUE_LOOP_EDGE, Judge: "<complete>" },
      Judge: { Discovery: "<complete>" },
    },
  });

  const script = [
    "user: @Discovery 请持续挖掘当前代码中的可疑问题。",
    "Discovery: 发现第 1 个可疑点：上传文件名可能被直接拼进目标路径。 @Challenger",
    "Challenger: 目前证据不够，缺少从入口到落盘路径的完整调用链。 @Analyst",
    "Analyst: 我已补齐入口、过滤逻辑与落盘点，请 Challenger 重新判断。 @Challenger",
    "Challenger: 当前证据链已经闭环，直接提交 Judge。 @Judge",
  ];

  await assert.rejects(
    () => runSchedulerScriptDrived({ topology, script }),
    /Judge|脚本提前结束|当前还缺少/u,
  );
});

test("脚本模式支持通用 decisionAgent 在回流超限后转给 approved 下游裁决", async () => {
  const topology = createTopology({
    downstream: {
      Build: { UnitTest: "<default>" },
      UnitTest: {
        Build: EXAMPLE_CONTINUE_LOOP_EDGE,
        Judge: "<complete>",
      },
    },
  });

  const script = [
    "user: @Build 请完成这个需求",
    "Build: 第 1 轮实现完成。 @UnitTest",
    "UnitTest: 第 1 轮单测未通过。 @Build",
    "Build: 已修复第 1 轮问题。 @UnitTest",
    "UnitTest: 第 2 轮单测未通过。 @Build",
    "Build: 已修复第 2 轮问题。 @UnitTest",
    "UnitTest: 第 3 轮单测未通过。 @Build",
    "Build: 已修复第 3 轮问题。 @UnitTest",
    "UnitTest: 第 4 轮单测未通过。 @Build",
    "Build: 已修复第 4 轮问题。 @UnitTest",
    "UnitTest: 已达到交流上限，请直接裁决。 @Judge",
    "Judge: 裁决完成，当前结果到此收束。",
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("漏洞挖掘团队脚本支持论证挑战对弈超限后自动转给讨论总结", async () => {
  const topology = compileBuiltinTopology("vulnerability.yaml").topology;

  const script = [
    "user: @线索发现 请持续挖掘当前代码中的可疑漏洞点。",
    "线索发现: 发现第 1 个可疑点：上传文件名可能被直接拼进目标路径。 @误报论证-1",
    "误报论证-1: 第 1 轮质疑：缺少从入口到落盘的完整调用链。 @漏洞论证-1",
    "漏洞论证-1: 第 1 轮补证：已补齐入口、过滤逻辑与落盘点。 @误报论证-1",
    "误报论证-1: 第 2 轮质疑：还缺少默认虚拟主机映射证据。 @漏洞论证-1",
    "漏洞论证-1: 第 2 轮补证：已补齐 mapper 与 default host 路径。 @误报论证-1",
    "误报论证-1: 第 3 轮质疑：还缺少协议层拒绝点对照。 @漏洞论证-1",
    "漏洞论证-1: 第 3 轮补证：已补齐 h2 与 h2c 的差异证据。 @误报论证-1",
    "误报论证-1: 第 4 轮质疑：还缺少最终利用面说明。 @漏洞论证-1",
    "漏洞论证-1: <agree>第 4 轮补证：已补齐默认主机承接与安全影响。</agree> @讨论总结-1",
    "讨论总结-1: 该点是否成立已可直接判断，回到线索发现继续下一处。 @线索发现",
    "线索发现: 已检查 HTTP/2 请求入口、管理后台导出接口，暂时没有新的可疑点；内部任务执行入口仍缺少更细代码证据。 @线索完备性评估",
    `线索完备性评估: ${renderTriggerBlock("<complete>", "当前高价值入口已经覆盖，可以结束本轮。")}`,
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("漏洞挖掘团队脚本里讨论总结完成后会回到线索发现继续挖掘", async () => {
  const topology = compileBuiltinTopology("vulnerability.yaml").topology;
  const script = [
    "user: @线索发现 请持续挖掘当前代码中的可疑漏洞点。",
    "线索发现: 发现第 1 个可疑点：上传文件名可能被直接拼进目标路径。 @误报论证-1",
    "误报论证-1: 当前材料还缺少从入口到落盘点的完整调用链。 @漏洞论证-1",
    "漏洞论证-1: 第一轮补证：上传入口会把原始文件名透传到保存逻辑。 @误报论证-1",
    "误报论证-1: 第二轮质疑：还缺少目标路径是否真正受控的证据。 @漏洞论证-1",
    "漏洞论证-1: <agree>第二轮补证：存储层直接执行 path.join(uploadRoot, filename)，未见对 .. 或分隔符的拦截。</agree> @讨论总结-1",
    "讨论总结-1: 当前这条更像真实漏洞。 @线索发现",
    "线索发现: <continue>发现第 2 个可疑点：内部调试接口似乎缺少鉴权。 @误报论证-2",
    "误报论证-2: 当前材料更像误报，缺少生产环境可达性证据。 @漏洞论证-2",
    "漏洞论证-2: 第一轮补证：调试路由默认注册，且局部未见鉴权中间件。 @误报论证-2",
    "误报论证-2: 第二轮质疑：仍然缺少环境开关实际放行的证据。 @漏洞论证-2",
    "漏洞论证-2: <agree>第二轮补证后，当前仍无法证明生产环境可利用，只能进入总结。</agree> @讨论总结-2",
    "讨论总结-2: 当前这条更像误报。 @线索发现",
    "线索发现: 已检查 HTTP/2 请求入口、管理后台导出接口，暂时没有新的可疑点；内部任务执行入口仍缺少更细代码证据。 @线索完备性评估",
    `线索完备性评估: ${renderTriggerBlock("<complete>", "当前高价值入口已经覆盖，可以结束本轮。")}`,
  ];
  await runSchedulerScriptDrived({ topology, script });
});

test("漏洞挖掘团队脚本里线索完备性评估要求继续时，会把具体补查方向回给线索发现", async () => {
  const topology = compileBuiltinTopology("vulnerability.yaml").topology;
  const script = [
    "user: @线索发现 请持续挖掘当前代码中的可疑漏洞点。",
    "线索发现: 发现第 1 个可疑点：上传文件名可能被直接拼进目标路径。 @误报论证-1",
    "误报论证-1: 当前材料还缺少从入口到落盘点的完整调用链。 @漏洞论证-1",
    "漏洞论证-1: 第一轮补证：上传入口会把原始文件名透传到保存逻辑。 @误报论证-1",
    "误报论证-1: 第二轮质疑：还缺少目标路径是否真正受控的证据。 @漏洞论证-1",
    "漏洞论证-1: <agree>第二轮补证：存储层直接执行 path.join(uploadRoot, filename)，未见对 .. 或分隔符的拦截。</agree> @讨论总结-1",
    "讨论总结-1: 当前这条更像真实漏洞。 @线索发现",
    "线索发现: 已检查 HTTP/2 请求入口与 header 解析、管理后台导出接口，暂时没有新的可疑点；内部任务执行入口仍缺少更细代码证据。 @线索完备性评估",
    "线索完备性评估: 你还没有检查管理后台导出链路和内部任务执行入口，请继续寻找新的可疑点。 @线索发现",
    "线索发现: <continue>发现第 2 个可疑点：内部任务执行入口似乎允许未授权触发高危操作。 @误报论证-2",
    "误报论证-2: 当前材料还缺少生产环境可达性证据。 @漏洞论证-2",
    "漏洞论证-2: <agree>已补齐任务入口注册方式与权限判定缺口，可以进入总结。</agree> @讨论总结-2",
    "讨论总结-2: 当前这条更像待定，需要后续继续补证。 @线索发现",
    "线索发现: 已检查 HTTP/2 请求入口、管理后台导出链路、内部任务执行入口，暂时没有新的可疑点；暂未发现新的高价值遗漏区域。 @线索完备性评估",
    `线索完备性评估: ${renderTriggerBlock("<complete>", "当前高价值入口已经覆盖，可以结束本轮。")}`,
  ];
  await runSchedulerScriptDrived({ topology, script });
});

test("漏洞挖掘团队脚本允许挑战侧单边 <agree> 直接进入讨论总结", async () => {
  const topology = compileBuiltinTopology("vulnerability.yaml").topology;
  const script = [
    "user: @线索发现 请持续挖掘当前代码中的可疑漏洞点。",
    "线索发现: <continue>发现第 1 个可疑点：内部调试接口似乎缺少鉴权。 @误报论证-1",
    "误报论证-1: <agree>当前材料已经足够进入总结。</agree> @讨论总结-1",
    "讨论总结-1: 当前这条更像误报。 @线索发现",
    "线索发现: 已检查内部调试接口，当前没有新的可疑点。 @线索完备性评估",
    `线索完备性评估: ${renderTriggerBlock("<complete>", "当前高价值入口已经覆盖，可以结束本轮。")}`,
  ];
  await runSchedulerScriptDrived({ topology, script });
});

test("漏洞挖掘团队脚本不再接受非法短别名", async () => {
  const topology = compileBuiltinTopology("vulnerability.yaml").topology;

  const script = [
    "user: @线索发现 请持续挖掘当前代码中的可疑漏洞点。",
    "线索发现: 发现第 1 个可疑点：上传文件名可能被直接拼进目标路径。 @误报论证-alias1",
    "误报论证-alias1: 目前证据仍有缺口，需要继续补齐。 @漏洞论证-alias1",
    "漏洞论证-alias1: <agree>我已补齐入口、过滤逻辑与落盘点，当前证据链已经闭环，可以进入裁决。</agree> @讨论总结-alias1",
    "讨论总结-alias1: 该点成立为漏洞，输出正式漏洞报告。 @线索发现",
    "线索发现: 发现第 2 个可疑点：内部调试接口似乎缺少鉴权。 @误报论证-alias2",
    "误报论证-alias2: <agree>当前材料更像误报，可以进入裁决。</agree> @讨论总结-alias2",
    "讨论总结-alias2: 该点暂不成立。 @线索发现",
  ];

  await assert.rejects(
    () => runSchedulerScriptDrived({ topology, script }),
    /不存在的 Agent|误报论证-alias1|漏洞论证-alias1/u,
  );
});

test("CodeReview 触发下游后，脚本可直接按显式 trigger 派发的目标继续", async () => {
  const topology = createTopology({
    downstream: {
      BA: { Build: "<default>" },
      Build: {
        CodeReview: "<default>",
        UnitTest: "<default>",
      },
      CodeReview: {
        Build: EXAMPLE_CONTINUE_LOOP_EDGE,
        TaskReview: "<complete>",
      },
    },
  });

  const script = [
    "user: @BA 请先实现，然后只在 CodeReview 通过后再跑 UnitTest。",
    "BA: 需求明确，交给 Build 实现。 @Build",
    "Build: Build 已完成实现，等待 CodeReview 结论。 @CodeReview @UnitTest",
    "CodeReview: CodeReview 通过，可以继续后续流程。 @TaskReview",
    "TaskReview: TaskReview 已收到最新结果。",
    "UnitTest: UnitTest 已收到 Build 最新结果。",
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("super-step 模式下 decisionAgent 不再拦住同轮其他 handoff 下游", async () => {
  const topology = createTopology({
    downstream: {
      BA: { Build: "<default>" },
      Build: {
        CodeReview: "<default>",
        UnitTest: "<default>",
      },
      CodeReview: {
        Build: EXAMPLE_CONTINUE_LOOP_EDGE,
        TaskReview: "<complete>",
      },
    },
  });

  const script = [
    "user: @BA 请先实现，然后让 CodeReview 和 UnitTest 在同一轮一起执行。",
    "BA: 需求明确，交给 Build 实现。 @Build",
    "Build: Build 已完成实现，开始同轮判定。 @CodeReview @UnitTest",
    "UnitTest: UnitTest 已完成本轮校验。",
    "CodeReview: CodeReview 通过，可以继续后续流程。 @TaskReview",
    "TaskReview: TaskReview 已收到最新结果。",
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("旧链路里把未显式声明的 <complete> 当作普通 label 之外的特殊语义时，脚本校验会直接失败", async () => {
  const topology = createTopology({
    downstream: BA_BUILD_SEQUENTIAL_APPROVAL_DOWNSTREAM,
  });

  const script = [
    "user: @BA 请实现 add 方法，并把结果写入 add.js。",
    "BA: 已整理实现要求，交给 Build。 @Build",
    "Build: 第 1 次构建完成。 @UnitTest",
    "UnitTest: 单元测试未通过，继续修复。 @Build",
    "Build: 第 2 次构建完成。 @UnitTest",
    "UnitTest: 单元测试通过，进入下一段判定。 @CodeReview",
    "CodeReview: 代码判定未通过，继续完善实现。 @Build",
    "Build: 第 3 次构建完成。 @UnitTest",
    "UnitTest: 单元测试通过，进入下一段判定。 @CodeReview",
    "CodeReview: 代码已完成判定，进入最终交付判定。 @TaskReview",
    "TaskReview: 最终交付未通过，需要再补一轮稳定交付。 @Build",
    "Build: 第 4 次构建完成。 @UnitTest",
    "UnitTest: 单元测试通过，进入下一段判定。 @CodeReview",
    "CodeReview: 代码已完成判定，进入最终交付判定。 @TaskReview",
    `TaskReview: ${renderTriggerBlock("<complete>", "任务交付通过，当前结果可以结束。")} @Build`,
  ];

  await assert.rejects(
    () => runSchedulerScriptDrived({ topology, script }),
    /脚本提前结束|当前还缺少 \[Build\]|@Build/u,
  );
});

test("未显式声明通过 trigger 的多 decisionAgent 长链路脚本不会再被隐式接受", async () => {
  const topology = createTopology({
    downstream: BUILD_MULTI_DECISION_DOWNSTREAM,
  });

  const script = [
    "user: @Build 请完成这个需求",
    "Build: Build 第 1 轮实现完成，@UnitTest @TaskReview @CodeReview",
    "UnitTest: UnitTest 第 1 轮未通过 @Build",
    `TaskReview: ${renderTriggerBlock("<complete>", "ok")}`,
    `CodeReview: ${renderTriggerBlock("<complete>", "ok")}`,
    "Build: 已修复 UnitTest 第 1 轮问题 @UnitTest",
    "UnitTest: UnitTest 第 2 轮未通过 @Build",
    "Build: 已修复 UnitTest 第 2 轮问题 @UnitTest",
    "UnitTest: UnitTest 第 3 轮未通过 @Build",
    "Build: 已修复 UnitTest 第 3 轮问题 @UnitTest",
    "UnitTest: UnitTest 第 4 轮未通过 @Build",
    "Build: 已修复 UnitTest 第 4 轮问题 @UnitTest",
    `UnitTest: ${renderTriggerBlock("<complete>", "UnitTest 第 5 轮通过，可以进入后续判定。")} @Build`,
    "Build: @TaskReview @CodeReview",
    "TaskReview: TaskReview 第 1 轮未通过 @Build",
    `CodeReview: ${renderTriggerBlock("<complete>", "ok")}`,
    "Build: 已修复 TaskReview 第 1 轮问题 @TaskReview",
    "TaskReview: TaskReview 第 2 轮未通过 @Build",
    "Build: 已修复 TaskReview 第 2 轮问题 @TaskReview",
    `TaskReview: ${renderTriggerBlock("<complete>", "认可 Build 结果。")}`,
    "Build: @UnitTest @CodeReview",
    `CodeReview: ${renderTriggerBlock("<complete>", "ok")}`,
    "UnitTest: UnitTest 第 6 轮未通过 @Build",
    "Build: 已修复 UnitTest 第 6 轮问题 @UnitTest",
    `UnitTest: ${renderTriggerBlock("<complete>", "ok")}`,
    "Build: @TaskReview @CodeReview",
    `TaskReview: ${renderTriggerBlock("<complete>", "认可 Build 结果。")}`,
    "CodeReview: 不认可 @Build",
    "Build: 已修复 CodeReview 意见 @CodeReview",
    `CodeReview: ${renderTriggerBlock("<complete>", "认可")}`,
    "Build: @UnitTest @TaskReview",
    `UnitTest: ${renderTriggerBlock("<complete>", "同意")}`,
    `TaskReview: ${renderTriggerBlock("<complete>", "同意")}`,
  ];

  await assert.rejects(
    () => runSchedulerScriptDrived({ topology, script }),
    /脚本包含 \[\]|当前步骤模拟值为 \[Build\]|@Build/u,
  );
});

test("同一 decisionAgent 连续多轮回流后若改用未声明的通过 trigger，脚本校验会失败", async () => {
  const topology = createTopology({
    downstream: BUILD_MULTI_DECISION_DOWNSTREAM,
  });

  const script = [
    "user: @Build 请完成这个需求",
    "Build: Build 第 1 轮实现完成，@UnitTest @TaskReview @CodeReview",
    "UnitTest: UnitTest 第 1 轮未通过 @Build",
    `TaskReview: ${renderTriggerBlock("<complete>", "ok")}`,
    `CodeReview: ${renderTriggerBlock("<complete>", "ok")}`,
    "Build: 已修复 UnitTest 第 1 轮问题 @UnitTest",
    "UnitTest: UnitTest 第 2 轮未通过 @Build",
    "Build: 已修复 UnitTest 第 2 轮问题 @UnitTest",
    "UnitTest: UnitTest 第 3 轮未通过 @Build",
    "Build: 已修复 UnitTest 第 3 轮问题 @UnitTest",
    "UnitTest: UnitTest 第 4 轮未通过 @Build",
    "Build: 已修复 UnitTest 第 4 轮问题 @UnitTest",
    `UnitTest: ${renderTriggerBlock("<complete>", "UnitTest 第 5 轮通过，可以结束。")} @Build`,
    "Build: @TaskReview @CodeReview",
    `TaskReview: ${renderTriggerBlock("<complete>", "ok")}`,
    `CodeReview: ${renderTriggerBlock("<complete>", "ok")}`,
  ];

  await assert.rejects(
    () => runSchedulerScriptDrived({ topology, script }),
    /脚本包含 \[\]|当前步骤模拟值为 \[Build\]|@Build/u,
  );
});

test("长链路脚本里同一 decisionAgent 连续第 5 次回流时会被判定为非法循环", async () => {
  const topology = createTopology({
    downstream: BUILD_MULTI_DECISION_DOWNSTREAM,
  });

  const script = [
    "user: @Build 请完成这个需求",
    "Build: Build 第 1 轮实现完成，@UnitTest @TaskReview @CodeReview",
    "UnitTest: UnitTest 第 1 轮未通过 @Build",
    `TaskReview: ${renderTriggerBlock("<complete>", "ok")}`,
    `CodeReview: ${renderTriggerBlock("<complete>", "ok")}`,
    "Build: 已修复 UnitTest 第 1 轮问题 @UnitTest",
    "UnitTest: UnitTest 第 2 轮未通过 @Build",
    "Build: 已修复 UnitTest 第 2 轮问题 @UnitTest",
    "UnitTest: UnitTest 第 3 轮未通过 @Build",
    "Build: 已修复 UnitTest 第 3 轮问题 @UnitTest",
    "UnitTest: UnitTest 第 4 轮未通过 @Build",
    "Build: 已修复 UnitTest 第 4 轮问题 @UnitTest",
    "UnitTest: UnitTest 第 5 轮未通过 @Build",
  ];

  await assert.rejects(
    runSchedulerScriptDrived({ topology, script }),
    /调度目标不匹配|无法唯一推断|已连续交流 4 次|脚本包含 \[\]|当前步骤模拟值为 \[Build\]/u,
  );
});

test("脚本模式会读取 trigger 边上的 maxTriggerRounds 覆盖值", async () => {
  const topology = createTopology({
    downstream: {
      Build: {
        UnitTest: "<default>",
      },
      UnitTest: {
        Build: {
          trigger: "<continue>",
          maxTriggerRounds: 2,
        },
      },
    },
  });

  const script = [
    "user: @Build 请完成这个需求",
    "Build: 第 1 轮实现完成。 @UnitTest",
    "UnitTest: 第 1 轮单测未通过。 @Build",
    "Build: 已修复第 1 轮问题。 @UnitTest",
    "UnitTest: 第 2 轮单测未通过。 @Build",
    "Build: 已修复第 2 轮问题。 @UnitTest",
    "UnitTest: 第 3 轮单测未通过。 @Build",
  ];

  await assert.rejects(
    runSchedulerScriptDrived({ topology, script }),
    /无法唯一推断|已连续交流 2 次|当前还缺少 \[Build\]/u,
  );
});

test("旧脚本若继续依赖未声明的 <complete> label 补发 stale decisionAgent，会被校验拒绝", async () => {
  const topology = createTopology({
    downstream: BA_BUILD_MULTI_DECISION_DOWNSTREAM,
  });

  const script = [
    "user: @BA 在当前项目的一个临时文件中实现一个加法工具，调用后传入a和b，返回c",
    "BA: 已整理需求，交给 Build。 @Build",
    "Build: 已实现第 1 轮，@UnitTest @TaskReview @CodeReview",
    "UnitTest: 不通过 @Build",
    `TaskReview: ${renderTriggerBlock("<continue>", "不通过")} @Build`,
    `CodeReview: ${renderTriggerBlock("<continue>", "不通过")}`,
    "Build: 已修复 UnitTest 第 1 轮问题 @UnitTest",
    `UnitTest: ${renderTriggerBlock("<complete>", "通过")} @Build`,
    "Build: @TaskReview @CodeReview",
    `TaskReview: ${renderTriggerBlock("<continue>", "不通过")} @Build`,
    `CodeReview: ${renderTriggerBlock("<continue>", "不通过")}`,
    "Build: 已修复 TaskReview 第 1 轮问题 @TaskReview",
    `TaskReview: ${renderTriggerBlock("<complete>", "通过")}`,
    "Build: @UnitTest @CodeReview",
    `CodeReview: ${renderTriggerBlock("<continue>", "不通过")} @Build`,
    `UnitTest: ${renderTriggerBlock("<complete>", "通过")}`,
    "Build: 已修复 CodeReview 第 1 轮问题 @CodeReview",
    `CodeReview: ${renderTriggerBlock("<complete>", "通过")} @Build`,
    "Build: @UnitTest @TaskReview",
    `UnitTest: ${renderTriggerBlock("<complete>", "通过")}`,
    `TaskReview: ${renderTriggerBlock("<complete>", "通过")}`,
  ];

  await assert.rejects(
    () => runSchedulerScriptDrived({ topology, script }),
    /sender 不是当前调度批次的 source|脚本包含 \[\]|当前步骤模拟值为 \[Build\]|调度目标不匹配/u,
  );
});

test("同一批 decisionAgent 若混入未声明的 <complete> label，不会再被当作合法回复顺序", async () => {
  const topology = createTopology({
    downstream: BUILD_MULTI_DECISION_DOWNSTREAM,
  });

  const script = [
    "user: @Build 请完成这个需求",
    "Build: 第 1 轮实现完成，@UnitTest @TaskReview @CodeReview",
    `CodeReview: ${renderTriggerBlock("<complete>", "通过")}`,
    "UnitTest: 不通过 @Build",
    `TaskReview: ${renderTriggerBlock("<complete>", "通过")}`,
    "Build: 已修复 UnitTest 第 1 轮问题 @UnitTest",
    `UnitTest: ${renderTriggerBlock("<complete>", "通过")}`,
    "Build: @TaskReview @CodeReview",
    `CodeReview: ${renderTriggerBlock("<complete>", "通过")}`,
    `TaskReview: ${renderTriggerBlock("<complete>", "通过")}`,
  ];

  await assert.rejects(
    () => runSchedulerScriptDrived({ topology, script }),
    /脚本包含 \[\]|当前步骤模拟值为 \[Build\]|sender 不是当前调度批次的 source/u,
  );
});

test("真实日志里重复 decisionAgent 回复并在整批失败后再次全量派发，不应通过脚本校验", async () => {
  const topology = createTopology({
    downstream: BA_BUILD_MULTI_DECISION_DOWNSTREAM,
  });

  const script = [
    "user: @BA 在当前项目的一个临时文件中实现一个加法工具，调用后传入a和b，返回c",
    "BA: 可以把这个需求整理成可直接执行的版本。 @Build",
    "Build: 已经在当前项目里新增了临时文件 temp_add.py，@UnitTest @TaskReview @CodeReview",
    "UnitTest: 发现两个问题 @Build",
    `TaskReview: ${renderTriggerBlock("<continue>", "我不同意当前这条交付结论")}`,
    `CodeReview: ${renderTriggerBlock("<continue>", "我不认同已经完成的结论")}`,
    "UnitTest: 发现两个问题 @Build",
    "Build: 已经补齐了测试，并把接口改到能覆盖缺失参数这个需求。 @UnitTest @TaskReview @CodeReview",
  ];

  await assert.rejects(
    () => runSchedulerScriptDrived({ topology, script }),
    /脚本包含 \[Build\]|当前步骤模拟值为 \[Build\]|不是当前批次 .* 等待中的 decisionAgent|sender 不在当前 execute_batch 目标里|@ 目标与预期不一致|无法继续推进脚本|缺少 Build 第 2 轮回复|无法唯一推断/u,
  );
});

test("TaskReview 在 Build 未重跑前再次出现第二条 decisionAgent 回复，不应通过脚本校验", async () => {
  const topology = createTopology({
    downstream: BUILD_MULTI_DECISION_DOWNSTREAM,
  });

  const script = [
    "user: @Build 在当前项目的一个 python 文件中实现一个加法工具，调用后传入 a 和 b，返回 c",
    "Build: 加法工具已经实现。 @UnitTest @TaskReview @CodeReview",
    `CodeReview: ${renderTriggerBlock("<continue>", "我不认同已经完成的结论")}`,
    `TaskReview: ${renderTriggerBlock("<continue>", "我不认同现在可以直接交付")}`,
    `UnitTest: ${renderTriggerBlock("<complete>", "测试已经有了，整体也符合大部分标准。")}`,
    "TaskReview: 我不认同现在可以直接交付",
  ];

  await assert.rejects(
    () => runSchedulerScriptDrived({ topology, script }),
    /脚本包含 \[Build\]|当前步骤模拟值为 \[Build\]|不是当前批次 .* 等待中的 decisionAgent|sender 不在当前 execute_batch 目标里|@ 目标与预期不一致|无法继续推进脚本|缺少 Build 第 2 轮回复|无法唯一推断/u,
  );
});

test("真实日志里修完首个失败 decisionAgent 后立刻全量重派，不应通过脚本校验", async () => {
  const topology = createTopology({
    downstream: BUILD_MULTI_DECISION_DOWNSTREAM,
  });

  const script = [
    "user: @Build 请完成这个需求",
    "Build: 第 1 轮实现完成，@UnitTest @TaskReview @CodeReview",
    "UnitTest: 不通过 @Build",
    `TaskReview: ${renderTriggerBlock("<continue>", "不通过")}`,
    `CodeReview: ${renderTriggerBlock("<continue>", "不通过")}`,
    "Build: 已修复 UnitTest 第 1 轮问题 @UnitTest @TaskReview @CodeReview",
  ];

  await assert.rejects(
    () => runSchedulerScriptDrived({ topology, script }),
    /调度目标不匹配|@ 目标与预期不一致|初始\/全量派发目标必须等于 topology\.handoff 默认顺序|无法唯一推断|脚本包含 \[\]|当前步骤模拟值为 \[Build\]/u,
  );
});

test("当前日志场景若把 CodeReview 的回流写丢，脚本校验会报仍缺少 Build", async () => {
  const topology = createTopology({
    downstream: BA_BUILD_MULTI_DECISION_DOWNSTREAM,
  });

  const script = [
    "user: @BA 任务是在当前项目的一个python文件中实现一个加法工具，调用后传入a和b，返回c",
    "BA: 已基于当前项目现状梳理成可直接执行的需求说明。 @Build",
    "Build: 当前项目里已经有可用的加法工具，不需要再改代码。 @UnitTest @TaskReview @CodeReview",
    "CodeReview: 我认同这个实现，当前代码已经足够优雅且最简洁。",
    "TaskReview: 我认同当前结论：这个加法工具已经达到可交付标准。",
    "UnitTest: 我检查了实现和测试，建议补强后再定稿。 @Build",
    "Build: 已按更严格的单测规范补强测试，代码实现保持不变。 @UnitTest",
    "UnitTest: 这次补强后的测试是合格的。",
    "Build: @TaskReview @CodeReview",
    "CodeReview: 我不认同已经完成的结论",
    "TaskReview: 我认同当前交付状态，可视为已完成。 @Build",
  ];

  await assert.rejects(
    () => runSchedulerScriptDrived({ topology, script }),
    /脚本提前结束|当前还缺少 \[Build\]|Build/u,
  );
});

test("script 模板支持 group 实例短名 sender 和 @target", async () => {
  const topology = createTopology({
    extraNodes: ["Judge"],
    downstream: {
      Build: { TaskReview: "group" },
    },
    group: {
      TaskReview: "Judge",
    },
  });

  const script = [
    "user: @Build 请完成这个需求",
    "Build: 第 1 轮实现完成 @TaskReview-1",
    "TaskReview-1: 通过 @Judge",
    "Judge: 当前结果可以结束。",
  ];

  await runSchedulerScriptDrived({ topology, script });
});
