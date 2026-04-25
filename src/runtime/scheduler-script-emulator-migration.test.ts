import assert from "node:assert/strict";
import test from "node:test";

import type { TopologyRecord } from "@shared/types";

import {
  collectDecisionSnapshots,
  runSchedulerScriptDrived,
} from "./scheduler-script-emulator";
import { compileBuiltinVulnerabilityTopology } from "./builtin-topology-test-helpers";
import { createTopology } from "./topology-test-dsl";

function createEdge(
  source: string,
  target: string,
  triggerOn: TopologyRecord["edges"][number]["triggerOn"],
): TopologyRecord["edges"][number] {
  return {
    source,
    target,
    triggerOn,
    messageMode: "last",
  };
}

test("直接挂在 Build 下的后续节点会等 CodeReview 回合结束后再触发", async () => {
  const topology = createTopology({
    downstream: {
      BA: { Build: "transfer" },
      Build: {
        CodeReview: "transfer",
        UnitTest: "transfer",
        TaskReview: "transfer",
      },
      CodeReview: { Build: "continue" },
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
    "CodeReview: 已确认通过，可以进入后续判定。",
    "Build: @UnitTest @TaskReview",
    "UnitTest: UnitTest 已收到最终 Build 结果。",
    "TaskReview: TaskReview 已收到最终 Build 结果。",
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("scheduler script emulator 支持断言 execute_batch 与 finished 调度决策", async () => {
  const topology = createTopology({
    downstream: {
      BA: { Build: "transfer" },
      Build: {
        CodeReview: "transfer",
        UnitTest: "transfer",
      },
      CodeReview: { Build: "continue" },
    },
  });

  const script = [
    "user: @BA 请先完成实现。",
    "BA: 需求已澄清，交给 Build。 @Build",
    "Build: 首轮实现完成。 @CodeReview @UnitTest",
    "CodeReview: 需要修复一个问题。 @Build",
    "UnitTest: 当前结果可接受。",
    "Build: 已修复 CodeReview 提到的问题。 @CodeReview",
    "CodeReview: 通过。",
    "Build: @UnitTest",
    "UnitTest: 通过。",
  ];

  const trace = await runSchedulerScriptDrived({ topology, script });

  assert.deepEqual(collectDecisionSnapshots(trace), [
    { type: "execute_batch", sourceAgentId: null, targets: ["BA"] },
    { type: "execute_batch", sourceAgentId: "BA", targets: ["Build"] },
    {
      type: "execute_batch",
      sourceAgentId: "Build",
      targets: ["CodeReview", "UnitTest"],
    },
    { type: "finished", finishReason: "wait_pending_decision_agents" },
    { type: "execute_batch", sourceAgentId: "CodeReview", targets: ["Build"] },
    { type: "execute_batch", sourceAgentId: "Build", targets: ["CodeReview"] },
    { type: "execute_batch", sourceAgentId: "Build", targets: ["UnitTest"] },
    { type: "execute_batch", sourceAgentId: "Build", targets: ["UnitTest"] },
    { type: "finished", finishReason: "all_agents_completed" },
  ]);
});

test("脚本模式支持用户首条直接 @decisionAgent 并沿 action_required 回路继续推进", async () => {
  const topology = createTopology({
    downstream: {
      安全负责人: { 漏洞分析人员: "continue" },
      漏洞分析人员: { 安全负责人: "continue" },
    },
  });
  const script = [
    "user: @安全负责人 请先判断这个漏洞定性是否站得住。",
    "安全负责人: 证据链还不闭环，请继续补充代码与复现依据。 @漏洞分析人员",
    "漏洞分析人员: 我会继续补充请求构造、路由和复现证据。 @安全负责人",
    "安全负责人: 我已收到补充材料，请继续把缺失证据补齐。 @漏洞分析人员",
    "漏洞分析人员: 我已补齐本轮缺失证据。",
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("通用调度脚本模式支持非 Build 的实现者反复修复 decisionAgent 意见", async () => {
  const topology = createTopology({
    downstream: {
      Implementer: {
        UnitTest: "transfer",
        TaskReview: "transfer",
        CodeReview: "transfer",
      },
      UnitTest: { Implementer: "continue" },
    },
  });

  const script = [
    "user: @Implementer 请完成这个需求",
    "Implementer: 第 1 轮实现完成 @UnitTest @TaskReview @CodeReview",
    "UnitTest: 第 1 轮单测未通过 @Implementer",
    "TaskReview: 认可",
    "CodeReview: 认可",
    "Implementer: 已修复第 1 轮问题 @UnitTest",
    "UnitTest: 第 2 轮单测未通过 @Implementer",
    "Implementer: 已修复第 2 轮问题 @UnitTest",
    "UnitTest: 认可",
    "Implementer: @TaskReview @CodeReview",
    "TaskReview: 认可",
    "CodeReview: 认可",
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("脚本模式要求 topology 显式给出边，脚本里的派发不能脱离 topology 单独存在", async () => {
  const topology = createTopology({
    nodes: ["Implementer", "UnitTest", "TaskReview", "CodeReview"],
    downstream: {
      Implementer: { UnitTest: "transfer" },
      UnitTest: { Implementer: "continue" },
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
      BA: { Implementer: "transfer" },
      Implementer: { CodeReview: "transfer" },
      CodeReview: {
        Implementer: "continue",
        TaskReview: "complete",
        UnitTest: "complete",
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

test("脚本首条 user 显式 @ 的 Agent 只要存在于 topology.nodes 就允许作为起点", async () => {
  const topology = createTopology({
    nodes: ["BA"],
    downstream: {
      Implementer: { TaskReview: "transfer" },
    },
  });

  const script = [
    "user: @Implementer 请直接开始实现",
    "Implementer: 已完成实现 @TaskReview",
    "TaskReview: 认可",
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("当前调度不支持在 action_required 对弈中由发起方直接跳到裁决", async () => {
  const topology = createTopology({
    downstream: {
      Discovery: { Challenger: "transfer" },
      Analyst: { Challenger: "continue", Judge: "complete" },
      Challenger: { Analyst: "continue", Judge: "complete" },
      Judge: { Discovery: "complete" },
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
      Build: { UnitTest: "transfer" },
      UnitTest: {
        Build: "continue",
        Judge: "complete",
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
  const topology = compileBuiltinVulnerabilityTopology().topology;

  const script = [
    "user: @线索发现 请持续挖掘当前代码中的可疑漏洞点。",
    "线索发现: 发现第 1 个可疑点：上传文件名可能被直接拼进目标路径。 @漏洞挑战-1",
    "漏洞挑战-1: 第 1 轮质疑：缺少从入口到落盘的完整调用链。 @漏洞论证-1",
    "漏洞论证-1: 第 1 轮补证：已补齐入口、过滤逻辑与落盘点。 @漏洞挑战-1",
    "漏洞挑战-1: 第 2 轮质疑：还缺少默认虚拟主机映射证据。 @漏洞论证-1",
    "漏洞论证-1: 第 2 轮补证：已补齐 mapper 与 default host 路径。 @漏洞挑战-1",
    "漏洞挑战-1: 第 3 轮质疑：还缺少协议层拒绝点对照。 @漏洞论证-1",
    "漏洞论证-1: 第 3 轮补证：已补齐 h2 与 h2c 的差异证据。 @漏洞挑战-1",
    "漏洞挑战-1: 第 4 轮质疑：还缺少最终利用面说明。 @漏洞论证-1",
    "漏洞论证-1: 第 4 轮补证：已补齐默认主机承接与安全影响。 @讨论总结-1",
    "讨论总结-1: 该点是否成立已可直接判断，回到线索发现继续下一处。 @线索发现",
    "线索发现: 当前项目里没有新的可疑点，结束本轮流程。",
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("漏洞挖掘团队脚本里讨论总结完成后会回到线索发现继续挖掘", async () => {
  const topology = compileBuiltinVulnerabilityTopology().topology;
  const script = [
    "user: @线索发现 请持续挖掘当前代码中的可疑漏洞点。",
    "线索发现: 发现第 1 个可疑点：上传文件名可能被直接拼进目标路径。 @漏洞挑战-1",
    "漏洞挑战-1: 当前材料还缺少从入口到落盘点的完整调用链。 @漏洞论证-1",
    "漏洞论证-1: 第一轮补证：上传入口会把原始文件名透传到保存逻辑。 @漏洞挑战-1",
    "漏洞挑战-1: 第二轮质疑：还缺少目标路径是否真正受控的证据。 @漏洞论证-1",
    "漏洞论证-1: 第二轮补证：存储层直接执行 path.join(uploadRoot, filename)，未见对 .. 或分隔符的拦截。 @讨论总结-1",
    "讨论总结-1: 当前这条更像真实漏洞。 @线索发现",
    "线索发现: 发现第 2 个可疑点：内部调试接口似乎缺少鉴权。 @漏洞挑战-2",
    "漏洞挑战-2: 当前材料更像误报，缺少生产环境可达性证据。 @漏洞论证-2",
    "漏洞论证-2: 第一轮补证：调试路由默认注册，且局部未见鉴权中间件。 @漏洞挑战-2",
    "漏洞挑战-2: 第二轮质疑：仍然缺少环境开关实际放行的证据。 @漏洞论证-2",
    "漏洞论证-2: 第二轮补证后，当前仍无法证明生产环境可利用，只能进入总结。 @讨论总结-2",
    "讨论总结-2: 当前这条更像误报。 @线索发现",
    "线索发现: 当前项目里没有新的可疑点，结束本轮流程。",
  ];
  await runSchedulerScriptDrived({ topology, script });
});

test("漏洞挖掘团队脚本不再接受非法短别名", async () => {
  const topology = compileBuiltinVulnerabilityTopology().topology;

  const script = [
    "user: @线索发现 请持续挖掘当前代码中的可疑漏洞点。",
    "线索发现: 发现第 1 个可疑点：上传文件名可能被直接拼进目标路径。 @漏洞挑战-alias1",
    "漏洞挑战-alias1: 目前证据仍有缺口，需要继续补齐。 @漏洞论证-alias1",
    "漏洞论证-alias1: 我已补齐入口、过滤逻辑与落盘点，当前证据链已经闭环，可以进入裁决。 @讨论总结-alias1",
    "讨论总结-alias1: 该点成立为漏洞，输出正式漏洞报告。 @线索发现",
    "线索发现: 发现第 2 个可疑点：内部调试接口似乎缺少鉴权。 @漏洞挑战-alias2",
    "漏洞挑战-alias2: 当前材料更像误报，可以进入裁决。 @讨论总结-alias2",
    "讨论总结-alias2: 该点暂不成立。 @线索发现",
  ];

  await assert.rejects(
    () => runSchedulerScriptDrived({ topology, script }),
    /不存在的 Agent|漏洞挑战-alias1|漏洞论证-alias1/u,
  );
});

test("CodeReview 即使存在 approved 下游，也会先拦住 Build 的其他 handoff 下游", async () => {
  const topology = createTopology({
    downstream: {
      BA: { Build: "transfer" },
      Build: {
        CodeReview: "transfer",
        UnitTest: "transfer",
      },
      CodeReview: {
        Build: "continue",
        TaskReview: "complete",
      },
    },
  });

  const script = [
    "user: @BA 请先实现，然后只在 CodeReview 通过后再跑 UnitTest。",
    "BA: 需求明确，交给 Build 实现。 @Build",
    "Build: Build 已完成实现，等待 CodeReview 结论。 @CodeReview @UnitTest",
    "CodeReview: CodeReview 通过，可以继续后续流程。 @TaskReview",
    "TaskReview: TaskReview 已收到最新结果。",
    "UnitTest: UnitTest 已收到最新结果。",
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("super-step 模式下 decisionAgent 不再拦住同轮其他 handoff 下游", async () => {
  const topology = createTopology({
    downstream: {
      BA: { Build: "transfer" },
      Build: {
        CodeReview: "transfer",
        UnitTest: "transfer",
      },
      CodeReview: {
        Build: "continue",
        TaskReview: "complete",
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

test("BA dispatches Build through three decision passes before the task can finish", async () => {
  const topology = createTopology({
    nodes: ["BA", "Build", "UnitTest", "CodeReview", "TaskReview"],
    edges: [
      createEdge("BA", "Build", "transfer"),
      createEdge("Build", "UnitTest", "transfer"),
      createEdge("UnitTest", "Build", "continue"),
      createEdge("UnitTest", "CodeReview", "complete"),
      createEdge("CodeReview", "Build", "continue"),
      createEdge("CodeReview", "TaskReview", "complete"),
      createEdge("TaskReview", "Build", "continue"),
    ],
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
    "TaskReview: 任务交付通过，当前结果可以结束。",
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("长链路脚本会覆盖 UnitTest、TaskReview、CodeReview 多轮往返后的最终双确认", async () => {
  const topology = createTopology({
    nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
    edges: [
      createEdge("Build", "UnitTest", "transfer"),
      createEdge("Build", "TaskReview", "transfer"),
      createEdge("Build", "CodeReview", "transfer"),
      createEdge("UnitTest", "Build", "continue"),
      createEdge("TaskReview", "Build", "continue"),
      createEdge("CodeReview", "Build", "continue"),
    ],
  });

  const script = [
    "user: @Build 请完成这个需求",
    "Build: Build 第 1 轮实现完成，@UnitTest @TaskReview @CodeReview",
    "UnitTest: UnitTest 第 1 轮未通过 @Build",
    "TaskReview: ok",
    "CodeReview: ok",
    "Build: 已修复 UnitTest 第 1 轮问题 @UnitTest",
    "UnitTest: UnitTest 第 2 轮未通过 @Build",
    "Build: 已修复 UnitTest 第 2 轮问题 @UnitTest",
    "UnitTest: UnitTest 第 3 轮未通过 @Build",
    "Build: 已修复 UnitTest 第 3 轮问题 @UnitTest",
    "UnitTest: UnitTest 第 4 轮未通过 @Build",
    "Build: 已修复 UnitTest 第 4 轮问题 @UnitTest",
    "UnitTest: UnitTest 第 5 轮通过，可以进入后续判定。",
    "Build: @TaskReview @CodeReview",
    "TaskReview: TaskReview 第 1 轮未通过 @Build",
    "CodeReview: ok",
    "Build: 已修复 TaskReview 第 1 轮问题 @TaskReview",
    "TaskReview: TaskReview 第 2 轮未通过 @Build",
    "Build: 已修复 TaskReview 第 2 轮问题 @TaskReview",
    "TaskReview: 认可 Build 结果。",
    "Build: @UnitTest @CodeReview",
    "CodeReview: ok",
    "UnitTest: UnitTest 第 6 轮未通过 @Build",
    "Build: 已修复 UnitTest 第 6 轮问题 @UnitTest",
    "UnitTest: ok",
    "Build: @TaskReview @CodeReview",
    "TaskReview: 认可 Build 结果。",
    "CodeReview: 不认可 @Build",
    "Build: 已修复 CodeReview 意见 @CodeReview",
    "CodeReview: 认可",
    "Build: @UnitTest @TaskReview",
    "UnitTest: 同意",
    "TaskReview: 同意",
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("长链路脚本里同一 decisionAgent 连续 4 轮回流后改为通过，仍然是合法流程", async () => {
  const topology = createTopology({
    nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
    edges: [
      createEdge("Build", "UnitTest", "transfer"),
      createEdge("Build", "TaskReview", "transfer"),
      createEdge("Build", "CodeReview", "transfer"),
      createEdge("UnitTest", "Build", "continue"),
      createEdge("TaskReview", "Build", "continue"),
      createEdge("CodeReview", "Build", "continue"),
    ],
  });

  const script = [
    "user: @Build 请完成这个需求",
    "Build: Build 第 1 轮实现完成，@UnitTest @TaskReview @CodeReview",
    "UnitTest: UnitTest 第 1 轮未通过 @Build",
    "TaskReview: ok",
    "CodeReview: ok",
    "Build: 已修复 UnitTest 第 1 轮问题 @UnitTest",
    "UnitTest: UnitTest 第 2 轮未通过 @Build",
    "Build: 已修复 UnitTest 第 2 轮问题 @UnitTest",
    "UnitTest: UnitTest 第 3 轮未通过 @Build",
    "Build: 已修复 UnitTest 第 3 轮问题 @UnitTest",
    "UnitTest: UnitTest 第 4 轮未通过 @Build",
    "Build: 已修复 UnitTest 第 4 轮问题 @UnitTest",
    "UnitTest: UnitTest 第 5 轮通过，可以结束。",
    "Build: @TaskReview @CodeReview",
    "TaskReview: ok",
    "CodeReview: ok",
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("长链路脚本里同一 decisionAgent 连续第 5 次回流时会被判定为非法循环", async () => {
  const topology = createTopology({
    nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
    edges: [
      createEdge("Build", "UnitTest", "transfer"),
      createEdge("Build", "TaskReview", "transfer"),
      createEdge("Build", "CodeReview", "transfer"),
      createEdge("UnitTest", "Build", "continue"),
      createEdge("TaskReview", "Build", "continue"),
      createEdge("CodeReview", "Build", "continue"),
    ],
  });

  const script = [
    "user: @Build 请完成这个需求",
    "Build: Build 第 1 轮实现完成，@UnitTest @TaskReview @CodeReview",
    "UnitTest: UnitTest 第 1 轮未通过",
    "TaskReview: ok",
    "CodeReview: ok @Build",
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
    /调度目标不匹配|无法唯一推断|已连续交流 4 次/u,
  );
});

test("脚本模式会读取 action_required 边上的 maxRevisionRounds 覆盖值", async () => {
  const topology = createTopology({
    nodes: ["Build", "UnitTest"],
    edges: [
      createEdge("Build", "UnitTest", "transfer"),
      {
        ...createEdge("UnitTest", "Build", "continue"),
        maxRevisionRounds: 2,
      },
    ],
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
    /无法唯一推断|已连续交流 2 次/u,
  );
});

test("修完中间 decisionAgent 后，会先继续后续未完成 decisionAgent，再补前面的 stale decisionAgent", async () => {
  const topology = createTopology({
    nodes: ["BA", "Build", "UnitTest", "TaskReview", "CodeReview"],
    edges: [
      createEdge("BA", "Build", "transfer"),
      createEdge("Build", "UnitTest", "transfer"),
      createEdge("Build", "TaskReview", "transfer"),
      createEdge("Build", "CodeReview", "transfer"),
      createEdge("UnitTest", "Build", "continue"),
      createEdge("TaskReview", "Build", "continue"),
      createEdge("CodeReview", "Build", "continue"),
    ],
  });

  const script = [
    "user: @BA 在当前项目的一个临时文件中实现一个加法工具，调用后传入a和b，返回c",
    "BA: 已整理需求，交给 Build。 @Build",
    "Build: 已实现第 1 轮，@UnitTest @TaskReview @CodeReview",
    "UnitTest: 不通过 @Build",
    "TaskReview: 不通过",
    "CodeReview: 不通过",
    "Build: 已修复 UnitTest 第 1 轮问题 @UnitTest",
    "UnitTest: 通过",
    "Build: @TaskReview @CodeReview",
    "TaskReview: 不通过 @Build",
    "CodeReview: 不通过",
    "Build: 已修复 TaskReview 第 1 轮问题 @TaskReview",
    "TaskReview: 通过",
    "Build: @UnitTest @CodeReview",
    "CodeReview: 通过",
    "UnitTest: 通过",
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("同一批 decisionAgent 可以按任意顺序回复，只要整批收齐后再进入下一轮", async () => {
  const topology = createTopology({
    nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
    edges: [
      createEdge("Build", "UnitTest", "transfer"),
      createEdge("Build", "TaskReview", "transfer"),
      createEdge("Build", "CodeReview", "transfer"),
      createEdge("UnitTest", "Build", "continue"),
      createEdge("TaskReview", "Build", "continue"),
      createEdge("CodeReview", "Build", "continue"),
    ],
  });

  const script = [
    "user: @Build 请完成这个需求",
    "Build: 第 1 轮实现完成，@UnitTest @TaskReview @CodeReview",
    "CodeReview: 通过",
    "UnitTest: 不通过 @Build",
    "TaskReview: 通过",
    "Build: 已修复 UnitTest 第 1 轮问题 @UnitTest",
    "UnitTest: 通过",
    "Build: @TaskReview @CodeReview",
    "CodeReview: 通过",
    "TaskReview: 通过",
  ];

  await runSchedulerScriptDrived({ topology, script });
});

test("真实日志里重复 decisionAgent 回复并在整批失败后再次全量派发，不应通过脚本校验", async () => {
  const topology = createTopology({
    nodes: ["BA", "Build", "UnitTest", "TaskReview", "CodeReview"],
    edges: [
      createEdge("BA", "Build", "transfer"),
      createEdge("Build", "UnitTest", "transfer"),
      createEdge("Build", "TaskReview", "transfer"),
      createEdge("Build", "CodeReview", "transfer"),
      createEdge("UnitTest", "Build", "continue"),
      createEdge("TaskReview", "Build", "continue"),
      createEdge("CodeReview", "Build", "continue"),
    ],
  });

  const script = [
    "user: @BA 在当前项目的一个临时文件中实现一个加法工具，调用后传入a和b，返回c",
    "BA: 可以把这个需求整理成可直接执行的版本。 @Build",
    "Build: 已经在当前项目里新增了临时文件 temp_add.py，@UnitTest @TaskReview @CodeReview",
    "UnitTest: 发现两个问题",
    "TaskReview: 我不同意当前这条交付结论",
    "CodeReview: 我不认同已经完成的结论 @Build",
    "UnitTest: 发现两个问题",
    "Build: 已经补齐了测试，并把接口改到能覆盖缺失参数这个需求。 @UnitTest @TaskReview @CodeReview",
  ];

  await assert.rejects(
    () => runSchedulerScriptDrived({ topology, script }),
    /脚本包含 \[Build\]|当前步骤模拟值为 \[Build\]|不是当前批次 .* 等待中的 decisionAgent|sender 不在当前 execute_batch 目标里|@ 目标与预期不一致|无法继续推进脚本|缺少 Build 第 2 轮回复|无法唯一推断/u,
  );
});

test("TaskReview 在 Build 未重跑前再次出现第二条 decisionAgent 回复，不应通过脚本校验", async () => {
  const topology = createTopology({
    nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
    edges: [
      createEdge("Build", "UnitTest", "transfer"),
      createEdge("Build", "TaskReview", "transfer"),
      createEdge("Build", "CodeReview", "transfer"),
      createEdge("UnitTest", "Build", "continue"),
      createEdge("TaskReview", "Build", "continue"),
      createEdge("CodeReview", "Build", "continue"),
    ],
  });

  const script = [
    "user: @Build 在当前项目的一个 python 文件中实现一个加法工具，调用后传入 a 和 b，返回 c",
    "Build: 加法工具已经实现。 @UnitTest @TaskReview @CodeReview",
    "CodeReview: 我不认同已经完成的结论",
    "TaskReview: 我不认同现在可以直接交付",
    "UnitTest: 测试已经有了，整体也符合大部分标准。",
    "TaskReview: 我不认同现在可以直接交付",
  ];

  await assert.rejects(
    () => runSchedulerScriptDrived({ topology, script }),
    /脚本包含 \[Build\]|当前步骤模拟值为 \[Build\]|不是当前批次 .* 等待中的 decisionAgent|sender 不在当前 execute_batch 目标里|@ 目标与预期不一致|无法继续推进脚本|缺少 Build 第 2 轮回复|无法唯一推断/u,
  );
});

test("真实日志里修完首个失败 decisionAgent 后立刻全量重派，不应通过脚本校验", async () => {
  const topology = createTopology({
    nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
    edges: [
      createEdge("Build", "UnitTest", "transfer"),
      createEdge("Build", "TaskReview", "transfer"),
      createEdge("Build", "CodeReview", "transfer"),
      createEdge("UnitTest", "Build", "continue"),
      createEdge("TaskReview", "Build", "continue"),
      createEdge("CodeReview", "Build", "continue"),
    ],
  });

  const script = [
    "user: @Build 请完成这个需求",
    "Build: 第 1 轮实现完成，@UnitTest @TaskReview @CodeReview",
    "UnitTest: 不通过",
    "TaskReview: 不通过",
    "CodeReview: 不通过 @Build",
    "Build: 已修复 UnitTest 第 1 轮问题 @UnitTest @TaskReview @CodeReview",
  ];

  await assert.rejects(
    () => runSchedulerScriptDrived({ topology, script }),
    /调度目标不匹配|@ 目标与预期不一致|初始\/全量派发目标必须等于 topology\.handoff 默认顺序|无法唯一推断/u,
  );
});

test("当前日志场景若把 CodeReview 的回流写丢，脚本校验会报仍缺少 Build", async () => {
  const topology = createTopology({
    nodes: ["BA", "Build", "UnitTest", "TaskReview", "CodeReview"],
    edges: [
      createEdge("BA", "Build", "transfer"),
      createEdge("Build", "UnitTest", "transfer"),
      createEdge("Build", "TaskReview", "transfer"),
      createEdge("Build", "CodeReview", "transfer"),
      createEdge("UnitTest", "Build", "continue"),
      createEdge("TaskReview", "Build", "continue"),
      createEdge("CodeReview", "Build", "continue"),
    ],
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

test("script 模板支持 spawn 实例短名 sender 和 @target", async () => {
  const topology = createTopology({
    nodes: ["Build", "Judge"],
    downstream: {
      Build: { TaskReview: "spawn" },
    },
    spawn: {
      TaskReview: {
        reportTo: "Judge",
      },
    },
  });

  const script = [
    "user: @Build 请完成这个需求",
    "Build: 第 1 轮实现完成，@TaskReview-1",
    "TaskReview-1: 通过 @Judge",
    "Judge: 当前结果可以结束。",
  ];

  await runSchedulerScriptDrived({ topology, script });
});
