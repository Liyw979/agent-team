// 历史要求：执行期决策 Agent 判断直接使用共享拓扑能力，不保留薄包装方法，不引入多个拓扑兼容设想。
import assert from "node:assert/strict";

import {
  FLOW_END_NODE_ID,
  collectTopologyTriggerShapes,
  isDecisionAgentInTopology,
  type TopologyRecord,
} from "@shared/types";

import {
  applyAgentResultToGraphState,
  createUserDispatchDecision,
  type GraphAgentResult,
  type GraphDispatchBatch,
  type GraphRoutingDecision,
} from "@/runtime/gating-router";
import { createEmptyGraphTaskState } from "@/runtime/gating-state";
import { parseDecision } from "@/runtime/decision-parser";
import { buildEffectiveTopology } from "@/runtime/runtime-topology-graph";
import {
  extractLeadingMention,
  formatSchedulerScriptMessageLine,
  isDispatchAssertionLine,
  parseRuntimeAlias,
  parseSchedulerScriptLine,
  parseSchedulerScriptLines,
  stripLeadingMention,
  type ParsedSchedulerScriptLine,
} from "./scheduler-script-dsl";

type ParsedScriptLine = ParsedSchedulerScriptLine;
type ScriptRoutingMeta =
  | {
      routingKind: "default";
    }
  | {
      routingKind: "invalid";
    }
  | {
      routingKind: "triggered";
      trigger: string;
    };

type ExplicitDecisionTrigger =
  | {
      kind: "matched";
      trigger: string;
    }
  | {
      kind: "invalid";
    };

interface RunSchedulerScriptEmulatorOptions {
  topology: TopologyRecord;
  script: string[];
}

type GraphTaskStateLike = ReturnType<typeof createEmptyGraphTaskState>;

function isBatchSourceAgent(batch: GraphDispatchBatch, agentId: string): boolean {
  return batch.source.kind === "agent" && batch.source.agentId === agentId;
}

function describeBatchSource(batch: GraphDispatchBatch): string {
  return batch.source.kind === "agent" ? batch.source.agentId : "user";
}

type ConsumedDispatch =
  | {
      kind: "consumed";
      batchId: string;
      dispatchOwner: DispatchOwner;
    }
  | {
      kind: "not_consumed";
    };

type DispatchOwner =
  | {
      kind: "known";
      lineIndex: number;
    }
  | {
      kind: "unknown";
    };

type DispatchOwnerEntry = {
  batchId: string;
  lineIndex: number;
};

type DispatchOwnerRegistry = {
  record(batchId: string, lineIndex: number): DispatchOwnerRegistry;
  resolve(batchId: string): DispatchOwner;
};

type ExplicitDispatch =
  | {
      kind: "inline_dispatch" | "dispatch_assertion";
      targets: string[];
      batchId: string;
    }
  | {
      kind: "none";
    };

type TraceBatchRef =
  | {
      kind: "present";
      batchId: string;
    }
  | {
      kind: "absent";
    };

type InitialTraceStep =
  | {
      kind: "present";
      step: Extract<SchedulerScriptTraceStep, { kind: "initial" }>;
    }
  | {
      kind: "absent";
    };


interface SchedulerScriptTraceStepBase {
  lineIndex: number;
  line: ParsedScriptLine;
  beforeState: GraphTaskStateLike;
  afterState: GraphTaskStateLike;
  afterDecision: GraphRoutingDecision;
}

type SchedulerScriptTraceStep =
  | (SchedulerScriptTraceStepBase & {
      kind: "initial";
      line: Extract<ParsedScriptLine, { kind: "message" }>;
      senderId: "user";
      afterBatchId: string;
    })
  | (SchedulerScriptTraceStepBase & {
      kind: "state";
      line: Extract<ParsedScriptLine, { kind: "state" }>;
      beforeDecision: GraphRoutingDecision;
    })
  | (SchedulerScriptTraceStepBase & {
      kind: "message";
      line: Extract<ParsedScriptLine, { kind: "message" }>;
      senderId: string;
      beforeDecision: GraphRoutingDecision;
      beforeBatch: TraceBatchRef;
      afterBatch: TraceBatchRef;
      explicitDispatch: ExplicitDispatch;
      consumedDispatch: ConsumedDispatch;
    });

interface SchedulerScriptTrace {
  topology: TopologyRecord;
  script: string[];
  lines: ParsedScriptLine[];
  steps: SchedulerScriptTraceStep[];
}

type SchedulerScriptDecisionSnapshot =
  | {
      type: "execute_batch";
      source: GraphDispatchBatch["source"];
      targets: string[];
    }
  | {
      type: "finished";
    }
  | {
      type: "finished_with_reason";
      finishReason: string;
    }
  | {
      type: "failed";
      errorMessage: string;
    };

interface RequiredDispatchAssertion {
  lineIndex: number;
  senderId: string;
  targets: string[];
  kind: "inline_dispatch" | "dispatch_assertion";
  batchId: string;
}

interface RequiredConsumerMessage {
  dispatchLineIndex: number;
  consumerLineIndex: number;
  consumerAgentId: string;
  batchId: string;
}

type SchedulerScriptNegativeVariant =
  | {
      kind: "missing_target";
      sourceLineIndex: number;
      removedTarget: string;
      script: string[];
      expectedFailureCategory: "dispatch_contract";
    }
  | {
      kind: "missing_dispatch_line";
      sourceLineIndex: number;
      script: string[];
      expectedFailureCategory: "dispatch_contract";
    }
  | {
      kind: "missing_consumer_line";
      sourceLineIndex: number;
      removedMessageLineIndex: number;
      script: string[];
      expectedFailureCategory: "consumer_contract";
    }
  | {
      kind: "truncate_after_line";
      sourceLineIndex: number;
      script: string[];
      expectedFailureCategory: "consumer_contract";
    };

export function dispatchAssertionTargetsCovered(
  actualTargets: string[],
  expectedTargets: string[],
): boolean {
  return expectedTargets.every((target) => actualTargets.includes(target));
}

export function buildDispatchTargetMismatchMessage(input: {
  rawLine: string;
  expectedTargets: string[];
  actualTargets: string[];
}): string {
  return `${input.rawLine} 的调度目标不匹配。脚本写的是 [${input.expectedTargets.join(", ")}]，实际是 [${input.actualTargets.join(", ")}]`;
}

function formatTargetList(targets: string[]): string {
  return `[${targets.join(" ")}]`;
}

export function buildMissingDispatchTargetsMessage(input: {
  rawLine: string;
  scriptTargets: string[];
  simulatedTargets: string[];
}): string {
  return `${input.rawLine} 脚本包含 ${formatTargetList(input.scriptTargets)}，当前步骤模拟值为 ${formatTargetList(input.simulatedTargets)}`;
}

export function buildUnexpectedNextSenderMessage(input: {
  rawLine: string;
  actualSenderId: string;
  simulatedTargets: string[];
}): string {
  return `${input.rawLine} 的下一条回应 Agent 不匹配，当前步骤模拟值为 ${formatTargetList(input.simulatedTargets)}，脚本实际写的是 ${input.actualSenderId}`;
}

export function buildUnexpectedScriptEndMessage(input: {
  state: ReturnType<typeof createEmptyGraphTaskState>;
  decision: GraphRoutingDecision;
}): string {
  if (input.decision.type === "execute_batch") {
    return `脚本提前结束，当前还缺少 ${formatTargetList(getScriptVisibleDecisionTargets(input.state, input.decision))} 这批调度断言，调度状态为 ${describeDecision(input.decision)}`;
  }
  return `脚本提前结束，当前调度状态为 ${describeDecision(input.decision)}`;
}

export function isImplicitEmptyDispatchAssertionLine(input: {
  line: Extract<ParsedScriptLine, { kind: "message" }>;
  senderId: string;
  decision: GraphRoutingDecision;
}): boolean {
  return input.line.body.length === 0
    && input.line.targets.length === 0
    && input.decision.type === "execute_batch"
    && isBatchSourceAgent(input.decision.batch, input.senderId);
}

export function canScriptEndAfterLastLine(decision: GraphRoutingDecision): boolean {
  return decision.type === "finished";
}

function getPendingRuntimeSenders(
  state: ReturnType<typeof createEmptyGraphTaskState>,
): string[] {
  return [...new Set([
    ...state.runningAgents,
    ...state.queuedAgents,
    ...Object.values(state.activeHandoffBatchBySource).flatMap((batch) => batch.pendingTargets),
  ])];
}

export function shouldRequireSourceDispatchAssertion(input: {
  currentSenderId: string;
  decision: GraphRoutingDecision;
  nextSenderId: string;
}): boolean {
  return input.decision.type === "execute_batch"
    && input.decision.batch.source.kind === "agent"
    && input.decision.batch.source.agentId !== input.currentSenderId
    && input.decision.batch.jobs.some((job) => job.agentId === input.nextSenderId);
}

function collectActualTransitionTargets(input: {
  transitions: Array<ScriptRoutingMeta & {
    state: ReturnType<typeof createEmptyGraphTaskState>;
    decision: GraphRoutingDecision;
  }>;
  senderId: string;
}): string[] {
  return [
    ...new Set(
      input.transitions.flatMap((transition) => (
        isDirectTransitionFromSender(input.senderId, transition.decision)
          ? resolveActualTransitionTargets(
              transition.state,
              transition.decision,
              input.senderId,
              transition,
            )
          : []
      )),
    ),
  ];
}

export function preferWaitingDecisionCandidatesForPendingNextSender<T extends {
  result: GraphAgentResult;
  state: ReturnType<typeof createEmptyGraphTaskState>;
  decision: GraphRoutingDecision;
}>(input: {
  candidates: T[];
  nextSenderId: string;
}): T[] {
  const waitingCandidates = input.candidates.filter((candidate) =>
    getPendingRuntimeSenders(candidate.state).includes(input.nextSenderId)
  );
  return waitingCandidates.length > 0 ? waitingCandidates : input.candidates;
}

function createTraceBatchIdFactory() {
  let nextId = 1;
  const ids = new Map<GraphRoutingDecision, string>();

  return (decision: Extract<GraphRoutingDecision, { type: "execute_batch" }>): string => {
    const existing = ids.get(decision);
    if (existing) {
      return existing;
    }
    const created = `batch-${nextId}`;
    nextId += 1;
    ids.set(decision, created);
    return created;
  };
}

function resolveRequiredBatchId(
  decision: GraphRoutingDecision,
  resolveBatchId: (decision: Extract<GraphRoutingDecision, { type: "execute_batch" }>) => string,
): string {
  if (decision.type !== "execute_batch") {
    assert.fail(`期望 execute_batch，实际是 ${describeDecision(decision)}`);
  }
  return resolveBatchId(decision);
}

function requireScriptLine(lines: ParsedScriptLine[], index: number): ParsedScriptLine {
  const line = lines[index];
  if (!line) {
    assert.fail(`第 ${index + 1} 条脚本不存在`);
  }
  return line;
}

function requireRawScriptLine(script: string[], index: number): string {
  const line = script[index];
  if (!line) {
    assert.fail(`第 ${index + 1} 条原始脚本不存在`);
  }
  return line;
}

function requireArrayItem<T>(items: T[], index: number, description: string): T {
  const item = items[index];
  if (!item) {
    assert.fail(`${description} 不存在：${index}`);
  }
  return item;
}

function getNextScriptLine(lines: ParsedScriptLine[], index: number): ParsedScriptLine | null {
  return lines[index] ?? null;
}

function createDispatchOwnerRegistry(
  entries: readonly DispatchOwnerEntry[],
): DispatchOwnerRegistry {
  return {
    record: (batchId, lineIndex) => createDispatchOwnerRegistry([
      ...entries,
      { batchId, lineIndex },
    ]),
    resolve: (batchId) => entries.reduce<DispatchOwner>(
      (resolved, entry) => resolved.kind === "known" || entry.batchId !== batchId
        ? resolved
        : { kind: "known", lineIndex: entry.lineIndex },
      { kind: "unknown" },
    ),
  };
}

async function runSchedulerScriptInternal(
  options: RunSchedulerScriptEmulatorOptions,
): Promise<SchedulerScriptTrace> {
  const lines = parseSchedulerScriptLines(options.script);
  const steps: SchedulerScriptTraceStep[] = [];
  const resolveBatchId = createTraceBatchIdFactory();
  // 这里只记录 trace 归因信息，方便把“某个 batch 来自哪条脚本行”映射回报错文案；
  // 真正的调度状态始终只来自 graph core 返回的 state / decision。
  let dispatchOwnerRegistry = createDispatchOwnerRegistry([]);

  const firstLine = requireScriptLine(lines, 0);
  if (firstLine.kind !== "message") {
    assert.fail("第一条脚本必须是 user 消息");
  }
  const firstMessageLine = firstLine;
  if (firstMessageLine.sender !== "user") {
    assert.fail("第一条脚本必须是 user: @Agent ...");
  }

  const initialTarget = extractLeadingMention(firstMessageLine.body);
  assert.ok(initialTarget, "第一条 user 消息必须以 @Agent 开头");

  let state = createEmptyGraphTaskState({
    taskId: "scheduler-script-emulator",
    topology: options.topology,
  });
  let currentDecision = createUserDispatchDecision(state, {
    targetAgentId: initialTarget,
    content: stripLeadingMention(firstMessageLine.body),
  });
  assertExecuteBatchTargets(currentDecision, [initialTarget], firstMessageLine.raw);

  steps.push({
    kind: "initial",
    lineIndex: 0,
    line: firstMessageLine,
    senderId: "user",
    beforeState: state,
    afterState: state,
    afterDecision: currentDecision,
    afterBatchId: resolveRequiredBatchId(currentDecision, resolveBatchId),
  });

  for (let index = 1; index < lines.length; index += 1) {
    const ensuredLine = requireScriptLine(lines, index);
    const beforeState = state;
    const beforeDecision = currentDecision;
    const beforeBatch: TraceBatchRef = beforeDecision.type === "execute_batch"
      ? { kind: "present", batchId: resolveBatchId(beforeDecision) }
      : { kind: "absent" };

    if (ensuredLine.kind === "state") {
      assert.equal(index, lines.length - 1, "state 行只能出现在脚本最后");
      assert.equal(currentDecision.type, "finished", `期望最终状态为 finished，实际是 ${describeDecision(currentDecision)}`);
      steps.push({
        kind: "state",
        lineIndex: index,
        line: ensuredLine,
        beforeState,
        beforeDecision,
        afterState: state,
        afterDecision: currentDecision,
      });
      continue;
    }

    const senderId = resolveScriptAgentId(state, ensuredLine.sender);
    const consumedBatch: TraceBatchRef = beforeDecision.type === "execute_batch"
      && beforeDecision.batch.jobs.some((job) => job.agentId === senderId)
      ? beforeBatch
      : { kind: "absent" };
    const consumedDispatch: ConsumedDispatch = consumedBatch.kind === "present"
      ? {
          kind: "consumed",
          batchId: consumedBatch.batchId,
          dispatchOwner: dispatchOwnerRegistry.resolve(consumedBatch.batchId),
        }
      : { kind: "not_consumed" };
    if (isImplicitEmptyDispatchAssertionLine({
      line: ensuredLine,
      senderId,
      decision: currentDecision,
    })) {
      const simulatedTargets = currentDecision.type === "execute_batch"
        ? getScriptVisibleDecisionTargets(state, currentDecision)
        : [];
      assert.fail(
        buildMissingDispatchTargetsMessage({
          rawLine: ensuredLine.raw,
          scriptTargets: [],
          simulatedTargets,
        }),
      );
    }
    if (isDispatchAssertionLine(ensuredLine)) {
      const expectedTargets = ensuredLine.targets.map((target) => resolveScriptAgentId(state, target));
      assert.equal(
        currentDecision.type,
        "execute_batch",
        `${ensuredLine.raw} 期望断言 execute_batch，实际是 ${describeDecision(currentDecision)}`,
      );
      assert.equal(
        currentDecision.batch.source.kind === "agent" ? currentDecision.batch.source.agentId : "",
        senderId,
        `${ensuredLine.raw} 的 sender 不是当前调度批次的 source，实际 source 为 ${describeBatchSource(currentDecision.batch)}`,
      );
      const actualTargets = getScriptVisibleDecisionTargets(state, currentDecision);
      assert.equal(
        arraysEqual(actualTargets, expectedTargets),
        true,
        buildDispatchTargetMismatchMessage({
          rawLine: ensuredLine.raw,
          expectedTargets,
          actualTargets,
        }),
      );
      if (beforeBatch.kind === "present") {
        dispatchOwnerRegistry = dispatchOwnerRegistry.record(beforeBatch.batchId, index);
      }
      steps.push({
        kind: "message",
        lineIndex: index,
        line: ensuredLine,
        senderId,
        beforeState,
        beforeDecision,
        afterState: state,
        afterDecision: currentDecision,
        beforeBatch,
        afterBatch: beforeBatch,
        explicitDispatch: beforeBatch.kind === "present"
          ? { kind: "dispatch_assertion", targets: actualTargets, batchId: beforeBatch.batchId }
          : { kind: "none" },
        consumedDispatch,
      });
      continue;
    }
    assertSenderAllowed(
      state,
      senderId,
      currentDecision,
      ensuredLine.raw,
    );

    const nextLine = getNextScriptLine(lines, index + 1);
    const decisionResolution = applyMessageLineAndMatchDecision({
      state,
      line: ensuredLine,
      senderId,
      topology: options.topology,
      nextLine,
    });

    state = decisionResolution.state;
    currentDecision = decisionResolution.decision;
    const decisionRouting: ScriptRoutingMeta = decisionResolution.routingKind === "triggered"
      ? {
          routingKind: "triggered",
          trigger: decisionResolution.trigger,
        }
      : decisionResolution.routingKind === "invalid"
        ? {
            routingKind: "invalid",
          }
        : {
            routingKind: "default",
          };
    const explicitTargets = ensuredLine.targets.length > 0
      ? resolveActualTransitionTargets(
        decisionResolution.state,
        decisionResolution.decision,
        senderId,
        decisionRouting,
      )
      : [];
    const afterBatch: TraceBatchRef = currentDecision.type === "execute_batch"
      ? { kind: "present", batchId: resolveBatchId(currentDecision) }
      : { kind: "absent" };
    if (ensuredLine.targets.length > 0 && afterBatch.kind === "present") {
      dispatchOwnerRegistry = dispatchOwnerRegistry.record(afterBatch.batchId, index);
    }
    steps.push({
      kind: "message",
      lineIndex: index,
      line: ensuredLine,
      senderId,
      beforeState,
      beforeDecision,
      afterState: state,
      afterDecision: currentDecision,
      beforeBatch,
      afterBatch,
      explicitDispatch: ensuredLine.targets.length > 0 && afterBatch.kind === "present"
        ? { kind: "inline_dispatch", targets: explicitTargets, batchId: afterBatch.batchId }
        : { kind: "none" },
      consumedDispatch,
    });
  }

  assert.equal(
    canScriptEndAfterLastLine(currentDecision),
    true,
    buildUnexpectedScriptEndMessage({
      state,
      decision: currentDecision,
    }),
  );

  return {
    topology: options.topology,
    script: [...options.script],
    lines,
    steps,
  };
}

export const runSchedulerScriptDrived = runSchedulerScriptInternal;

export function collectDecisionSnapshots(
  trace: SchedulerScriptTrace,
): SchedulerScriptDecisionSnapshot[] {
  return trace.steps.map((step) => {
    if (step.afterDecision.type === "execute_batch") {
      return {
        type: "execute_batch",
        source: step.afterDecision.batch.source,
        targets: getScriptVisibleDecisionTargets(step.afterState, step.afterDecision),
      };
    }
    if (step.afterDecision.type === "finished") {
      return step.afterDecision.finishReason
        ? { type: "finished_with_reason", finishReason: step.afterDecision.finishReason }
        : { type: "finished" };
    }
    return {
      type: "failed",
      errorMessage: step.afterDecision.errorMessage,
    };
  });
}

export function collectRequiredDispatchAssertions(
  trace: SchedulerScriptTrace,
): RequiredDispatchAssertion[] {
  return trace.steps.flatMap((step) => {
    if (step.kind !== "message" || step.explicitDispatch.kind === "none") {
      return [];
    }

    return [{
      lineIndex: step.lineIndex,
      senderId: step.senderId,
      targets: [...step.explicitDispatch.targets],
      kind: step.explicitDispatch.kind,
      batchId: step.explicitDispatch.batchId,
    }];
  });
}

export function collectRequiredConsumerMessages(
  trace: SchedulerScriptTrace,
): RequiredConsumerMessage[] {
  const initialStep = getInitialTraceStep(trace);
  const requiredDispatches = createDispatchOwnerRegistry([
    ...collectRequiredDispatchAssertions(trace).map((dispatch) => ({
      batchId: dispatch.batchId,
      lineIndex: dispatch.lineIndex,
    })),
    ...(initialStep.kind === "present"
      ? [{
          batchId: initialStep.step.afterBatchId,
          lineIndex: initialStep.step.lineIndex,
        }]
      : []),
  ]);

  return trace.steps.flatMap((step) => {
    if (step.kind !== "message" || step.consumedDispatch.kind !== "consumed") {
      return [];
    }
    const dispatch = requiredDispatches.resolve(step.consumedDispatch.batchId);
    if (dispatch.kind === "unknown") {
      return [];
    }

    return [{
      dispatchLineIndex: dispatch.lineIndex,
      consumerLineIndex: step.lineIndex,
      consumerAgentId: step.senderId,
      batchId: step.consumedDispatch.batchId,
    }];
  });
}

function getInitialTraceStep(trace: SchedulerScriptTrace): InitialTraceStep {
  const step = trace.steps[0];
  if (!step || step.kind !== "initial") {
    return { kind: "absent" };
  }
  return { kind: "present", step };
}

function buildMissingTargetVariant(input: {
  script: string[];
  lineIndex: number;
  removedTargetIndex: number;
  removedTarget: string;
}): SchedulerScriptNegativeVariant {
  const parsedLine = parseSchedulerScriptLine(requireRawScriptLine(input.script, input.lineIndex));
  assert.equal(parsedLine.kind, "message", `第 ${input.lineIndex + 1} 行必须是消息行`);
  const nextTargets = parsedLine.targets.filter((_, index) => index !== input.removedTargetIndex);
  const nextLine = formatSchedulerScriptMessageLine({
    sender: parsedLine.sender,
    body: parsedLine.body,
    targets: nextTargets,
  });
  const nextScript = [...input.script];
  nextScript[input.lineIndex] = nextLine;
  return {
    kind: "missing_target",
    sourceLineIndex: input.lineIndex,
    removedTarget: input.removedTarget,
    script: nextScript,
    expectedFailureCategory: "dispatch_contract",
  };
}

function buildMissingDispatchLineVariant(input: {
  script: string[];
  sourceLineIndex: number;
}): SchedulerScriptNegativeVariant {
  return {
    kind: "missing_dispatch_line",
    sourceLineIndex: input.sourceLineIndex,
    script: input.script.filter((_, index) => index !== input.sourceLineIndex),
    expectedFailureCategory: "dispatch_contract",
  };
}

function buildMissingConsumerLineVariant(input: {
  script: string[];
  sourceLineIndex: number;
  removedMessageLineIndex: number;
}): SchedulerScriptNegativeVariant {
  return {
    kind: "missing_consumer_line",
    sourceLineIndex: input.sourceLineIndex,
    removedMessageLineIndex: input.removedMessageLineIndex,
    script: input.script.filter((_, index) => index !== input.removedMessageLineIndex),
    expectedFailureCategory: "consumer_contract",
  };
}

function shouldBuildMissingConsumerLineVariant(input: {
  trace: SchedulerScriptTrace;
  consumer: RequiredConsumerMessage;
}): boolean {
  const previousStep = input.trace.steps.find((step) =>
    step.lineIndex === input.consumer.consumerLineIndex - 1
  );
  if (!previousStep || previousStep.afterDecision.type !== "execute_batch") {
    return true;
  }
  const nextStep = input.trace.steps.find((step) =>
    step.lineIndex === input.consumer.consumerLineIndex + 1
  );
  if (!nextStep || nextStep.line.kind !== "message") {
    return true;
  }
  const nextSenderId = resolveScriptAgentId(nextStep.beforeState, nextStep.line.sender);
  return !previousStep.afterDecision.batch.jobs.some((job) =>
    job.agentId === nextSenderId
  );
}

function buildTruncateAfterLineVariant(input: {
  script: string[];
  sourceLineIndex: number;
}): SchedulerScriptNegativeVariant {
  return {
    kind: "truncate_after_line",
    sourceLineIndex: input.sourceLineIndex,
    script: input.script.slice(0, input.sourceLineIndex + 1),
    expectedFailureCategory: "consumer_contract",
  };
}

export function buildDispatchOmissionVariants(input: {
  script: string[];
  trace: SchedulerScriptTrace;
}): SchedulerScriptNegativeVariant[] {
  const variants: SchedulerScriptNegativeVariant[] = [];
  const dispatchAssertions = collectRequiredDispatchAssertions(input.trace);
  const consumerMessages = collectRequiredConsumerMessages(input.trace);

  for (const dispatch of dispatchAssertions) {
    const parsedLine = parseSchedulerScriptLine(requireRawScriptLine(input.script, dispatch.lineIndex));
    assert.equal(parsedLine.kind, "message", `第 ${dispatch.lineIndex + 1} 行必须是消息行`);
    parsedLine.targets.forEach((_, targetIndex) => {
      variants.push(buildMissingTargetVariant({
        script: input.script,
        lineIndex: dispatch.lineIndex,
        removedTargetIndex: targetIndex,
        removedTarget: requireArrayItem(dispatch.targets, targetIndex, "待删除的 dispatch target"),
      }));
    });

    if (dispatch.kind === "dispatch_assertion") {
      variants.push(buildMissingDispatchLineVariant({
        script: input.script,
        sourceLineIndex: dispatch.lineIndex,
      }));
    }
  }

  for (const consumer of consumerMessages) {
    if (shouldBuildMissingConsumerLineVariant({ trace: input.trace, consumer })) {
      variants.push(buildMissingConsumerLineVariant({
        script: input.script,
        sourceLineIndex: consumer.dispatchLineIndex,
        removedMessageLineIndex: consumer.consumerLineIndex,
      }));
    }
  }

  for (const step of input.trace.steps) {
    if (step.lineIndex >= input.script.length - 1) {
      continue;
    }
    if (canScriptEndAfterLastLine(step.afterDecision)) {
      continue;
    }
    variants.push(buildTruncateAfterLineVariant({
      script: input.script,
      sourceLineIndex: step.lineIndex,
    }));
  }

  return variants;
}

function getAutoDerivedNegativeFailurePattern(
  variant: SchedulerScriptNegativeVariant,
): RegExp {
  if (variant.expectedFailureCategory === "consumer_contract") {
    return /脚本提前结束|当前还缺少|下一条回应 Agent 不匹配|脚本包含 \[|sender 不在当前 execute_batch 目标里|无法继续推进|没有显式给出 @|并没有显式给出 @|调度目标不匹配|decision 决策无法唯一推断|trigger 路由无法唯一推断/u;
  }

  return /调度目标不匹配|脚本包含 \[|没有显式给出 @|execute_batch|脚本提前结束|当前还缺少|不存在的 Agent|下一条回应 Agent 不匹配|decision 决策无法唯一推断|trigger 路由无法唯一推断/u;
}

export async function assertAutoDerivedNegativeScripts(
  options: RunSchedulerScriptEmulatorOptions,
): Promise<void> {
  const trace = await runSchedulerScriptDrived(options);
  const variants = buildDispatchOmissionVariants({
    script: options.script,
    trace,
  });
  assert.ok(variants.length > 0, "自动派生负例不能为空");

  for (const variant of variants) {
    try {
      await runSchedulerScriptDrived({
        topology: options.topology,
        script: variant.script,
      });
      if (variant.kind === "missing_target") {
        continue;
      }
      assert.fail(`自动派生负例未按预期失败：${variant.kind} @ line ${variant.sourceLineIndex + 1}`);
    } catch (error) {
      assert.match(
        String(error),
        getAutoDerivedNegativeFailurePattern(variant),
        `自动派生负例未按预期失败：${variant.kind} @ line ${variant.sourceLineIndex + 1}`,
      );
    }
  }
}

function resolveScriptAgentId(
  state: ReturnType<typeof createEmptyGraphTaskState>,
  rawName: string,
): string {
  if (rawName === FLOW_END_NODE_ID) {
    return FLOW_END_NODE_ID;
  }
  const effectiveTopology = buildEffectiveTopology(state);
  if (effectiveTopology.nodes.includes(rawName)) {
    return rawName;
  }

  const alias = parseRuntimeAlias(rawName);
  if (alias) {
    const matchedRuntimeNode = state.runtimeNodes.find(
      (node) => node.templateName === alias.templateName && node.id === `${alias.templateName}-${alias.index}`,
    );
    if (matchedRuntimeNode) {
      return matchedRuntimeNode.id;
    }
    const matchedEffectiveNode = effectiveTopology.nodes.find(
      (nodeId) => nodeId === `${alias.templateName}-${alias.index}`,
    );
    if (matchedEffectiveNode) {
      return matchedEffectiveNode;
    }
  }

  assert.fail(`脚本里出现了当前有效拓扑中不存在的 Agent：${rawName}`);
}

function resolveScriptTargetNameForComparison(
  state: ReturnType<typeof createEmptyGraphTaskState>,
  rawName: string,
): string {
  try {
    return resolveScriptAgentId(state, rawName);
  } catch (error) {
    if (error instanceof assert.AssertionError && parseRuntimeAlias(rawName)) {
      return rawName;
    }
    throw error;
  }
}

function assertSenderAllowed(
  state: ReturnType<typeof createEmptyGraphTaskState>,
  senderId: string,
  decision: GraphRoutingDecision,
  rawLine: string,
): void {
  if (decision.type === "execute_batch") {
    const actualTargets = decision.batch.jobs.map((job) => job.agentId);
    if (getPendingRuntimeSenders(state).includes(senderId)) {
      return;
    }
    assert.ok(
      actualTargets.includes(senderId),
      buildUnexpectedNextSenderMessage({
        rawLine,
        actualSenderId: senderId,
        simulatedTargets: actualTargets,
      }),
    );
    return;
  }
  if (getPendingRuntimeSenders(state).includes(senderId)) {
    return;
  }

  assert.fail(`${rawLine} 无法继续推进，当前调度状态为 ${describeDecision(decision)}`);
}

function assertExecuteBatchTargets(
  decision: GraphRoutingDecision,
  expectedTargets: string[],
  rawLine: string,
): string[] {
  assert.equal(decision.type, "execute_batch", `${rawLine} 期望触发 execute_batch，实际是 ${describeDecision(decision)}`);
  const actualTargets = decision.batch.jobs.map((job) => job.agentId);
  assert.equal(
    arraysEqual(actualTargets, expectedTargets),
    true,
    buildDispatchTargetMismatchMessage({
      rawLine,
      expectedTargets,
      actualTargets,
    }),
  );
  return [...actualTargets];
}

function describeDecision(decision: GraphRoutingDecision): string {
  if (decision.type === "execute_batch") {
    return `execute_batch -> [${decision.batch.jobs.map((job) => job.agentId).join(", ")}]`;
  }
  if (decision.type === "finished") {
    return `finished -> ${decision.finishReason}`;
  }
  return `failed -> ${decision.errorMessage}`;
}

function describeDecisionWithVisibleTargets(
  state: ReturnType<typeof createEmptyGraphTaskState>,
  decision: GraphRoutingDecision,
): string {
  if (decision.type === "execute_batch") {
    const visibleTargets = getScriptVisibleDecisionTargets(state, decision);
    const hiddenTargets = getStrictHiddenDecisionTargets(state, decision);
    if (hiddenTargets.length > 0) {
      return `execute_batch -> visible [${visibleTargets.join(", ")}], hidden [${hiddenTargets.join(", ")}]`;
    }
    return `execute_batch -> [${visibleTargets.join(", ")}]`;
  }
  return describeDecision(decision);
}

function applyMessageLineAndMatchDecision(input: {
  state: ReturnType<typeof createEmptyGraphTaskState>;
  line: Extract<ParsedScriptLine, { kind: "message" }>;
  senderId: string;
  topology: TopologyRecord;
  nextLine: ParsedScriptLine | null;
}): {
  state: ReturnType<typeof createEmptyGraphTaskState>;
  decision: GraphRoutingDecision;
} & ScriptRoutingMeta {
  const decisionAgent = isDecisionAgentInTopology(
    buildEffectiveTopology(input.state),
    input.senderId,
  );
  const allowedDecisionTriggers = decisionAgent
    ? resolveAllowedDecisionTriggersForScript(input.state, input.senderId)
    : [];
  const explicitDecisionTrigger = decisionAgent
    ? resolveExplicitDecisionTriggerFromLine(input.line.body, allowedDecisionTriggers)
    : { kind: "invalid" as const };

  const matchedCandidates: Array<{
    result: GraphAgentResult;
    state: ReturnType<typeof createEmptyGraphTaskState>;
    decision: GraphRoutingDecision;
  }> = [];
  const attemptedTransitions: Array<ScriptRoutingMeta & {
    state: ReturnType<typeof createEmptyGraphTaskState>;
    decision: GraphRoutingDecision;
  }> = [];
  const attemptedDecisions: string[] = [];

  const candidateTransitions = explicitDecisionTrigger.kind === "matched"
    ? [{ routingKind: "triggered" as const, trigger: explicitDecisionTrigger.trigger }]
    : decisionAgent
      ? resolveCandidateDecisionTriggers(input.state, input.senderId).map((trigger) => ({
        routingKind: "triggered" as const,
        trigger,
      }))
      : [{ routingKind: "default" as const }];

  for (const candidateTransition of candidateTransitions) {
    const messageIdSuffix = "trigger" in candidateTransition ? candidateTransition.trigger : "<default>";
    const result: GraphAgentResult = candidateTransition.routingKind === "triggered"
      ? {
          agentId: input.senderId,
          messageId: `script:${input.senderId}:${messageIdSuffix}`,
          status: "completed",
          decisionAgent,
          routingKind: "triggered",
          trigger: candidateTransition.trigger,
          agentStatus: "completed",
          agentContextContent: input.line.body,
          forwardedAgentMessage: "",
          opinion: "",
          signalDone: false,
        }
      : {
          agentId: input.senderId,
          messageId: `script:${input.senderId}:${messageIdSuffix}`,
          status: "completed",
          decisionAgent,
          routingKind: "default",
          agentStatus: "completed",
          agentContextContent: input.line.body,
          forwardedAgentMessage: "",
          opinion: "",
          signalDone: false,
        };
    const reduced = applyAgentResultToGraphState(input.state, result);
    const candidateRouting: ScriptRoutingMeta = candidateTransition.routingKind === "triggered"
      ? {
          routingKind: "triggered",
          trigger: candidateTransition.trigger,
        }
      : {
          routingKind: "default",
        };
    attemptedTransitions.push({
      ...candidateRouting,
      state: reduced.state,
      decision: reduced.decision,
    });
    attemptedDecisions.push(
      `${candidateTransition.routingKind}${
        "trigger" in candidateTransition ? `(${candidateTransition.trigger})` : ""
      }:${describeDecisionWithVisibleTargets(reduced.state, reduced.decision)}`,
    );
    if (!matchesExpectedTransition({
      line: input.line,
      nextLine: input.nextLine,
      state: reduced.state,
      routingDecision: reduced.decision,
      senderId: input.senderId,
      ...candidateRouting,
      decisionAgent,
    })) {
      continue;
    }

    matchedCandidates.push({
      result,
      state: reduced.state,
      decision: reduced.decision,
    });
  }

  const disambiguatedCandidates = disambiguateDecisionCandidates({
    candidates: matchedCandidates,
    line: input.line,
    state: input.state,
    senderId: input.senderId,
    nextLine: input.nextLine,
  });

  if (disambiguatedCandidates.length === 0) {
    if (input.line.targets.length > 0) {
      const expectedTargets = input.line.targets.map((target) =>
        resolveScriptTargetNameForComparison(input.state, target)
      );
      const actualTargets = collectActualTransitionTargets({
        transitions: attemptedTransitions,
        senderId: input.senderId,
      });
      const hasMatchingIndirectTransition = attemptedTransitions.some((transition) =>
        !isDirectTransitionFromSender(input.senderId, transition.decision)
        && arraysEqual(
          resolveActualTransitionTargets(
            transition.state,
            transition.decision,
            input.senderId,
            transition,
          ),
          expectedTargets,
        )
      );
      if (hasMatchingIndirectTransition) {
        assert.fail(
          `${input.line.raw} 不应显式声明 ${expectedTargets.map((target) => `@${target}`).join(" ")}，因为这些目标不是由当前行直接触发。实际候选为 [${attemptedDecisions.join("; ")}]`,
        );
      }
      assert.fail(
        `${buildDispatchTargetMismatchMessage({
          rawLine: input.line.raw,
          expectedTargets,
          actualTargets,
        })}。实际候选为 [${attemptedDecisions.join("; ")}]`,
      );
    }
    const nonEmptyActualTargets = collectActualTransitionTargets({
      transitions: attemptedTransitions,
      senderId: input.senderId,
    });
    if (nonEmptyActualTargets.length > 0) {
      assert.fail(
        buildMissingDispatchTargetsMessage({
          rawLine: input.line.raw,
          scriptTargets: input.line.targets.map((target) =>
            resolveScriptTargetNameForComparison(input.state, target)
          ),
          simulatedTargets: nonEmptyActualTargets,
        }),
      );
    }
    if (
      input.nextLine && input.nextLine.kind === "message"
      && attemptedTransitions.length > 0
      && attemptedTransitions.every((transition) =>
        transition.decision.type === "finished"
        && getPendingRuntimeSenders(transition.state).length === 0
      )
    ) {
      assert.fail(
        `${input.line.raw} 之后脚本继续写了 @${input.nextLine.sender}，但前一条消息并没有显式给出 @${input.nextLine.sender} 这条继续调度。实际候选为 [${attemptedDecisions.join("; ")}]`,
      );
    }
    assert.fail(
      `${input.line.raw} 的 trigger 路由无法唯一推断，匹配数量为 0。实际候选为 [${attemptedDecisions.join("; ")}]`,
    );
  }

  assert.equal(
    disambiguatedCandidates.length,
    1,
    `${input.line.raw} 的 trigger 路由无法唯一推断。实际候选为 [${attemptedDecisions.join("; ")}]`,
  );

  const chosen = requireArrayItem(disambiguatedCandidates, 0, "唯一匹配的 trigger 路由候选");
  if (input.line.targets.length > 0) {
    const expectedTargets = input.line.targets.map((target) =>
      resolveScriptTargetNameForComparison(chosen.state, target)
    );
    const actualTargets = chosen.decision.type === "execute_batch"
      ? getScriptVisibleDecisionTargets(chosen.state, chosen.decision)
      : chosen.result.routingKind === "triggered"
        ? resolveDeferredDecisionTargets(
          chosen.state,
          input.senderId,
          {
            routingKind: "triggered",
            trigger: chosen.result.trigger,
          },
        )
        : [];
    assert.equal(
      arraysEqual(actualTargets, expectedTargets),
      true,
      buildDispatchTargetMismatchMessage({
        rawLine: input.line.raw,
        expectedTargets,
        actualTargets,
      }),
    );
  }

  const chosenRouting: ScriptRoutingMeta = chosen.result.routingKind === "triggered"
    ? {
        routingKind: "triggered",
        trigger: chosen.result.trigger,
      }
    : chosen.result.routingKind === "invalid"
      ? {
          routingKind: "invalid",
        }
      : {
          routingKind: "default",
        };
  if (chosen.decision.type === "execute_batch") {
    return {
      state: chosen.state,
      decision: chosen.decision,
      ...chosenRouting,
    };
  }

  return {
    state: chosen.state,
    decision: chosen.decision,
    ...chosenRouting,
  };
}

function disambiguateDecisionCandidates<T extends {
  result: GraphAgentResult;
  state: ReturnType<typeof createEmptyGraphTaskState>;
  decision: GraphRoutingDecision;
}>(input: {
  candidates: T[];
  line: Extract<ParsedScriptLine, { kind: "message" }>;
  state: ReturnType<typeof createEmptyGraphTaskState>;
  senderId: string;
  nextLine: ParsedScriptLine | null;
}): T[] {
  const { candidates, line, state, senderId, nextLine } = input;
  if (candidates.length <= 1) {
    return candidates;
  }

  if (nextLine && nextLine.kind === "message" && !isDispatchAssertionLine(nextLine)) {
    const nextMessageLine = nextLine;
    const sourceOnly = candidates.filter((candidate) => {
      let nextSenderId: string;
      try {
        nextSenderId = resolveScriptAgentId(candidate.state, nextMessageLine.sender);
      } catch {
        return false;
      }
      return candidate.decision.type === "execute_batch"
        && isBatchSourceAgent(candidate.decision.batch, nextSenderId)
        && !getScriptVisibleDecisionTargets(candidate.state, candidate.decision).includes(nextSenderId);
    });
    if (sourceOnly.length > 0) {
      return sourceOnly;
    }
    const resolvedCandidate = candidates.find((candidate) => {
      try {
        resolveScriptAgentId(candidate.state, nextMessageLine.sender);
        return true;
      } catch {
        return false;
      }
    });
    const nextSenderId = resolveScriptAgentId(
      resolvedCandidate ? resolvedCandidate.state : state,
      nextMessageLine.sender,
    );
    const preferredWaitingCandidates = preferWaitingDecisionCandidatesForPendingNextSender({
      candidates,
      nextSenderId,
    });
    if (preferredWaitingCandidates.length !== candidates.length) {
      return preferredWaitingCandidates;
    }
  }

  if (line.targets.length === 0) {
    const actualTargetGroups = candidates.map((candidate) =>
      resolveActualTransitionTargets(
        candidate.state,
        candidate.decision,
        senderId,
        candidate.result.routingKind === "triggered"
          ? {
              routingKind: "triggered",
              trigger: candidate.result.trigger,
            }
          : candidate.result.routingKind === "invalid"
            ? {
                routingKind: "invalid",
              }
            : {
                routingKind: "default",
              },
      )
    );
    const firstTargets = requireArrayItem(actualTargetGroups, 0, "第一组实际目标");
    const sameImmediateTargets = actualTargetGroups.every((targets) =>
      arraysEqual(targets, firstTargets)
    );
    if (sameImmediateTargets) {
      const preferredDefault = candidates.filter((candidate) =>
        candidate.result.routingKind === "default"
      );
      if (preferredDefault.length > 0) {
        return preferredDefault;
      }
    }
    return candidates;
  }

  const expectedTargets = line.targets.map((target) =>
    resolveScriptTargetNameForComparison(state, target)
  );
  const narrowed = candidates.filter((candidate) =>
    arraysEqual(
      resolveDeferredDecisionTargets(
        state,
        senderId,
        candidate.result.routingKind === "triggered"
          ? {
              routingKind: "triggered",
              trigger: candidate.result.trigger,
            }
          : {
              routingKind: "default",
            },
      ),
      expectedTargets,
    )
  );
  return narrowed.length > 0 ? narrowed : candidates;
}

export function matchesExpectedTransition(input: {
  line: Extract<ParsedScriptLine, { kind: "message" }>;
  nextLine: ParsedScriptLine | null;
  state: ReturnType<typeof createEmptyGraphTaskState>;
  routingDecision: GraphRoutingDecision;
  senderId: string;
  decisionAgent: boolean;
} & ScriptRoutingMeta): boolean {
  const deferredDecisionTargets = resolveDeferredDecisionTargets(
    input.state,
    input.senderId,
    input,
  );
  const hasHiddenDecisionTargets = input.routingDecision.type === "execute_batch"
    && getStrictHiddenDecisionTargets(input.state, input.routingDecision).length > 0;

  if (input.line.targets.length > 0) {
    const expectedTargets = input.line.targets.map((target) =>
      resolveScriptTargetNameForComparison(input.state, target)
    );
    if (input.routingDecision.type === "execute_batch") {
      if (hasHiddenDecisionTargets) {
        return false;
      }
      if (!isBatchSourceAgent(input.routingDecision.batch, input.senderId)) {
        return false;
      }
      const actualTargets = getScriptVisibleDecisionTargets(input.state, input.routingDecision);
      return arraysEqual(actualTargets, expectedTargets);
    }
    return false;
  }

  if (input.nextLine && input.nextLine.kind === "message") {
    if (isDispatchAssertionLine(input.nextLine)) {
      if (input.routingDecision.type !== "execute_batch") {
        return false;
      }
      if (hasHiddenDecisionTargets) {
        return false;
      }
      const expectedTargets = input.nextLine.targets.map((target) =>
        resolveScriptTargetNameForComparison(input.state, target)
      );
      return dispatchAssertionTargetsCovered(
        getScriptVisibleDecisionTargets(input.state, input.routingDecision),
        expectedTargets,
      );
    }
    if (input.decisionAgent && input.routingDecision.type === "execute_batch") {
      const executeBatchDecision = input.routingDecision;
      if (hasHiddenDecisionTargets) {
        return false;
      }
      const nextSenderId = resolveScriptAgentId(input.state, input.nextLine.sender);
      if (shouldRequireSourceDispatchAssertion({
        currentSenderId: input.senderId,
        decision: executeBatchDecision,
        nextSenderId,
      })) {
        return false;
      }
      const actualTargets = getScriptVisibleDecisionTargets(input.state, executeBatchDecision);
      if (isBatchSourceAgent(executeBatchDecision.batch, nextSenderId)) {
        return !actualTargets.includes(nextSenderId);
      }
      return actualTargets.includes(nextSenderId);
    }
    const nextSenderId = resolveScriptAgentId(input.state, input.nextLine.sender);
    if (
      input.routingDecision.type === "finished"
      && getPendingRuntimeSenders(input.state).includes(nextSenderId)
    ) {
      return true;
    }
  }

  if (deferredDecisionTargets.length > 0) {
    return false;
  }

  if (input.nextLine && input.nextLine.kind === "state" && input.nextLine.value === "finished") {
    return input.routingDecision.type === "finished";
  }

  if (input.nextLine && input.nextLine.kind === "message") {
    const nextSenderId = resolveScriptAgentId(input.state, input.nextLine.sender);
    if (
      input.routingDecision.type === "execute_batch"
      && (!isBatchSourceAgent(input.routingDecision.batch, input.senderId) || input.decisionAgent)
    ) {
      if (hasHiddenDecisionTargets) {
        return false;
      }
      return getScriptVisibleDecisionTargets(input.state, input.routingDecision).includes(nextSenderId);
    }
    return false;
  }

  if (!input.nextLine) {
    return input.routingDecision.type === "finished";
  }

  return false;
}

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => item === right[index]);
}

function resolveDeferredDecisionTargets(
  state: ReturnType<typeof createEmptyGraphTaskState>,
  senderId: string,
  routing: ScriptRoutingMeta,
): string[] {
  if (routing.routingKind !== "triggered") {
    return [];
  }

  const effectiveTopology = buildEffectiveTopology(state);
  return [...new Set(
    effectiveTopology.edges
      .filter((edge) => edge.source === senderId && edge.trigger === routing.trigger)
      .map((edge) => edge.target),
  )];
}

function resolveActualTransitionTargets(
  state: ReturnType<typeof createEmptyGraphTaskState>,
  decision: GraphRoutingDecision,
  senderId: string,
  routing: ScriptRoutingMeta,
): string[] {
  if (decision.type === "execute_batch") {
    return getScriptVisibleDecisionTargets(state, decision);
  }
  return resolveDeferredDecisionTargets(state, senderId, routing);
}

function resolveCandidateDecisionTriggers(
  state: ReturnType<typeof createEmptyGraphTaskState>,
  senderId: string,
): string[] {
  const topology = buildEffectiveTopology(state);
  return collectTopologyTriggerShapes({
    edges: topology.edges,
    endIncoming: topology.flow.end.incoming,
  })
    .filter((item) => item.source === senderId)
    .map((item) => item.trigger)
    .filter((trigger, index, list) => list.indexOf(trigger) === index);
}

function resolveAllowedDecisionTriggersForScript(
  state: ReturnType<typeof createEmptyGraphTaskState>,
  senderId: string,
): string[] {
  const topology = buildEffectiveTopology(state);
  return collectTopologyTriggerShapes({
    edges: topology.edges,
    endIncoming: topology.flow.end.incoming,
  })
    .filter((item) => item.source === senderId)
    .map((item) => item.trigger);
}

function resolveExplicitDecisionTriggerFromLine(
  content: string,
  allowedTriggers: readonly string[],
): ExplicitDecisionTrigger {
  const parsed = parseDecision(content, allowedTriggers);
  if (parsed.kind === "invalid") {
    return { kind: "invalid" };
  }
  return { kind: "matched", trigger: parsed.trigger };
}

function isDirectTransitionFromSender(
  senderId: string,
  decision: GraphRoutingDecision,
): boolean {
  return decision.type === "execute_batch"
    ? isBatchSourceAgent(decision.batch, senderId)
    : true;
}

function getScriptVisibleDecisionTargets(
  state: ReturnType<typeof createEmptyGraphTaskState>,
  decision: Extract<GraphRoutingDecision, { type: "execute_batch" }>,
): string[] {
  return decision.batch.jobs
    .map((job) => job.agentId)
    .filter((agentId) => !isImplicitScriptHiddenTarget(state, agentId));
}

function getStrictHiddenDecisionTargets(
  state: ReturnType<typeof createEmptyGraphTaskState>,
  decision: Extract<GraphRoutingDecision, { type: "execute_batch" }>,
): string[] {
  return decision.batch.jobs
    .map((job) => job.agentId)
    .filter((agentId) => isCompletedGroupRuntimeTarget(state, agentId));
}

function isImplicitScriptHiddenTarget(
  state: ReturnType<typeof createEmptyGraphTaskState>,
  agentId: string,
): boolean {
  return agentId === FLOW_END_NODE_ID || isCompletedGroupRuntimeTarget(state, agentId);
}

function isCompletedGroupRuntimeTarget(
  state: ReturnType<typeof createEmptyGraphTaskState>,
  agentId: string,
): boolean {
  const runtimeNode = state.runtimeNodes.find((node) => node.id === agentId);
  if (!runtimeNode) {
    return false;
  }
  const groupId = runtimeNode.groupId;
  return state.groupActivations.some((activation) =>
    activation.dispatched
    && activation.completedBundleGroupIds.includes(groupId),
  );
}
