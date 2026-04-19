import assert from "node:assert/strict";
import test from "node:test";

import type { TopologyRecord } from "@shared/types";

import { assertSchedulerScript } from "./scheduler-script-harness";
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
  };
}

test("直接挂在 Build 下的后续节点会等 CodeReview 回合结束后再触发", async () => {
  const topology = createTopology({
    projectId: "migrated-script-1021",
    downstream: {
      BA: { Build: "association" },
      Build: {
        CodeReview: "association",
        UnitTest: "association",
        TaskReview: "association",
      },
      CodeReview: { Build: "review_fail" },
    },
  });

  const script = [
    "user: @BA 请先完成实现，再经过 CodeReview，多轮修复结束后再进入其他审查。",
    "BA: 需求已澄清，交给 Build 继续实现。 @Build",
    "Build: Build 首轮实现完成，交给 CodeReview 审查。 @CodeReview @UnitTest @TaskReview",
    "CodeReview: CodeReview 首轮未通过。 @Build",
    "UnitTest: UnitTest 已收到首轮 Build 结果。",
    "TaskReview: TaskReview 已收到首轮 Build 结果。",
    "Build: Build 已根据 CodeReview 意见修复完成。 @CodeReview",
    "CodeReview: 已确认通过，可以进入后续审查。",
    "Build: @UnitTest @TaskReview",
    "UnitTest: UnitTest 已收到最终 Build 结果。",
    "TaskReview: TaskReview 已收到最终 Build 结果。",
  ];

  await assertSchedulerScript({ topology, script });
});

test("脚本模式支持用户首条直接 @reviewer 并沿 review_fail 回路继续推进", async () => {
  const topology = createTopology({
    projectId: "direct-review-loop-entry",
    downstream: {
      安全负责人: { 漏洞分析人员: "review_fail" },
      漏洞分析人员: { 安全负责人: "review_fail" },
    },
  });
  const script = [
    "user: @安全负责人 请先判断这个漏洞定性是否站得住。",
    "安全负责人: 证据链还不闭环，请继续补充代码与复现依据。 @漏洞分析人员",
    "漏洞分析人员: 我会继续补充请求构造、路由和复现证据。 @安全负责人",
    "安全负责人: 我已收到补充材料，请继续把缺失证据补齐。 @漏洞分析人员",
    "漏洞分析人员: 我已补齐本轮缺失证据。",
  ];

  await assertSchedulerScript({ topology, script });
});

test("通用调度脚本模式支持非 Build 的实现者反复修复 reviewer 意见", async () => {
  const topology = createTopology({
    projectId: "generic-script-1",
    downstream: {
      Implementer: {
        UnitTest: "association",
        TaskReview: "association",
        CodeReview: "association",
      },
      UnitTest: { Implementer: "review_fail" },
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

  await assertSchedulerScript({ topology, script });
});

test("脚本模式要求 topology 显式给出边，脚本里的派发不能脱离 topology 单独存在", async () => {
  const topology = createTopology({
    projectId: "generic-script-invalid",
    nodes: ["Implementer", "UnitTest", "TaskReview", "CodeReview"],
    downstream: {
      Implementer: { UnitTest: "association" },
      UnitTest: { Implementer: "review_fail" },
    },
  });

  const script = [
    "user: @Implementer 请完成这个需求",
    "Implementer: 第 1 轮实现完成 @UnitTest @TaskReview @CodeReview",
  ];

  await assert.rejects(
    () => assertSchedulerScript({ topology, script }),
    /默认顺序|没有对应的拓扑边/,
  );
});

test("通用调度脚本模式支持 reviewer 通过后显式触发 review_pass 下游", async () => {
  const topology = createTopology({
    projectId: "generic-script-2",
    downstream: {
      BA: { Implementer: "association" },
      Implementer: { CodeReview: "association" },
      CodeReview: {
        Implementer: "review_fail",
        TaskReview: "review_pass",
        UnitTest: "review_pass",
      },
    },
  });

  const script = [
    "user: @BA 请先澄清需求再推进实现",
    "BA: 需求已经澄清 @Implementer",
    "Implementer: 首轮实现完成 @CodeReview",
    "CodeReview: 还需要修复 @Implementer",
    "Implementer: 已根据意见修复 @CodeReview",
    "CodeReview: 通过并进入后续审查 @TaskReview @UnitTest",
    "TaskReview: 认可",
    "UnitTest: 认可",
  ];

  await assertSchedulerScript({ topology, script });
});

test("脚本首条 user 显式 @ 的 Agent 只要存在于 topology.nodes 就允许作为起点", async () => {
  const topology = createTopology({
    projectId: "generic-script-explicit-user-start",
    nodes: ["BA"],
    downstream: {
      Implementer: { TaskReview: "association" },
    },
  });

  const script = [
    "user: @Implementer 请直接开始实现",
    "Implementer: 已完成实现 @TaskReview",
    "TaskReview: 认可",
  ];

  await assertSchedulerScript({ topology, script });
});

test("当前调度不支持在 review_fail 对弈中由发起方直接跳到裁决", async () => {
  const topology = createTopology({
    projectId: "security-hunting-loop-invalid-exit",
    downstream: {
      初筛: { 正方: "association" },
      正方: { 反方: "review_fail", 裁决: "review_pass" },
      反方: { 正方: "review_fail", 裁决: "review_pass" },
      裁决: { 初筛: "review_pass" },
    },
  });

  const script = [
    "user: @初筛 请持续挖掘当前代码中的可疑漏洞点。",
    "初筛: 发现第 1 个可疑点：上传文件名可能被直接拼进目标路径。 @正方",
    "正方: 这更像真实漏洞，但还需要反方挑战证据链。 @反方",
    "反方: 目前证据不够，缺少从入口到落盘路径的完整调用链。 @正方",
    "正方: 已补齐入口、过滤逻辑与落盘点，提交裁决。 @裁决",
  ];

  await assert.rejects(
    () => assertSchedulerScript({ topology, script }),
    /正方 的 @ 目标与预期不一致/u,
  );
});

test("漏洞挖掘团队可以通过 review_fail 对弈并在裁决后回到初筛继续下一轮", async () => {
  const topology = createTopology({
    projectId: "security-hunting-loop-supported",
    downstream: {
      初筛: { 正方: "association" },
      正方: { 反方: "review_fail", 裁决: "review_pass" },
      反方: { 正方: "review_fail", 裁决: "review_pass" },
      裁决: { 初筛: "review_pass" },
    },
  });

  const script = [
    "user: @初筛 请持续挖掘当前代码中的可疑漏洞点。",
    "初筛: 发现第 1 个可疑点：上传文件名可能被直接拼进目标路径。 @正方",
    "正方: 这更像真实漏洞，但还需要反方挑战证据链。 @反方",
    "反方: 目前证据不够，缺少从入口到落盘路径的完整调用链。 @正方",
    "正方: 我已补齐入口、过滤逻辑与落盘点，请反方重新判断。 @反方",
    "反方: 证据链闭环了，交给裁决。 @裁决",
    "裁决: 该点成立为漏洞，回到初筛继续寻找下一个可疑点。 @初筛",
    "初筛: 发现第 2 个可疑点：内部调试接口似乎缺少鉴权。 @正方",
    "正方: 这次证据不足，更像误报，交给裁决。 @裁决",
    "裁决: 该点暂不成立，继续回到初筛寻找下一处。 @初筛",
  ];

  await assertSchedulerScript({ topology, script });
});

test("CodeReview 即使存在 review_pass 下游，也会先拦住 Build 的其他 association 下游", async () => {
  const topology = createTopology({
    projectId: "migrated-script-1176",
    downstream: {
      BA: { Build: "association" },
      Build: {
        CodeReview: "association",
        UnitTest: "association",
      },
      CodeReview: {
        Build: "review_fail",
        TaskReview: "review_pass",
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

  await assertSchedulerScript({ topology, script });
});

test("super-step 模式下 reviewer 不再拦住同轮其他 association 下游", async () => {
  const topology = createTopology({
    projectId: "langgraph-superstep-association-fanout",
    downstream: {
      BA: { Build: "association" },
      Build: {
        CodeReview: "association",
        UnitTest: "association",
      },
      CodeReview: {
        Build: "review_fail",
        TaskReview: "review_pass",
      },
    },
  });

  const script = [
    "user: @BA 请先实现，然后让 CodeReview 和 UnitTest 在同一轮一起执行。",
    "BA: 需求明确，交给 Build 实现。 @Build",
    "Build: Build 已完成实现，开始同轮审查。 @CodeReview @UnitTest",
    "UnitTest: UnitTest 已完成本轮校验。",
    "CodeReview: CodeReview 通过，可以继续后续流程。 @TaskReview",
    "TaskReview: TaskReview 已收到最新结果。",
  ];

  await assertSchedulerScript({ topology, script });
});

test("BA dispatches Build through three review passes before the task can finish", async () => {
  const topology = createTopology({
    projectId: "migrated-script-2388",
    nodes: ["BA", "Build", "UnitTest", "CodeReview", "TaskReview"],
    edges: [
      createEdge("BA", "Build", "association"),
      createEdge("Build", "UnitTest", "association"),
      createEdge("UnitTest", "Build", "review_fail"),
      createEdge("UnitTest", "CodeReview", "review_pass"),
      createEdge("CodeReview", "Build", "review_fail"),
      createEdge("CodeReview", "TaskReview", "review_pass"),
      createEdge("TaskReview", "Build", "review_fail"),
    ],
  });

  const script = [
    "user: @BA 请实现 add 方法，并把结果写入 add.js。",
    "BA: 已整理实现要求，交给 Build。 @Build",
    "Build: 第 1 次构建完成。 @UnitTest",
    "UnitTest: 单元测试未通过，继续修复。 @Build",
    "Build: 第 2 次构建完成。 @UnitTest",
    "UnitTest: 单元测试通过，进入下一段审查。 @CodeReview",
    "CodeReview: 代码审查未通过，继续完善实现。 @Build",
    "Build: 第 3 次构建完成。 @UnitTest",
    "UnitTest: 单元测试通过，进入下一段审查。 @CodeReview",
    "CodeReview: 代码审查通过，进入最终交付审查。 @TaskReview",
    "TaskReview: 最终交付未通过，需要再补一轮稳定交付。 @Build",
    "Build: 第 4 次构建完成。 @UnitTest",
    "UnitTest: 单元测试通过，进入下一段审查。 @CodeReview",
    "CodeReview: 代码审查通过，进入最终交付审查。 @TaskReview",
    "TaskReview: 任务交付通过，当前结果可以结束。",
  ];

  await assertSchedulerScript({ topology, script });
});

test("长链路脚本会覆盖 UnitTest、TaskReview、CodeReview 多轮往返后的最终双确认", async () => {
  const topology = createTopology({
    projectId: "generic-script-long-cycle",
    nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
    edges: [
      createEdge("Build", "UnitTest", "association"),
      createEdge("Build", "TaskReview", "association"),
      createEdge("Build", "CodeReview", "association"),
      createEdge("UnitTest", "Build", "review_fail"),
      createEdge("TaskReview", "Build", "review_fail"),
      createEdge("CodeReview", "Build", "review_fail"),
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
    "UnitTest: UnitTest 第 5 轮通过，可以进入后续审查。",
    "Build: @TaskReview @CodeReview",
    "TaskReview: TaskReview 第 1 轮未通过 @Build",
    "CodeReview: ok",
    "Build: 已修复 TaskReview 第 1 轮问题 @TaskReview",
    "TaskReview: TaskReview 第 2 轮未通过 @Build",
    "Build: 已修复 TaskReview 第 2 轮问题 @TaskReview",
    "TaskReview: 认可 Build 结果。",
    "Build: @CodeReview @UnitTest",
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

  await assertSchedulerScript({ topology, script });
});

test("长链路脚本里同一 reviewer 连续 4 轮回流后改为通过，仍然是合法流程", async () => {
  const topology = createTopology({
    projectId: "generic-script-loop-limit-pass-boundary",
    nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
    edges: [
      createEdge("Build", "UnitTest", "association"),
      createEdge("Build", "TaskReview", "association"),
      createEdge("Build", "CodeReview", "association"),
      createEdge("UnitTest", "Build", "review_fail"),
      createEdge("TaskReview", "Build", "review_fail"),
      createEdge("CodeReview", "Build", "review_fail"),
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
  ];

  await assertSchedulerScript({ topology, script });
});

test("长链路脚本里同一 reviewer 连续第 5 次回流时会被判定为非法循环", async () => {
  const topology = createTopology({
    projectId: "generic-script-long-cycle-invalid-loop",
    nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
    edges: [
      createEdge("Build", "UnitTest", "association"),
      createEdge("Build", "TaskReview", "association"),
      createEdge("Build", "CodeReview", "association"),
      createEdge("UnitTest", "Build", "review_fail"),
      createEdge("TaskReview", "Build", "review_fail"),
      createEdge("CodeReview", "Build", "review_fail"),
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
    "UnitTest: UnitTest 第 5 轮未通过 @Build",
  ];

  await assert.rejects(
    assertSchedulerScript({ topology, script }),
    /UnitTest -> Build 连续回流已超过 4 轮上限/u,
  );
});

test("修完中间 reviewer 后，会先继续后续未完成 reviewer，再补前面的 stale reviewer", async () => {
  const topology = createTopology({
    projectId: "generic-script-user-expected-order",
    nodes: ["BA", "Build", "UnitTest", "TaskReview", "CodeReview"],
    edges: [
      createEdge("BA", "Build", "association"),
      createEdge("Build", "UnitTest", "association"),
      createEdge("Build", "TaskReview", "association"),
      createEdge("Build", "CodeReview", "association"),
      createEdge("UnitTest", "Build", "review_fail"),
      createEdge("TaskReview", "Build", "review_fail"),
      createEdge("CodeReview", "Build", "review_fail"),
    ],
  });

  const script = [
    "user: @BA 在当前项目的一个临时文件中实现一个加法工具，调用后传入a和b，返回c",
    "BA: 已整理需求，交给 Build。 @Build",
    "Build: 已实现第 1 轮，@UnitTest @TaskReview @CodeReview",
    "UnitTest: 不通过 @Build",
    "TaskReview: 不通过 @Build",
    "CodeReview: 不通过 @Build",
    "Build: 已修复 UnitTest 第 1 轮问题 @UnitTest",
    "UnitTest: 通过",
    "Build: @TaskReview @CodeReview",
    "TaskReview: 不通过 @Build",
    "CodeReview: 不通过 @Build",
    "Build: 已修复 TaskReview 第 1 轮问题 @TaskReview",
    "TaskReview: 通过",
    "Build: @CodeReview @UnitTest",
    "CodeReview: 通过",
    "UnitTest: 通过",
  ];

  await assertSchedulerScript({ topology, script });
});

test("同一批 reviewer 可以按任意顺序回复，只要整批收齐后再进入下一轮", async () => {
  const topology = createTopology({
    projectId: "generic-script-concurrent-reviewers",
    nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
    edges: [
      createEdge("Build", "UnitTest", "association"),
      createEdge("Build", "TaskReview", "association"),
      createEdge("Build", "CodeReview", "association"),
      createEdge("UnitTest", "Build", "review_fail"),
      createEdge("TaskReview", "Build", "review_fail"),
      createEdge("CodeReview", "Build", "review_fail"),
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

  await assertSchedulerScript({ topology, script });
});

test("真实日志里重复 reviewer 回复并在整批失败后再次全量派发，不应通过脚本校验", async () => {
  const topology = createTopology({
    projectId: "generic-script-invalid-real-log",
    nodes: ["BA", "Build", "UnitTest", "TaskReview", "CodeReview"],
    edges: [
      createEdge("BA", "Build", "association"),
      createEdge("Build", "UnitTest", "association"),
      createEdge("Build", "TaskReview", "association"),
      createEdge("Build", "CodeReview", "association"),
      createEdge("UnitTest", "Build", "review_fail"),
      createEdge("TaskReview", "Build", "review_fail"),
      createEdge("CodeReview", "Build", "review_fail"),
    ],
  });

  const script = [
    "user: @BA 在当前项目的一个临时文件中实现一个加法工具，调用后传入a和b，返回c",
    "BA: 可以把这个需求整理成可直接执行的版本。 @Build",
    "Build: 已经在当前项目里新增了临时文件 temp_add.py，@UnitTest @TaskReview @CodeReview",
    "UnitTest: 发现两个问题 @Build",
    "TaskReview: 我不同意当前这条交付结论 @Build",
    "CodeReview: 我不认同已经完成的结论 @Build",
    "UnitTest: 发现两个问题 @Build",
    "Build: 已经补齐了测试，并把接口改到能覆盖缺失参数这个需求。 @UnitTest @TaskReview @CodeReview",
  ];

  await assert.rejects(
    () => assertSchedulerScript({ topology, script }),
    /不是当前批次 .* 等待中的 reviewer|@ 目标与预期不一致|无法继续推进脚本|缺少 Build 第 2 轮回复/u,
  );
});

test("TaskReview 在 Build 未重跑前再次出现第二条 reviewer 回复，不应通过脚本校验", async () => {
  const topology = createTopology({
    projectId: "generic-script-invalid-task-review-duplicate-before-build-rerun",
    nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
    edges: [
      createEdge("Build", "UnitTest", "association"),
      createEdge("Build", "TaskReview", "association"),
      createEdge("Build", "CodeReview", "association"),
      createEdge("UnitTest", "Build", "review_fail"),
      createEdge("TaskReview", "Build", "review_fail"),
      createEdge("CodeReview", "Build", "review_fail"),
    ],
  });

  const script = [
    "user: @Build 在当前项目的一个 python 文件中实现一个加法工具，调用后传入 a 和 b，返回 c",
    "Build: 加法工具已经实现。 @UnitTest @TaskReview @CodeReview",
    "CodeReview: 我不认同已经完成的结论 @Build",
    "TaskReview: 我不认同现在可以直接交付 @Build",
    "UnitTest: 测试已经有了，整体也符合大部分标准。",
    "TaskReview: 我不认同现在可以直接交付 @Build",
  ];

  await assert.rejects(
    () => assertSchedulerScript({ topology, script }),
    /不是当前批次 .* 等待中的 reviewer|@ 目标与预期不一致|无法继续推进脚本|缺少 Build 第 2 轮回复/u,
  );
});

test("真实日志里修完首个失败 reviewer 后立刻全量重派，不应通过脚本校验", async () => {
  const topology = createTopology({
    projectId: "generic-script-invalid-full-redispatch-after-first-repair",
    nodes: ["Build", "UnitTest", "TaskReview", "CodeReview"],
    edges: [
      createEdge("Build", "UnitTest", "association"),
      createEdge("Build", "TaskReview", "association"),
      createEdge("Build", "CodeReview", "association"),
      createEdge("UnitTest", "Build", "review_fail"),
      createEdge("TaskReview", "Build", "review_fail"),
      createEdge("CodeReview", "Build", "review_fail"),
    ],
  });

  const script = [
    "user: @Build 请完成这个需求",
    "Build: 第 1 轮实现完成，@UnitTest @TaskReview @CodeReview",
    "UnitTest: 不通过 @Build",
    "TaskReview: 不通过 @Build",
    "CodeReview: 不通过 @Build",
    "Build: 已修复 UnitTest 第 1 轮问题 @UnitTest @TaskReview @CodeReview",
  ];

  await assert.rejects(
    () => assertSchedulerScript({ topology, script }),
    /@ 目标与预期不一致|初始\/全量派发目标必须等于 topology\.association 默认顺序/u,
  );
});

test("script 模板支持 spawn 实例短名 sender 和 @target", async () => {
  const topology = createTopology({
    projectId: "generic-script-spawn-display-name",
    downstream: {
      Build: { TaskReview: "spawn" },
      TaskReview: { Build: "review_fail" },
    },
    spawn: {
      TaskReview: {},
    },
  });

  const script = [
    "user: @Build 请完成这个需求",
    "Build: 第 1 轮实现完成，@TaskReview-1",
    "TaskReview-1: 第 1 轮未通过 @Build",
    "Build: 已修复第 1 轮问题 @TaskReview-2",
    "TaskReview-2: 通过",
  ];

  await assertSchedulerScript({ topology, script });
});
