import assert from "node:assert/strict";

import type { TopologyRecord } from "@shared/types";

import {
  applyAgentResultToGraphState,
  createGraphTaskState,
  createUserDispatchDecision,
  type GraphAgentResult,
  type GraphRoutingDecision,
} from "./gating-router";
import { buildEffectiveTopology } from "./runtime-topology-graph";
import { resolveExecutionReviewAgent } from "./review-agent-context";
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

interface RunSchedulerScriptEmulatorOptions {
  topology: TopologyRecord;
  script: string[];
}

type GraphTaskStateLike = ReturnType<typeof createGraphTaskState>;

interface SchedulerScriptTraceStep {
  lineIndex: number;
  line: ParsedScriptLine;
  senderId: string | null;
  beforeState: GraphTaskStateLike;
  beforeDecision: GraphRoutingDecision | null;
  afterState: GraphTaskStateLike;
  afterDecision: GraphRoutingDecision;
  beforeBatchId: string | null;
  afterBatchId: string | null;
  explicitDispatchKind: "inline_dispatch" | "dispatch_assertion" | null;
  explicitTargets: string[];
  consumedBatchId: string | null;
  consumedDispatchLineIndex: number | null;
}

interface SchedulerScriptTrace {
  topology: TopologyRecord;
  script: string[];
  lines: ParsedScriptLine[];
  steps: SchedulerScriptTraceStep[];
}

interface RequiredDispatchAssertion {
  lineIndex: number;
  senderId: string;
  targets: string[];
  kind: "inline_dispatch" | "dispatch_assertion";
  batchId: string | null;
}

interface RequiredConsumerMessage {
  dispatchLineIndex: number;
  consumerLineIndex: number;
  consumerAgentId: string;
  batchId: string;
}

interface SchedulerScriptNegativeVariant {
  kind: "missing_target" | "missing_dispatch_line" | "missing_consumer_line";
  sourceLineIndex: number;
  removedTarget: string | null;
  removedMessageLineIndex: number | null;
  script: string[];
  expectedFailureCategory: "dispatch_contract" | "consumer_contract";
}

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
  state: ReturnType<typeof createGraphTaskState>;
  decision: GraphRoutingDecision;
}): string {
  if (input.decision.type === "execute_batch") {
    return `脚本提前结束，当前还缺少 ${formatTargetList(getScriptVisibleDecisionTargets(input.state, input.decision))} 这批调度断言，调度状态为 ${describeDecision(input.decision)}`;
  }

  if (input.decision.type === "waiting") {
    const pendingTargets = getAllowedWaitingSendersFromCore(input.state, input.decision);
    if (pendingTargets.length > 0) {
      return `脚本提前结束，当前仍在等待 ${formatTargetList(pendingTargets)}，调度状态为 ${describeDecision(input.decision)}`;
    }
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
    && input.decision.batch.sourceAgentId === input.senderId;
}

export function canImplicitlyFinishScript(decision: GraphRoutingDecision): boolean {
  return decision.type === "finished";
}

export function canScriptEndAfterLastLine(input: {
  lastLine: ParsedScriptLine;
  decision: GraphRoutingDecision;
}): boolean {
  return canImplicitlyFinishScript(input.decision);
}

export function shouldRequireSourceDispatchAssertion(input: {
  currentSenderId: string;
  decision: GraphRoutingDecision;
  nextSenderId: string;
}): boolean {
  return input.decision.type === "execute_batch"
    && input.decision.batch.sourceAgentId !== null
    && input.decision.batch.sourceAgentId !== input.currentSenderId
    && input.decision.batch.jobs.every((job) => job.kind !== "continue_request")
    && input.decision.batch.jobs.some((job) => job.agentId === input.nextSenderId);
}

function collectActualTransitionTargets(input: {
  transitions: Array<{
    reviewDecision: GraphAgentResult["reviewDecision"];
    state: ReturnType<typeof createGraphTaskState>;
    decision: GraphRoutingDecision;
  }>;
  senderId: string;
}): string[] {
  return [
    ...new Set(
      input.transitions.flatMap((transition) =>
        resolveActualTransitionTargets(
          transition.state,
          transition.decision,
          input.senderId,
          transition.reviewDecision,
        )
      ),
    ),
  ];
}

export function getAllowedWaitingSendersFromCore(
  state: ReturnType<typeof createGraphTaskState>,
  _decision: Extract<GraphRoutingDecision, { type: "waiting" }>,
): string[] {
  return [
    ...new Set(
      Object.values(state.activeHandoffBatchBySource).flatMap((batch) => batch.pendingTargets),
    ),
  ];
}

export function preferCompleteReviewCandidatesForPendingNextSender<T extends {
  result: GraphAgentResult;
  state: ReturnType<typeof createGraphTaskState>;
  decision: GraphRoutingDecision;
}>(input: {
  candidates: T[];
  nextSenderId: string;
}): T[] {
  const waitingCandidates = input.candidates.filter((candidate) =>
    candidate.decision.type === "waiting"
    && getAllowedWaitingSendersFromCore(candidate.state, candidate.decision).includes(input.nextSenderId)
  );
  if (waitingCandidates.length === 0) {
    return input.candidates;
  }

  const preferredComplete = waitingCandidates.filter((candidate) =>
    candidate.result.reviewDecision === "complete"
  );
  return preferredComplete.length > 0 ? preferredComplete : waitingCandidates;
}

function createTraceBatchIdFactory() {
  let nextId = 1;
  const ids = new Map<GraphRoutingDecision, string>();

  return (decision: GraphRoutingDecision | null): string | null => {
    if (!decision || decision.type !== "execute_batch") {
      return null;
    }
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

async function runSchedulerScriptInternal(
  options: RunSchedulerScriptEmulatorOptions,
): Promise<SchedulerScriptTrace> {
  const lines = parseSchedulerScriptLines(options.script);
  const steps: SchedulerScriptTraceStep[] = [];
  const resolveBatchId = createTraceBatchIdFactory();
  // 这里只记录 trace 归因信息，方便把“某个 batch 来自哪条脚本行”映射回报错文案；
  // 真正的调度状态始终只来自 graph core 返回的 state / decision。
  const explicitDispatchOwnerByBatchId = new Map<string, number>();
  const latestExplicitBatchIdBySource = new Map<string, string>();

  const firstLine = lines[0];
  assert.notEqual(firstLine, undefined, "脚本不能为空");
  assert.equal(firstLine?.kind, "message", "第一条脚本必须是 user 消息");
  assert.equal(firstLine?.sender, "user", "第一条脚本必须是 user: @Agent ...");

  const initialTarget = extractLeadingMention(firstLine.body);
  assert.ok(initialTarget, "第一条 user 消息必须以 @Agent 开头");

  let state = createGraphTaskState({
    taskId: "scheduler-script-emulator",
    topology: options.topology,
  });
  let currentDecision = createUserDispatchDecision(state, {
    targetAgentId: initialTarget,
    content: stripLeadingMention(firstLine.body),
  });
  assertExecuteBatchTargets(currentDecision, [initialTarget], firstLine.raw);

  steps.push({
    lineIndex: 0,
    line: firstLine,
    senderId: "user",
    beforeState: state,
    beforeDecision: null,
    afterState: state,
    afterDecision: currentDecision,
    beforeBatchId: null,
    afterBatchId: resolveBatchId(currentDecision),
    explicitDispatchKind: null,
    explicitTargets: [],
    consumedBatchId: null,
    consumedDispatchLineIndex: null,
  });

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    assert.notEqual(line, undefined, `第 ${index + 1} 条脚本不存在`);
    const ensuredLine = line!;
    const beforeState = state;
    const beforeDecision = currentDecision;
    const beforeBatchId = resolveBatchId(beforeDecision);

    if (ensuredLine.kind === "state") {
      assert.equal(index, lines.length - 1, "state 行只能出现在脚本最后");
      assert.equal(currentDecision.type, "finished", `期望最终状态为 finished，实际是 ${describeDecision(currentDecision)}`);
      steps.push({
        lineIndex: index,
        line: ensuredLine,
        senderId: null,
        beforeState,
        beforeDecision,
        afterState: state,
        afterDecision: currentDecision,
        beforeBatchId,
        afterBatchId: resolveBatchId(currentDecision),
        explicitDispatchKind: null,
        explicitTargets: [],
        consumedBatchId: null,
        consumedDispatchLineIndex: null,
      });
      continue;
    }

    const senderId = resolveScriptAgentId(state, ensuredLine.sender);
    let consumedBatchId = beforeDecision.type === "execute_batch"
      && beforeDecision.batch.jobs.some((job) => job.agentId === senderId)
      ? beforeBatchId
      : null;
    if (consumedBatchId === null && beforeDecision.type === "waiting") {
      const matchedSourceIds = Object.values(beforeState.activeHandoffBatchBySource)
        .filter((batch) => batch.pendingTargets.includes(senderId))
        .map((batch) => batch.sourceAgentId);
      if (matchedSourceIds.length === 1) {
        consumedBatchId = latestExplicitBatchIdBySource.get(matchedSourceIds[0] ?? "") ?? null;
      }
    }
    const consumedDispatchLineIndex = consumedBatchId
      ? explicitDispatchOwnerByBatchId.get(consumedBatchId) ?? null
      : null;
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
        currentDecision.batch.sourceAgentId,
        senderId,
        `${ensuredLine.raw} 的 sender 不是当前调度批次的 source，实际 source 为 ${currentDecision.batch.sourceAgentId ?? "null"}`,
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
      if (beforeBatchId) {
        explicitDispatchOwnerByBatchId.set(beforeBatchId, index);
        const sourceAgentId = currentDecision.type === "execute_batch"
          ? currentDecision.batch.sourceAgentId
          : null;
        if (sourceAgentId) {
          latestExplicitBatchIdBySource.set(sourceAgentId, beforeBatchId);
        }
      }
      steps.push({
        lineIndex: index,
        line: ensuredLine,
        senderId,
        beforeState,
        beforeDecision,
        afterState: state,
        afterDecision: currentDecision,
        beforeBatchId,
        afterBatchId: beforeBatchId,
        explicitDispatchKind: "dispatch_assertion",
        explicitTargets: actualTargets,
        consumedBatchId,
        consumedDispatchLineIndex,
      });
      continue;
    }
    assertSenderAllowed(
      state,
      senderId,
      currentDecision,
      ensuredLine.raw,
    );

    const nextLine = lines[index + 1] ?? null;
    const reviewResolution = applyMessageLineAndMatchDecision({
      state,
      line: ensuredLine,
      senderId,
      topology: options.topology,
      nextLine,
    });

    state = reviewResolution.state;
    currentDecision = reviewResolution.decision;
    const explicitTargets = ensuredLine.targets.length > 0
      ? resolveActualTransitionTargets(
        reviewResolution.state,
        reviewResolution.decision,
        senderId,
        reviewResolution.reviewDecision,
      )
      : [];
    const afterBatchId = resolveBatchId(currentDecision);
    if (ensuredLine.targets.length > 0 && afterBatchId) {
      explicitDispatchOwnerByBatchId.set(afterBatchId, index);
      if (currentDecision.type === "execute_batch" && currentDecision.batch.sourceAgentId) {
        latestExplicitBatchIdBySource.set(currentDecision.batch.sourceAgentId, afterBatchId);
      }
    }
    steps.push({
      lineIndex: index,
      line: ensuredLine,
      senderId,
      beforeState,
      beforeDecision,
      afterState: state,
      afterDecision: currentDecision,
      beforeBatchId,
      afterBatchId,
      explicitDispatchKind: ensuredLine.targets.length > 0 ? "inline_dispatch" : null,
      explicitTargets,
      consumedBatchId,
      consumedDispatchLineIndex,
    });
  }

  const lastLine = lines[lines.length - 1]!;
  assert.equal(
    canScriptEndAfterLastLine({
      lastLine,
      decision: currentDecision,
    }),
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

export function collectRequiredDispatchAssertions(
  trace: SchedulerScriptTrace,
): RequiredDispatchAssertion[] {
  return trace.steps.flatMap((step) => {
    if (step.line.kind !== "message" || step.senderId === null || step.explicitDispatchKind === null) {
      return [];
    }

    return [{
      lineIndex: step.lineIndex,
      senderId: step.senderId,
      targets: [...step.explicitTargets],
      kind: step.explicitDispatchKind,
      batchId: step.explicitDispatchKind === "dispatch_assertion"
        ? step.beforeBatchId
        : step.afterBatchId,
    }];
  });
}

export function collectRequiredConsumerMessages(
  trace: SchedulerScriptTrace,
): RequiredConsumerMessage[] {
  const dispatchByBatchId = new Map<string, {
    lineIndex: number;
  }>();
  for (const dispatch of collectRequiredDispatchAssertions(trace)) {
    if (dispatch.batchId) {
      dispatchByBatchId.set(dispatch.batchId, {
        lineIndex: dispatch.lineIndex,
      });
    }
  }
  const initialStep = trace.steps[0];
  if (initialStep?.line.kind === "message" && initialStep.afterBatchId) {
    dispatchByBatchId.set(initialStep.afterBatchId, {
      lineIndex: initialStep.lineIndex,
    });
  }

  return trace.steps.flatMap((step) => {
    if (step.line.kind !== "message" || step.senderId === null || !step.consumedBatchId) {
      return [];
    }
    const dispatch = dispatchByBatchId.get(step.consumedBatchId);
    if (!dispatch) {
      return [];
    }

    return [{
      dispatchLineIndex: dispatch.lineIndex,
      consumerLineIndex: step.lineIndex,
      consumerAgentId: step.senderId,
      batchId: step.consumedBatchId,
    }];
  });
}

function buildMissingTargetVariant(input: {
  script: string[];
  lineIndex: number;
  removedTargetIndex: number;
  removedTarget: string;
}): SchedulerScriptNegativeVariant {
  const parsedLine = parseSchedulerScriptLine(input.script[input.lineIndex] ?? "");
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
    removedMessageLineIndex: null,
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
    removedTarget: null,
    removedMessageLineIndex: null,
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
    removedTarget: null,
    removedMessageLineIndex: input.removedMessageLineIndex,
    script: input.script.filter((_, index) => index !== input.removedMessageLineIndex),
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
    const parsedLine = parseSchedulerScriptLine(input.script[dispatch.lineIndex] ?? "");
    assert.equal(parsedLine.kind, "message", `第 ${dispatch.lineIndex + 1} 行必须是消息行`);
    parsedLine.targets.forEach((_, targetIndex) => {
      variants.push(buildMissingTargetVariant({
        script: input.script,
        lineIndex: dispatch.lineIndex,
        removedTargetIndex: targetIndex,
        removedTarget: dispatch.targets[targetIndex] ?? parsedLine.targets[targetIndex] ?? "",
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
    variants.push(buildMissingConsumerLineVariant({
      script: input.script,
      sourceLineIndex: consumer.dispatchLineIndex,
      removedMessageLineIndex: consumer.consumerLineIndex,
    }));
  }

  return variants;
}

function getAutoDerivedNegativeFailurePattern(
  variant: SchedulerScriptNegativeVariant,
): RegExp {
  if (variant.expectedFailureCategory === "consumer_contract") {
    return /脚本提前结束|当前仍在等待|当前还缺少|下一条回应 Agent 不匹配|脚本包含 \[|sender 不在当前 execute_batch 目标里|sender 不在当前等待中的 pending targets 里|无法继续推进|没有显式给出 @|并没有显式给出 @|调度目标不匹配/u;
  }

  return /调度目标不匹配|脚本包含 \[|没有显式给出 @|execute_batch|脚本提前结束|当前仍在等待|当前还缺少/u;
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
    await assert.rejects(
      runSchedulerScriptDrived({
        topology: options.topology,
        script: variant.script,
      }),
      getAutoDerivedNegativeFailurePattern(variant),
      `自动派生负例未按预期失败：${variant.kind} @ line ${variant.sourceLineIndex + 1}`,
    );
  }
}

function resolveScriptAgentId(
  state: ReturnType<typeof createGraphTaskState>,
  rawName: string,
): string {
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
  state: ReturnType<typeof createGraphTaskState>,
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
  state: ReturnType<typeof createGraphTaskState>,
  senderId: string,
  decision: GraphRoutingDecision,
  rawLine: string,
): void {
  if (decision.type === "execute_batch") {
    const actualTargets = decision.batch.jobs.map((job) => job.agentId);
    assert.ok(
      decision.batch.sourceAgentId === senderId
        || actualTargets.includes(senderId),
      buildUnexpectedNextSenderMessage({
        rawLine,
        actualSenderId: senderId,
        simulatedTargets: actualTargets,
      }),
    );
    return;
  }

  if (decision.type === "waiting") {
    const pendingTargets = getAllowedWaitingSendersFromCore(state, decision);
    assert.ok(
      pendingTargets.includes(senderId),
      buildUnexpectedNextSenderMessage({
        rawLine,
        actualSenderId: senderId,
        simulatedTargets: pendingTargets,
      }),
    );
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
  if (decision.type === "waiting") {
    return `waiting -> ${decision.waitingReason}`;
  }
  if (decision.type === "failed") {
    return `failed -> ${decision.errorMessage}`;
  }
  return decision.type;
}

function describeDecisionWithVisibleTargets(
  state: ReturnType<typeof createGraphTaskState>,
  decision: GraphRoutingDecision,
): string {
  if (decision.type === "execute_batch") {
    return `execute_batch -> [${getScriptVisibleDecisionTargets(state, decision).join(", ")}]`;
  }
  return describeDecision(decision);
}

function applyMessageLineAndMatchDecision(input: {
  state: ReturnType<typeof createGraphTaskState>;
  line: Extract<ParsedScriptLine, { kind: "message" }>;
  senderId: string;
  topology: TopologyRecord;
  nextLine: ParsedScriptLine | null;
}): {
  state: ReturnType<typeof createGraphTaskState>;
  decision: GraphRoutingDecision;
  reviewDecision: GraphAgentResult["reviewDecision"];
} {
  const executableAgentId = input.senderId;
  const reviewAgent = resolveExecutionReviewAgent({
    state: input.state,
    topology: input.topology,
    runtimeAgentId: input.senderId,
    executableAgentId,
  });

  const candidateDecisions = reviewAgent ? (["continue", "complete"] as const) : (["complete"] as const);
  const matchedCandidates: Array<{
    result: GraphAgentResult;
    state: ReturnType<typeof createGraphTaskState>;
    decision: GraphRoutingDecision;
  }> = [];
  const attemptedTransitions: Array<{
    reviewDecision: GraphAgentResult["reviewDecision"];
    state: ReturnType<typeof createGraphTaskState>;
    decision: GraphRoutingDecision;
  }> = [];
  const attemptedDecisions: string[] = [];

  for (const reviewDecision of candidateDecisions) {
    const result: GraphAgentResult = {
      agentId: input.senderId,
      status: "completed",
      reviewAgent,
      reviewDecision,
      // 在顺序脚本 DSL 里，每一条 agent 发言都代表“一次已完成的回复”，
      // 路由是否继续由 reviewDecision 决定，不再把 agentStatus 继续保留成 continue，
      // 否则已完成的旧 spawn runtime 会在后续 finding 中再次混入目标集合。
      agentStatus: "completed",
      agentContextContent: input.line.body,
      opinion: null,
      allowDirectFallbackWhenNoBatch: false,
      signalDone: false,
    };
    const reduced = applyAgentResultToGraphState(input.state, result);
    attemptedTransitions.push({
      reviewDecision,
      state: reduced.state,
      decision: reduced.decision,
    });
    attemptedDecisions.push(
      `${reviewDecision}:${describeDecisionWithVisibleTargets(reduced.state, reduced.decision)}`,
    );
    if (!matchesExpectedTransition({
      line: input.line,
      nextLine: input.nextLine,
      state: reduced.state,
      decision: reduced.decision,
      senderId: input.senderId,
      reviewDecision,
      reviewAgent,
    })) {
      continue;
    }

    matchedCandidates.push({
      result,
      state: reduced.state,
      decision: reduced.decision,
    });
  }

  const disambiguatedCandidates = disambiguateReviewCandidates({
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
            transition.reviewDecision,
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
      input.nextLine?.kind === "message"
      && attemptedTransitions.length > 0
      && attemptedTransitions.every((transition) =>
        transition.decision.type === "finished"
        || (transition.decision.type === "waiting" && transition.decision.waitingReason !== "wait_pending_reviewers")
      )
    ) {
      assert.fail(
        `${input.line.raw} 之后脚本继续写了 @${input.nextLine.sender}，但前一条消息并没有显式给出 @${input.nextLine.sender} 这条继续调度。实际候选为 [${attemptedDecisions.join("; ")}]`,
      );
    }
    assert.fail(
      `${input.line.raw} 的 review 决策无法唯一推断，匹配数量为 0。实际候选为 [${attemptedDecisions.join("; ")}]`,
    );
  }

  assert.equal(
    disambiguatedCandidates.length,
    1,
    `${input.line.raw} 的 review 决策无法唯一推断。实际候选为 [${attemptedDecisions.join("; ")}]`,
  );

  const chosen = disambiguatedCandidates[0]!;
  if (
    chosen.result.reviewDecision === "continue"
    && chosen.decision.type === "waiting"
    && input.line.targets.length === 0
  ) {
    const deferredTargets = resolveDeferredReviewTargets(
      chosen.state,
      input.senderId,
      chosen.result.reviewDecision,
    );
    if (deferredTargets.length > 0) {
      assert.fail(
        buildMissingDispatchTargetsMessage({
          rawLine: input.line.raw,
          scriptTargets: [],
          simulatedTargets: deferredTargets,
        }),
      );
    }
  }
  if (input.line.targets.length > 0) {
    const expectedTargets = input.line.targets.map((target) =>
      resolveScriptTargetNameForComparison(chosen.state, target)
    );
    const actualTargets = chosen.decision.type === "execute_batch"
      ? getScriptVisibleDecisionTargets(chosen.state, chosen.decision)
      : resolveDeferredReviewTargets(chosen.state, input.senderId, chosen.result.reviewDecision);
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

  if (chosen.decision.type === "execute_batch") {
    return {
      state: chosen.state,
      decision: chosen.decision,
      reviewDecision: chosen.result.reviewDecision,
    };
  }

  return {
    state: chosen.state,
    decision: chosen.decision,
    reviewDecision: chosen.result.reviewDecision,
  };
}

function disambiguateReviewCandidates<T extends {
  result: GraphAgentResult;
  state: ReturnType<typeof createGraphTaskState>;
  decision: GraphRoutingDecision;
}>(input: {
  candidates: T[];
  line: Extract<ParsedScriptLine, { kind: "message" }>;
  state: ReturnType<typeof createGraphTaskState>;
  senderId: string;
  nextLine: ParsedScriptLine | null;
}): T[] {
  const { candidates, line, state, senderId, nextLine } = input;
  if (candidates.length <= 1) {
    return candidates;
  }

  if (nextLine?.kind === "message" && !isDispatchAssertionLine(nextLine)) {
    const nextSenderId = resolveScriptAgentId(state, nextLine.sender);
    const sourceOnly = candidates.filter((candidate) =>
      candidate.decision.type === "execute_batch"
      && candidate.decision.batch.sourceAgentId === nextSenderId
      && !getScriptVisibleDecisionTargets(candidate.state, candidate.decision).includes(nextSenderId)
    );
    if (sourceOnly.length > 0) {
      return sourceOnly;
    }
    const preferredWaitingCandidates = preferCompleteReviewCandidatesForPendingNextSender({
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
        candidate.result.reviewDecision,
      )
    );
    const firstTargets = actualTargetGroups[0] ?? [];
    const sameImmediateTargets = actualTargetGroups.every((targets) =>
      arraysEqual(targets, firstTargets)
    );
    if (sameImmediateTargets) {
      const preferredComplete = candidates.filter((candidate) =>
        candidate.result.reviewDecision === "complete"
      );
      if (preferredComplete.length > 0) {
        return preferredComplete;
      }
    }
    return candidates;
  }

  const expectedTargets = line.targets.map((target) =>
    resolveScriptTargetNameForComparison(state, target)
  );
  const narrowed = candidates.filter((candidate) =>
    arraysEqual(
      resolveDeferredReviewTargets(state, senderId, candidate.result.reviewDecision),
      expectedTargets,
    )
  );
  return narrowed.length > 0 ? narrowed : candidates;
}

export function matchesExpectedTransition(input: {
  line: Extract<ParsedScriptLine, { kind: "message" }>;
  nextLine: ParsedScriptLine | null;
  state: ReturnType<typeof createGraphTaskState>;
  decision: GraphRoutingDecision;
  senderId: string;
  reviewDecision: GraphAgentResult["reviewDecision"];
  reviewAgent: boolean;
}): boolean {
  const deferredReviewTargets = resolveDeferredReviewTargets(
    input.state,
    input.senderId,
    input.reviewDecision,
  );

  if (input.line.targets.length > 0) {
    const expectedTargets = input.line.targets.map((target) =>
      resolveScriptTargetNameForComparison(input.state, target)
    );
    if (input.decision.type === "execute_batch") {
      if (input.decision.batch.sourceAgentId !== input.senderId) {
        return false;
      }
      const actualTargets = getScriptVisibleDecisionTargets(input.state, input.decision);
      return arraysEqual(actualTargets, expectedTargets);
    }
    return input.decision.type === "waiting"
      && deferredReviewTargets.length > 0
      && arraysEqual(expectedTargets, deferredReviewTargets);
  }

  if (input.nextLine?.kind === "message") {
    if (isDispatchAssertionLine(input.nextLine)) {
      if (input.decision.type !== "execute_batch") {
        return false;
      }
      const expectedTargets = input.nextLine.targets.map((target) =>
        resolveScriptTargetNameForComparison(input.state, target)
      );
      return dispatchAssertionTargetsCovered(
        getScriptVisibleDecisionTargets(input.state, input.decision),
        expectedTargets,
      );
    }
    if (input.reviewAgent && input.decision.type === "execute_batch") {
      const nextSenderId = resolveScriptAgentId(input.state, input.nextLine.sender);
      if (shouldRequireSourceDispatchAssertion({
        currentSenderId: input.senderId,
        decision: input.decision,
        nextSenderId,
      })) {
        return false;
      }
      const actualTargets = getScriptVisibleDecisionTargets(input.state, input.decision);
      if (input.decision.batch.sourceAgentId === nextSenderId) {
        return !actualTargets.includes(nextSenderId);
      }
      return actualTargets.includes(nextSenderId);
    }
  }

  if (deferredReviewTargets.length > 0) {
    return false;
  }

  if (input.nextLine?.kind === "state" && input.nextLine.value === "finished") {
    return input.decision.type === "finished";
  }

  if (input.nextLine?.kind === "message") {
    const nextSenderId = resolveScriptAgentId(input.state, input.nextLine.sender);
    if (input.decision.type === "waiting") {
      return getAllowedWaitingSendersFromCore(input.state, input.decision).includes(nextSenderId);
    }
    if (
      input.decision.type === "execute_batch"
      && (input.decision.batch.sourceAgentId !== input.senderId || input.reviewAgent)
    ) {
      return getScriptVisibleDecisionTargets(input.state, input.decision).includes(nextSenderId);
    }
    return false;
  }

  if (input.nextLine === null) {
    return input.decision.type === "finished"
      || (input.decision.type === "waiting" && input.decision.waitingReason === "no_runnable_agents");
  }

  return false;
}

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => item === right[index]);
}

function resolveDeferredReviewTargets(
  state: ReturnType<typeof createGraphTaskState>,
  senderId: string,
  reviewDecision: GraphAgentResult["reviewDecision"],
): string[] {
  const triggerOn = reviewDecision === "continue"
    ? "continue"
    : reviewDecision === "complete"
      ? "complete"
      : null;
  if (!triggerOn) {
    return [];
  }

  const effectiveTopology = buildEffectiveTopology(state);
  return [...new Set(
    effectiveTopology.edges
      .filter((edge) => edge.source === senderId && edge.triggerOn === triggerOn)
      .map((edge) => edge.target),
  )];
}

function resolveActualTransitionTargets(
  state: ReturnType<typeof createGraphTaskState>,
  decision: GraphRoutingDecision,
  senderId: string,
  reviewDecision: GraphAgentResult["reviewDecision"],
): string[] {
  if (decision.type === "execute_batch") {
    return getScriptVisibleDecisionTargets(state, decision);
  }
  return resolveDeferredReviewTargets(state, senderId, reviewDecision);
}

function isDirectTransitionFromSender(
  senderId: string,
  decision: GraphRoutingDecision,
): boolean {
  return decision.type === "execute_batch"
    ? decision.batch.sourceAgentId === senderId
    : true;
}

function getScriptVisibleDecisionTargets(
  state: ReturnType<typeof createGraphTaskState>,
  decision: Extract<GraphRoutingDecision, { type: "execute_batch" }>,
): string[] {
  return decision.batch.jobs
    .map((job) => job.agentId)
    .filter((agentId) => !isCompletedSpawnRuntimeTarget(state, agentId));
}

function isCompletedSpawnRuntimeTarget(
  state: ReturnType<typeof createGraphTaskState>,
  agentId: string,
): boolean {
  const runtimeNode = state.runtimeNodes.find((node) => node.id === agentId);
  if (!runtimeNode?.groupId) {
    return false;
  }
  return state.spawnActivations.some((activation) =>
    activation.dispatched
    && activation.completedBundleGroupIds.includes(runtimeNode.groupId ?? ""),
  );
}
