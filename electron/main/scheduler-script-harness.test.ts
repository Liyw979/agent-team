import assert from "node:assert/strict";
import test from "node:test";

import type { TopologyRecord } from "@shared/types";

import { assertSchedulerScript } from "./scheduler-script-harness";

test("直接挂在 Build 下的后续节点会等 CodeReview 回合结束后再触发", async () => {
  const topology: TopologyRecord = {
    projectId: "migrated-script-1021",
    startAgentId: "BA",
    agentOrderIds: ["BA", "Build", "CodeReview", "UnitTest", "TaskReview"],
    nodes: [
      { id: "BA", label: "BA", kind: "agent" },
      { id: "Build", label: "Build", kind: "agent" },
      { id: "CodeReview", label: "CodeReview", kind: "agent" },
      { id: "UnitTest", label: "UnitTest", kind: "agent" },
      { id: "TaskReview", label: "TaskReview", kind: "agent" },
    ],
    edges: [
      { id: "BA__Build__association", source: "BA", target: "Build", triggerOn: "association" },
      { id: "Build__CodeReview__association", source: "Build", target: "CodeReview", triggerOn: "association" },
      { id: "Build__UnitTest__association", source: "Build", target: "UnitTest", triggerOn: "association" },
      { id: "Build__TaskReview__association", source: "Build", target: "TaskReview", triggerOn: "association" },
      { id: "CodeReview__Build__review_fail", source: "CodeReview", target: "Build", triggerOn: "review_fail" },
    ],
  };

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

test("通用调度脚本模式支持非 Build 的实现者反复修复 reviewer 意见", async () => {
  const topology: TopologyRecord = {
    projectId: "generic-script-1",
    startAgentId: "Implementer",
    agentOrderIds: ["Implementer", "UnitTest", "TaskReview", "CodeReview"],
    nodes: [
      { id: "Implementer", label: "Implementer", kind: "agent" },
      { id: "UnitTest", label: "UnitTest", kind: "agent" },
      { id: "TaskReview", label: "TaskReview", kind: "agent" },
      { id: "CodeReview", label: "CodeReview", kind: "agent" },
    ],
    edges: [
      { id: "Implementer__UnitTest__association", source: "Implementer", target: "UnitTest", triggerOn: "association" },
      { id: "Implementer__TaskReview__association", source: "Implementer", target: "TaskReview", triggerOn: "association" },
      { id: "Implementer__CodeReview__association", source: "Implementer", target: "CodeReview", triggerOn: "association" },
      { id: "UnitTest__Implementer__review_fail", source: "UnitTest", target: "Implementer", triggerOn: "review_fail" },
    ],
  };

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
  const topology: TopologyRecord = {
    projectId: "generic-script-invalid",
    startAgentId: "Implementer",
    agentOrderIds: ["Implementer", "UnitTest", "TaskReview", "CodeReview"],
    nodes: [
      { id: "Implementer", label: "Implementer", kind: "agent" },
      { id: "UnitTest", label: "UnitTest", kind: "agent" },
      { id: "TaskReview", label: "TaskReview", kind: "agent" },
      { id: "CodeReview", label: "CodeReview", kind: "agent" },
    ],
    edges: [
      { id: "Implementer__UnitTest__association", source: "Implementer", target: "UnitTest", triggerOn: "association" },
      { id: "UnitTest__Implementer__review_fail", source: "UnitTest", target: "Implementer", triggerOn: "review_fail" },
    ],
  };

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
  const topology: TopologyRecord = {
    projectId: "generic-script-2",
    startAgentId: "BA",
    agentOrderIds: ["BA", "Implementer", "CodeReview", "TaskReview", "UnitTest"],
    nodes: [
      { id: "BA", label: "BA", kind: "agent" },
      { id: "Implementer", label: "Implementer", kind: "agent" },
      { id: "CodeReview", label: "CodeReview", kind: "agent" },
      { id: "TaskReview", label: "TaskReview", kind: "agent" },
      { id: "UnitTest", label: "UnitTest", kind: "agent" },
    ],
    edges: [
      { id: "BA__Implementer__association", source: "BA", target: "Implementer", triggerOn: "association" },
      { id: "Implementer__CodeReview__association", source: "Implementer", target: "CodeReview", triggerOn: "association" },
      { id: "CodeReview__Implementer__review_fail", source: "CodeReview", target: "Implementer", triggerOn: "review_fail" },
      { id: "CodeReview__TaskReview__review_pass", source: "CodeReview", target: "TaskReview", triggerOn: "review_pass" },
      { id: "CodeReview__UnitTest__review_pass", source: "CodeReview", target: "UnitTest", triggerOn: "review_pass" },
    ],
  };

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

test("CodeReview 即使存在 review_pass 下游，也会先拦住 Build 的其他 association 下游", async () => {
  const topology: TopologyRecord = {
    projectId: "migrated-script-1176",
    startAgentId: "BA",
    agentOrderIds: ["BA", "Build", "CodeReview", "UnitTest", "TaskReview"],
    nodes: [
      { id: "BA", label: "BA", kind: "agent" },
      { id: "Build", label: "Build", kind: "agent" },
      { id: "CodeReview", label: "CodeReview", kind: "agent" },
      { id: "UnitTest", label: "UnitTest", kind: "agent" },
      { id: "TaskReview", label: "TaskReview", kind: "agent" },
    ],
    edges: [
      { id: "BA__Build__association", source: "BA", target: "Build", triggerOn: "association" },
      { id: "Build__CodeReview__association", source: "Build", target: "CodeReview", triggerOn: "association" },
      { id: "Build__UnitTest__association", source: "Build", target: "UnitTest", triggerOn: "association" },
      { id: "CodeReview__Build__review_fail", source: "CodeReview", target: "Build", triggerOn: "review_fail" },
      { id: "CodeReview__TaskReview__review_pass", source: "CodeReview", target: "TaskReview", triggerOn: "review_pass" },
    ],
  };

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

test("CodeReview 给出整改意见后，Build 只会继续回复 CodeReview，直到通过后才触发其他关联审查", async () => {
  const topology: TopologyRecord = {
    projectId: "migrated-script-1329",
    startAgentId: "BA",
    agentOrderIds: ["BA", "Build", "CodeReview", "UnitTest", "TaskReview"],
    nodes: [
      { id: "BA", label: "BA", kind: "agent" },
      { id: "Build", label: "Build", kind: "agent" },
      { id: "CodeReview", label: "CodeReview", kind: "agent" },
      { id: "UnitTest", label: "UnitTest", kind: "agent" },
      { id: "TaskReview", label: "TaskReview", kind: "agent" },
    ],
    edges: [
      { id: "BA__Build__association", source: "BA", target: "Build", triggerOn: "association" },
      { id: "Build__CodeReview__association", source: "Build", target: "CodeReview", triggerOn: "association" },
      { id: "Build__UnitTest__association", source: "Build", target: "UnitTest", triggerOn: "association" },
      { id: "Build__TaskReview__association", source: "Build", target: "TaskReview", triggerOn: "association" },
      { id: "CodeReview__Build__review_fail", source: "CodeReview", target: "Build", triggerOn: "review_fail" },
      { id: "UnitTest__Build__review_fail", source: "UnitTest", target: "Build", triggerOn: "review_fail" },
      { id: "TaskReview__Build__review_fail", source: "TaskReview", target: "Build", triggerOn: "review_fail" },
    ],
  };

  const script = [
    "user: @BA 请实现一个临时工具，并按 CodeReview 意见来回修复直到通过。",
    "BA: 需求明确，交给 Build 实现。 @Build",
    "Build: Build 首轮已完成，请先走 CodeReview。 @CodeReview @UnitTest @TaskReview",
    "CodeReview: CodeReview 认为还需要继续修复。 @Build",
    "UnitTest: UnitTest 已收到首轮 Build 结果。",
    "TaskReview: TaskReview 已收到首轮 Build 结果。",
    "Build: Build 已根据 CodeReview 意见完成修复。 @CodeReview",
    "CodeReview: CodeReview 已确认通过，可以进入后续审查。",
    "Build: @UnitTest @TaskReview",
    "UnitTest: UnitTest 已收到 CodeReview 通过后的最终 Build 结果。",
    "TaskReview: TaskReview 已收到 CodeReview 通过后的最终 Build 结果。",
  ];

  await assertSchedulerScript({ topology, script });
});

test("BA dispatches Build through three review passes before the task can finish", async () => {
  const topology: TopologyRecord = {
    projectId: "migrated-script-2388",
    startAgentId: "BA",
    agentOrderIds: ["BA", "Build", "UnitTest", "CodeReview", "TaskReview"],
    nodes: [
      { id: "BA", label: "BA", kind: "agent" },
      { id: "Build", label: "Build", kind: "agent" },
      { id: "UnitTest", label: "UnitTest", kind: "agent" },
      { id: "CodeReview", label: "CodeReview", kind: "agent" },
      { id: "TaskReview", label: "TaskReview", kind: "agent" },
    ],
    edges: [
      { id: "BA__Build__association", source: "BA", target: "Build", triggerOn: "association" },
      { id: "Build__UnitTest__association", source: "Build", target: "UnitTest", triggerOn: "association" },
      { id: "UnitTest__Build__review_fail", source: "UnitTest", target: "Build", triggerOn: "review_fail" },
      { id: "UnitTest__CodeReview__review_pass", source: "UnitTest", target: "CodeReview", triggerOn: "review_pass" },
      { id: "CodeReview__Build__review_fail", source: "CodeReview", target: "Build", triggerOn: "review_fail" },
      { id: "CodeReview__TaskReview__review_pass", source: "CodeReview", target: "TaskReview", triggerOn: "review_pass" },
      { id: "TaskReview__Build__review_fail", source: "TaskReview", target: "Build", triggerOn: "review_fail" },
    ],
  };

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
  const topology: TopologyRecord = {
    projectId: "generic-script-long-cycle",
    startAgentId: "Build",
    agentOrderIds: ["Build", "UnitTest", "TaskReview", "CodeReview"],
    nodes: [
      { id: "Build", label: "Build", kind: "agent" },
      { id: "UnitTest", label: "UnitTest", kind: "agent" },
      { id: "TaskReview", label: "TaskReview", kind: "agent" },
      { id: "CodeReview", label: "CodeReview", kind: "agent" },
    ],
    edges: [
      { id: "Build__UnitTest__association", source: "Build", target: "UnitTest", triggerOn: "association" },
      { id: "Build__TaskReview__association", source: "Build", target: "TaskReview", triggerOn: "association" },
      { id: "Build__CodeReview__association", source: "Build", target: "CodeReview", triggerOn: "association" },
      { id: "UnitTest__Build__review_fail", source: "UnitTest", target: "Build", triggerOn: "review_fail" },
      { id: "TaskReview__Build__review_fail", source: "TaskReview", target: "Build", triggerOn: "review_fail" },
      { id: "CodeReview__Build__review_fail", source: "CodeReview", target: "Build", triggerOn: "review_fail" },
    ],
  };

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
    "Build: 已修复 UnitTest 第 5 轮问题 @UnitTest",
    "UnitTest: UnitTest 第 6 轮通过，可以进入后续审查。",
    "Build: @TaskReview @CodeReview",
    "TaskReview: TaskReview 第 1 轮未通过 @Build",
    "CodeReview: ok",
    "Build: 已修复 TaskReview 第 1 轮问题 @TaskReview",
    "TaskReview: TaskReview 第 2 轮未通过 @Build",
    "Build: 已修复 TaskReview 第 2 轮问题 @TaskReview",
    "TaskReview: 认可 Build 结果。",
    "Build: @CodeReview @UnitTest",
    "CodeReview: ok",
    "UnitTest: UnitTest 第 7 轮未通过 @Build",
    "Build: 已修复 UnitTest 第 7 轮问题 @UnitTest",
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

test("修完中间 reviewer 后，会先继续后续未完成 reviewer，再补前面的 stale reviewer", async () => {
  const topology: TopologyRecord = {
    projectId: "generic-script-user-expected-order",
    startAgentId: "BA",
    agentOrderIds: ["BA", "Build", "UnitTest", "TaskReview", "CodeReview"],
    nodes: [
      { id: "BA", label: "BA", kind: "agent" },
      { id: "Build", label: "Build", kind: "agent" },
      { id: "UnitTest", label: "UnitTest", kind: "agent" },
      { id: "TaskReview", label: "TaskReview", kind: "agent" },
      { id: "CodeReview", label: "CodeReview", kind: "agent" },
    ],
    edges: [
      { id: "BA__Build__association", source: "BA", target: "Build", triggerOn: "association" },
      { id: "Build__UnitTest__association", source: "Build", target: "UnitTest", triggerOn: "association" },
      { id: "Build__TaskReview__association", source: "Build", target: "TaskReview", triggerOn: "association" },
      { id: "Build__CodeReview__association", source: "Build", target: "CodeReview", triggerOn: "association" },
      { id: "UnitTest__Build__review_fail", source: "UnitTest", target: "Build", triggerOn: "review_fail" },
      { id: "TaskReview__Build__review_fail", source: "TaskReview", target: "Build", triggerOn: "review_fail" },
      { id: "CodeReview__Build__review_fail", source: "CodeReview", target: "Build", triggerOn: "review_fail" },
    ],
  };

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

test("真实日志里重复 reviewer 回复并在整批失败后再次全量派发，不应通过脚本校验", async () => {
  const topology: TopologyRecord = {
    projectId: "generic-script-invalid-real-log",
    startAgentId: "BA",
    agentOrderIds: ["BA", "Build", "UnitTest", "TaskReview", "CodeReview"],
    nodes: [
      { id: "BA", label: "BA", kind: "agent" },
      { id: "Build", label: "Build", kind: "agent" },
      { id: "UnitTest", label: "UnitTest", kind: "agent" },
      { id: "TaskReview", label: "TaskReview", kind: "agent" },
      { id: "CodeReview", label: "CodeReview", kind: "agent" },
    ],
    edges: [
      { id: "BA__Build__association", source: "BA", target: "Build", triggerOn: "association" },
      { id: "Build__UnitTest__association", source: "Build", target: "UnitTest", triggerOn: "association" },
      { id: "Build__TaskReview__association", source: "Build", target: "TaskReview", triggerOn: "association" },
      { id: "Build__CodeReview__association", source: "Build", target: "CodeReview", triggerOn: "association" },
      { id: "UnitTest__Build__review_fail", source: "UnitTest", target: "Build", triggerOn: "review_fail" },
      { id: "TaskReview__Build__review_fail", source: "TaskReview", target: "Build", triggerOn: "review_fail" },
      { id: "CodeReview__Build__review_fail", source: "CodeReview", target: "Build", triggerOn: "review_fail" },
    ],
  };

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
    /回应顺序不等于当前批次的 @ 顺序|@ 目标与预期不一致|无法继续推进脚本/u,
  );
});
