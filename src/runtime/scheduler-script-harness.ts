import assert from "node:assert/strict";
import { extractTrailingReviewSignalBlock } from "@shared/review-response";

import {DEFAULT_ACTION_REQUIRED_MAX_ROUNDS, type TopologyEdgeTrigger, type TopologyRecord,} from "@shared/types";

interface ParsedScriptLine {
  sender: string;
  content: string;
  normalized: string;
}

interface ParsedReply {
  sender: string;
  content: string;
  body: string;
  targets: string[];
  normalized: string;
}

interface SourceState {
  defaultTargets: string[];
  currentRevision: number;
  reviewerPassRevision: Map<string, number>;
  expectedNextAction: ExpectedNextAction | null;
}

interface BatchResponse {
  agent: string;
  outcome: "pass" | "fail";
  loopLimitExceeded: boolean;
  escalationDispatched: boolean;
}

interface ActiveBatch {
  source: string;
  targets: string[];
  canonicalTargets: string[];
  canonicalTargetByActual: Map<string, string>;
  remainingTargets: string[];
  responses: BatchResponse[];
  sourceRevision: number;
  sourceHadBody: boolean;
}

interface ParsedScenario {
  normalizedScript: string[];
  startAgent: string;
  lines: ParsedScriptLine[];
  repliesByAgent: Map<string, ParsedReply[]>;
  agentOrder: string[];
  resolver: AgentRefResolver;
}

type ExpectedNextAction =
  | {
      kind: "repair";
      targets: string[];
      reviewerAgentId: string;
      repairTargetAgentId: string;
    }
  | {
      kind: "redispatch";
      targets: string[];
    };

interface AssertSchedulerScriptOptions {
  topology: TopologyRecord;
  script: string[];
  expectedDecisions?: SchedulerScriptDecision[];
}

type SchedulerScriptDecision =
  | {
      type: "execute_batch";
      sourceAgentId: string | null;
      targets: string[];
    }
  | {
      type: "waiting";
      waitingReason: string;
    }
  | {
      type: "finished";
    };

interface DynamicSpawnAgentRef {
  key: string;
  spawnNodeName: string;
  spawnRuleId: string;
  templateName: string;
  role: string;
  index: number;
  sourceTemplateName: string | null;
  reportToTemplateName: string | null;
  reportToTriggerOn: TopologyEdgeTrigger;
  isEntry: boolean;
}

interface SpawnRuleState {
  ruleId: string;
  spawnNodeName: string;
  sourceTemplateName: string | null;
  reportToTemplateName: string | null;
  reportToTriggerOn: TopologyEdgeTrigger;
  entryRole: string;
  entryTemplateName: string | null;
  roleToTemplate: Map<string, string>;
  templateToRole: Map<string, string>;
  edges: Array<{
    sourceRole: string;
    targetRole: string;
    triggerOn: TopologyEdgeTrigger;
  }>;
  terminalRoles: string[];
}

interface AgentRefResolver {
  resolve(name: string): string;
  isKnown(agentId: string): boolean;
  getDynamicRef(agentId: string): DynamicSpawnAgentRef | null;
  getHandoffTargets(agentId: string): string[];
  getTriggeredTargets(agentId: string, triggerOn: "continue" | "complete"): string[];
  hasAnyOutgoingTargets(agentId: string): boolean;
  hasOutgoingTarget(sourceAgentId: string, targetAgentId: string): boolean;
  getReviewFailLoopLimit(sourceAgentId: string, targetAgentId: string): number;
  findNextPendingRepairReviewer(
    repairTargetAgentId: string,
    excludeReviewerAgentId: string,
    pendingReviewerIds: Iterable<string>,
  ): string | null;
  matchCanonicalTargets(
    sourceAgentId: string,
    actualTargets: string[],
    canonicalTargets: string[],
    triggerOn: "transfer" | "continue" | "complete",
  ): string[] | null;
}

export async function assertSchedulerScript(
  options: AssertSchedulerScriptOptions,
): Promise<void> {
  const parsed = parseScenario(options.topology, options.script);
  const expectedDecisions = options.expectedDecisions ?? null;
  const sourceStates = new Map<string, SourceState>();
  const ensureSourceState = (agentId: string): SourceState => {
    const existing = sourceStates.get(agentId);
    if (existing) {
      return existing;
    }
    const created: SourceState = {
      defaultTargets: parsed.resolver.getHandoffTargets(agentId),
      currentRevision: 0,
      reviewerPassRevision: new Map(),
      expectedNextAction: null,
    };
    sourceStates.set(agentId, created);
    return created;
  };
  for (const agentId of parsed.agentOrder) {
    ensureSourceState(agentId);
  }

  const actualScript: string[] = [];
  const actualDecisions: SchedulerScriptDecision[] = [];
  const replyIndexByAgent = new Map<string, number>();
  const activeBatches: ActiveBatch[] = [];
  const actionRequiredLoopCountByEdge = new Map<string, number>();
  const spawnEntryDispatchCountBySourceAndNode = new Map<string, number>();

  const appendLine = (line: string) => {
    actualScript.push(line);
    const expected = parsed.normalizedScript[actualScript.length - 1];
    assert.equal(line, expected, `第 ${actualScript.length} 条脚本不匹配`);
  };
  const appendDecision = (decision: SchedulerScriptDecision) => {
    actualDecisions.push(decision);
    if (!expectedDecisions) {
      return;
    }
    const expected = expectedDecisions[actualDecisions.length - 1];
    assert.notEqual(expected, undefined, `第 ${actualDecisions.length} 个调度决策超出了 expectedDecisions`);
    assert.deepEqual(decision, expected, `第 ${actualDecisions.length} 个调度决策不匹配`);
  };
  const canonicalizeDispatchTargets = (sourceAgentId: string, actualTargets: string[]): string[] => {
    const sourceState = ensureSourceState(sourceAgentId);
    const directReviewFailTargets = parsed.resolver.getTriggeredTargets(sourceAgentId, "continue");
    const directReviewPassTargets = parsed.resolver.getTriggeredTargets(sourceAgentId, "complete");
    return parsed.resolver.matchCanonicalTargets(
      sourceAgentId,
      actualTargets,
      sourceState.defaultTargets,
      "transfer",
    )
      ?? parsed.resolver.matchCanonicalTargets(
        sourceAgentId,
        actualTargets,
        directReviewFailTargets,
        "continue",
      )
      ?? parsed.resolver.matchCanonicalTargets(
        sourceAgentId,
        actualTargets,
        directReviewPassTargets,
        "complete",
      )
      ?? actualTargets;
  };
  const assertSpawnEntryDispatchOrder = (
    sourceAgentId: string,
    actualTargets: string[],
    canonicalTargets: string[],
  ): void => {
    for (const [index, target] of actualTargets.entries()) {
      const dynamicRef = parsed.resolver.getDynamicRef(target);
      const canonicalTarget = canonicalTargets[index] ?? "";
      if (!dynamicRef || !dynamicRef.isEntry || canonicalTarget !== dynamicRef.spawnNodeName) {
        continue;
      }
      const dispatchKey = `${sourceAgentId}::${dynamicRef.spawnNodeName}`;
      const nextExpectedIndex = (spawnEntryDispatchCountBySourceAndNode.get(dispatchKey) ?? 0) + 1;
      assert.equal(
        dynamicRef.index,
        nextExpectedIndex,
        `${sourceAgentId} 第 ${nextExpectedIndex} 次派发 ${dynamicRef.spawnNodeName} 时，应启动 ${dynamicRef.templateName}-${nextExpectedIndex}，实际却是 ${dynamicRef.templateName}-${dynamicRef.index}`,
      );
      spawnEntryDispatchCountBySourceAndNode.set(dispatchKey, nextExpectedIndex);
    }
  };

  const getNextReply = (agentId: string): ParsedReply => {
    const currentIndex = replyIndexByAgent.get(agentId) ?? 0;
    const replies = parsed.repliesByAgent.get(agentId) ?? [];
    const reply = replies[currentIndex];
    assert.notEqual(reply, undefined, `脚本里缺少 ${agentId} 第 ${currentIndex + 1} 轮回复`);
    replyIndexByAgent.set(agentId, currentIndex + 1);
    return reply!;
  };
  const buildNextDecision = (lastResponder: string, lastReplyContent?: string): SchedulerScriptDecision => {
    if (activeBatches.length > 0) {
      return {
        type: "waiting",
        waitingReason: "wait_pending_reviewers",
      };
    }

    const nextExpectedSources = [...sourceStates.entries()]
      .filter(([, state]) => state.expectedNextAction && state.expectedNextAction.targets.length > 0)
      .map(([agentId]) => agentId);
    if (nextExpectedSources.length > 0) {
      assert.equal(nextExpectedSources.length, 1, "同一时刻只能有一个 Source 等待下一轮修复/剩余派发");
      const nextSource = nextExpectedSources[0] ?? "";
      const expectedAction = ensureSourceState(nextSource).expectedNextAction;
      assert.notEqual(expectedAction, null, `${nextSource} 缺少 expectedNextAction`);
      if (expectedAction?.kind === "repair") {
        return {
          type: "execute_batch",
          sourceAgentId: expectedAction.reviewerAgentId,
          targets: [expectedAction.repairTargetAgentId],
        };
      }
      return {
        type: "execute_batch",
        sourceAgentId: nextSource,
        targets: [...(expectedAction?.targets ?? [])],
      };
    }

    if (shouldFinishFromEndEdge(options.topology, lastResponder, lastReplyContent)) {
      return {
        type: "finished",
      };
    }

    if (!parsed.resolver.hasAnyOutgoingTargets(lastResponder)) {
      return {
        type: "finished",
      };
    }

    return {
      type: "waiting",
      waitingReason: "no_runnable_agents",
    };
  };

  const finalizeBatchIfPossible = () => {
    while (activeBatches.length > 0) {
      const current = activeBatches[activeBatches.length - 1];
      if (!current || current.remainingTargets.length > 0) {
        return;
      }

      activeBatches.pop();
      const sourceState = ensureSourceState(current.source);
      const firstFailed = current.canonicalTargets
        .map((canonicalTarget) =>
          current.responses.find(
            (item) =>
              item.outcome === "fail"
              && (current.canonicalTargetByActual.get(item.agent) ?? item.agent) === canonicalTarget,
          ) ?? null)
        .find((item) => item !== null) ?? null;
      if (firstFailed) {
        if (firstFailed.loopLimitExceeded) {
          if (firstFailed.escalationDispatched) {
            sourceState.expectedNextAction = null;
            continue;
          }
          const escalationTargets = parsed.resolver.getTriggeredTargets(firstFailed.agent, "complete");
          assert.ok(
            escalationTargets.length > 0,
            `${firstFailed.agent} -> ${current.source} 连续回流已超过 ${parsed.resolver.getReviewFailLoopLimit(firstFailed.agent, current.source)} 轮上限`,
          );
          ensureSourceState(firstFailed.agent).expectedNextAction = {
            kind: "redispatch",
            targets: escalationTargets,
          };
          sourceState.expectedNextAction = null;
          continue;
        }
        sourceState.expectedNextAction = {
          kind: "repair",
          targets: [firstFailed.agent],
          reviewerAgentId: firstFailed.agent,
          repairTargetAgentId: current.source,
        };
        continue;
      }

      if (current.sourceHadBody && current.canonicalTargets.length === 1) {
        const currentReviewer = current.canonicalTargets[0] ?? "";
        const currentReviewerIndex = sourceState.defaultTargets.indexOf(currentReviewer);
        const trailingTargets = currentReviewerIndex >= 0
          ? sourceState.defaultTargets.slice(currentReviewerIndex + 1)
          : [];
        const leadingStaleTargets = (currentReviewerIndex >= 0
          ? sourceState.defaultTargets.slice(0, currentReviewerIndex)
          : sourceState.defaultTargets
        ).filter(
          (target) => sourceState.reviewerPassRevision.get(target) !== sourceState.currentRevision,
        );
        const staleTargets = [...trailingTargets, ...leadingStaleTargets];
        sourceState.expectedNextAction = staleTargets.length > 0
          ? {
              kind: "redispatch",
              targets: staleTargets,
            }
          : null;
        continue;
      }

      sourceState.expectedNextAction = null;
    }
  };

  const processReplyLine = (agentId: string): void => {
    const reply = getNextReply(agentId);
    const currentBatch = activeBatches[activeBatches.length - 1] ?? null;
    const normalizedReplyTargets = reply.targets.map((target) => parsed.resolver.resolve(target));
    let nextDecision: SchedulerScriptDecision | null = null;

    if (currentBatch) {
      const responderIndex = currentBatch.remainingTargets.indexOf(agentId);
      assert.notEqual(
        responderIndex,
        -1,
        `${agentId} 不是当前批次 ${currentBatch.source} 等待中的 reviewer`,
      );
      currentBatch.remainingTargets.splice(responderIndex, 1);
    } else {
      const sourceState = ensureSourceState(agentId);
      const expectedAction = sourceState.expectedNextAction;
      const expectedTargets = expectedAction?.targets ?? null;
      if (expectedTargets) {
        const expectedRepairTarget = expectedAction?.kind === "repair"
          ? expectedAction.reviewerAgentId
          : expectedTargets.length === 1 ? expectedTargets[0] ?? "" : "";
        const approvedTargets = parsed.resolver.getTriggeredTargets(agentId, "complete");
        const expectedEscalation = expectedRepairTarget
          && approvedTargets.length > 0
          && (actionRequiredLoopCountByEdge.get(buildReviewFailLoopEdgeKey(agentId, expectedRepairTarget)) ?? 0)
            >= parsed.resolver.getReviewFailLoopLimit(agentId, expectedRepairTarget)
          && Boolean(
            normalizedReplyTargets.length > 0
            && parsed.resolver.matchCanonicalTargets(
              agentId,
              normalizedReplyTargets,
              approvedTargets,
              "complete",
            ),
          );
        if (!expectedEscalation) {
          assert.deepEqual(
            normalizedReplyTargets,
            expectedTargets,
            `${agentId} 的 @ 目标与预期不一致`,
          );
        }
      } else if (normalizedReplyTargets.length > 0) {
        const directReviewFailTargets = parsed.resolver.getTriggeredTargets(agentId, "continue");
        const directReviewPassTargets = parsed.resolver.getTriggeredTargets(agentId, "complete");
        const matchesHandoffTargets = parsed.resolver.matchCanonicalTargets(
          agentId,
          normalizedReplyTargets,
          sourceState.defaultTargets,
          "transfer",
        );
        const matchesDirectReviewFailTargets = parsed.resolver.matchCanonicalTargets(
          agentId,
          normalizedReplyTargets,
          directReviewFailTargets,
          "continue",
        );
        const matchesDirectReviewPassTargets = parsed.resolver.matchCanonicalTargets(
          agentId,
          normalizedReplyTargets,
          directReviewPassTargets,
          "complete",
        );
        assert.equal(
          Boolean(matchesHandoffTargets || matchesDirectReviewFailTargets || matchesDirectReviewPassTargets),
          true,
          `${agentId} 的初始/全量派发目标必须等于 topology.handoff 默认顺序，或匹配其 direct complete / continue 下游`,
        );
      }
    }

    appendLine(reply.normalized);

    if (!currentBatch) {
      const sourceState = ensureSourceState(agentId);
      const expectedNextAction = sourceState.expectedNextAction;
      sourceState.expectedNextAction = null;

      if (normalizedReplyTargets.length === 0) {
        appendDecision(buildNextDecision(agentId, reply.content));
        return;
      }

      if (reply.body) {
        sourceState.currentRevision += 1;
      }

      for (const target of normalizedReplyTargets) {
        assert.ok(
          parsed.resolver.hasOutgoingTarget(agentId, target),
          `脚本里的派发 ${agentId}: @${target} 没有对应的拓扑边`,
        );
      }

      const canonicalTargets = expectedNextAction
        ? expectedNextAction.targets
        : canonicalizeDispatchTargets(agentId, normalizedReplyTargets);
      assertSpawnEntryDispatchOrder(agentId, normalizedReplyTargets, canonicalTargets);

      activeBatches.push({
        source: agentId,
        targets: [...normalizedReplyTargets],
        canonicalTargets: [...canonicalTargets],
        canonicalTargetByActual: new Map(
          normalizedReplyTargets.map((target, index) => [target, canonicalTargets[index] ?? target]),
        ),
        remainingTargets: [...normalizedReplyTargets],
        responses: [],
        sourceRevision: sourceState.currentRevision,
        sourceHadBody: reply.body.length > 0,
      });
      appendDecision({
        type: "execute_batch",
        sourceAgentId: agentId,
        targets: [...normalizedReplyTargets],
      });
      return;
    }

    const currentSource = currentBatch.source;
    const failTargets = parsed.resolver.getTriggeredTargets(agentId, "continue");
    const approvedTargets = parsed.resolver.getTriggeredTargets(agentId, "complete");
    const loopEdgeKey = buildReviewFailLoopEdgeKey(agentId, currentSource);
    const currentLoopCount = actionRequiredLoopCountByEdge.get(loopEdgeKey) ?? 0;
    const actionRequiredLoopLimit = parsed.resolver.getReviewFailLoopLimit(agentId, currentSource);
    const isFail = normalizedReplyTargets.length === 1
      && normalizedReplyTargets[0] === currentSource
      && failTargets.includes(currentSource);
    const isLoopLimitEscalation = !isFail
      && normalizedReplyTargets.length > 0
      && approvedTargets.length > 0
      && failTargets.includes(currentSource)
      && currentLoopCount >= actionRequiredLoopLimit
      && Boolean(
        parsed.resolver.matchCanonicalTargets(
          agentId,
          normalizedReplyTargets,
          approvedTargets,
          "complete",
        ),
      );

    currentBatch.responses.push({
      agent: agentId,
      outcome: isFail || isLoopLimitEscalation ? "fail" : "pass",
      loopLimitExceeded: isLoopLimitEscalation,
      escalationDispatched: isLoopLimitEscalation,
    });

    if (!isFail && !isLoopLimitEscalation) {
      clearReviewFailLoopCountsForReviewer(actionRequiredLoopCountByEdge, agentId);
      const sourceState = ensureSourceState(currentSource);
      const canonicalTarget = currentBatch.canonicalTargetByActual.get(agentId) ?? agentId;
      sourceState.reviewerPassRevision.set(canonicalTarget, currentBatch.sourceRevision);
    } else {
      const nextLoopCount = (actionRequiredLoopCountByEdge.get(loopEdgeKey) ?? 0) + 1;
      actionRequiredLoopCountByEdge.set(loopEdgeKey, nextLoopCount);
      const loopLimitExceeded = isLoopLimitEscalation || nextLoopCount > actionRequiredLoopLimit;
      const latestResponse = currentBatch.responses[currentBatch.responses.length - 1];
      if (latestResponse) {
        latestResponse.loopLimitExceeded = loopLimitExceeded;
      }
      if (loopLimitExceeded) {
        const pendingReviewerIds = currentBatch.responses
          .filter((response) => response.outcome === "fail" && response.agent !== agentId)
          .map((response) => response.agent);
        const nextPendingReviewer = parsed.resolver.findNextPendingRepairReviewer(
          currentSource,
          agentId,
          pendingReviewerIds,
        );
        if (!nextPendingReviewer) {
          assert.ok(
            approvedTargets.length > 0,
            `${agentId} -> ${currentSource} 连续回流已超过 ${actionRequiredLoopLimit} 轮上限`,
          );
        }
      }
    }

    if ((!isFail || isLoopLimitEscalation) && normalizedReplyTargets.length > 0) {
      for (const target of normalizedReplyTargets) {
        assert.ok(
          parsed.resolver.hasOutgoingTarget(agentId, target),
          `脚本里的派发 ${agentId}: @${target} 没有对应的拓扑边`,
        );
      }

      const nestedSourceState = ensureSourceState(agentId);
      if (reply.body) {
        nestedSourceState.currentRevision += 1;
      }
      nestedSourceState.expectedNextAction = null;
      const canonicalTargets = canonicalizeDispatchTargets(agentId, normalizedReplyTargets);
      assertSpawnEntryDispatchOrder(agentId, normalizedReplyTargets, canonicalTargets);

      activeBatches.push({
        source: agentId,
        targets: [...normalizedReplyTargets],
        canonicalTargets: [...canonicalTargets],
        canonicalTargetByActual: new Map(
          normalizedReplyTargets.map((target, index) => [target, canonicalTargets[index] ?? target]),
        ),
        remainingTargets: [...normalizedReplyTargets],
        responses: [],
        sourceRevision: nestedSourceState.currentRevision,
        sourceHadBody: reply.body.length > 0,
      });
      nextDecision = {
        type: "execute_batch",
        sourceAgentId: agentId,
        targets: [...normalizedReplyTargets],
      };
    }

    finalizeBatchIfPossible();
    appendDecision(nextDecision ?? buildNextDecision(agentId, reply.content));
  };

  const firstLine = parsed.lines[0];
  assert.notEqual(firstLine, undefined, "脚本不能为空");
  appendLine(firstLine!.normalized);
  appendDecision({
    type: "execute_batch",
    sourceAgentId: null,
    targets: [parsed.startAgent],
  });

  while (actualScript.length < parsed.normalizedScript.length) {
    const currentBatch = activeBatches[activeBatches.length - 1] ?? null;
    if (currentBatch) {
      const nextLine = parsed.lines[actualScript.length];
      const nextAgent = nextLine ? parsed.resolver.resolve(nextLine.sender) : undefined;
      assert.notEqual(nextAgent, undefined, `批次 ${currentBatch.source} 缺少下一个回应者`);
      processReplyLine(nextAgent!);
      continue;
    }

    const nextExpectedSources = [...sourceStates.entries()]
      .filter(([, state]) => state.expectedNextAction && state.expectedNextAction.targets.length > 0)
      .map(([agentId]) => agentId);
    if (nextExpectedSources.length > 0) {
      assert.equal(nextExpectedSources.length, 1, "同一时刻只能有一个 Source 等待下一轮修复/剩余派发");
      processReplyLine(nextExpectedSources[0] ?? "");
      continue;
    }

    if (actualScript.length === 1) {
      processReplyLine(parsed.startAgent);
      continue;
    }

    assert.fail(`无法继续推进脚本，第 ${actualScript.length + 1} 条没有唯一可执行的下一位 Agent`);
  }

  assert.deepEqual(actualScript, parsed.normalizedScript);
  if (expectedDecisions) {
    assert.equal(
      actualDecisions.length,
      expectedDecisions.length,
      "actualDecisions 与 expectedDecisions 的条数不一致",
    );
  }
}

function parseScenario(topology: TopologyRecord, script: string[]): ParsedScenario {
  const resolver = createAgentRefResolver(topology);
  const lines = script
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseScriptLine);

  assert.ok(lines.length > 0, "脚本不能为空");
  const firstLine = lines[0];
  assert.equal(firstLine?.sender, "user", "第一条脚本必须是 user: @Agent ...");

  const startAgent = resolver.resolve(extractLeadingMention(firstLine.content) ?? "");
  assert.notEqual(startAgent, "", "第一条脚本必须以 @Agent 开头");
  assert.ok(resolver.isKnown(startAgent), "第一条 user 消息的 @Agent 必须存在于 topology.nodes");
  const agentOrder = [...topology.nodes];
  assert.ok(agentOrder.length > 0, "topology.nodes 至少要包含一个 Agent");

  const repliesByAgent = new Map<string, ParsedReply[]>();
  for (const line of lines.slice(1)) {
    const normalizedSender = resolver.resolve(line.sender);
    assert.ok(resolver.isKnown(normalizedSender), `脚本里出现了 topology 中不存在的 Agent：${line.sender}`);
    const parsedReply = parseReply(line);
    for (const target of parsedReply.targets) {
      const normalizedTarget = resolver.resolve(target);
      assert.ok(resolver.isKnown(normalizedTarget), `脚本里 @ 了 topology 中不存在的 Agent：${target}`);
    }
    const currentReplies = repliesByAgent.get(normalizedSender) ?? [];
    currentReplies.push({
      ...parsedReply,
      sender: normalizedSender,
    });
    repliesByAgent.set(normalizedSender, currentReplies);
  }

  return {
    normalizedScript: lines.map((line) => line.normalized),
    startAgent,
    lines,
    repliesByAgent,
    agentOrder,
    resolver,
  };
}

function createDynamicSpawnAgentKey(input: {
  spawnNodeName: string;
  templateName: string;
  index: number;
}): string {
  return `spawn:${input.spawnNodeName}:${input.templateName}-${input.index}`;
}

function parseSpawnAliasRef(trimmed: string): { templateName: string; index: number } | null {
  const spawnStyleMatch = trimmed.match(/^(.+)-spawn(\d+)$/u);
  if (spawnStyleMatch) {
    const templateName = spawnStyleMatch[1]?.trim() ?? "";
    const index = Number.parseInt(spawnStyleMatch[2] ?? "", 10);
    if (templateName && Number.isInteger(index) && index > 0) {
      return { templateName, index };
    }
  }

  const legacyMatch = trimmed.match(/^(.+)-(\d+)$/u);
  if (!legacyMatch) {
    return null;
  }
  const templateName = legacyMatch[1]?.trim() ?? "";
  const index = Number.parseInt(legacyMatch[2] ?? "", 10);
  if (!templateName || !Number.isInteger(index) || index <= 0) {
    return null;
  }
  return { templateName, index };
}

function createAgentRefResolver(topology: TopologyRecord): AgentRefResolver {
  const staticAgents = new Set(topology.nodes);
  const staticSpawnTemplateNames = new Set(
    (topology.nodeRecords ?? [])
      .filter((node) => node.kind === "spawn")
      .map((node) => node.templateName),
  );
  const staticHandoffTargets = new Map<string, string[]>();
  const staticTriggeredTargets = new Map<string, string[]>();
  const staticOutgoingTargets = new Map<string, Set<string>>();
  const actionRequiredLoopLimitByEdge = new Map<string, number>();
  const normalizeStoredTrigger = (triggerOn: unknown): TopologyEdgeTrigger | "transfer" | null => {
    if (triggerOn === "transfer") {
      return "transfer";
    }
    if (triggerOn === "complete") {
      return "complete";
    }
    if (triggerOn === "continue") {
      return "continue";
    }
    return null;
  };
  for (const edge of topology.edges) {
    const normalizedEdgeTrigger = normalizeStoredTrigger(edge.triggerOn);
    if (normalizedEdgeTrigger === "transfer") {
      const current = staticHandoffTargets.get(edge.source) ?? [];
      if (!current.includes(edge.target)) {
        current.push(edge.target);
      }
      staticHandoffTargets.set(edge.source, current);
    }

    if (normalizedEdgeTrigger === "complete" || normalizedEdgeTrigger === "continue") {
      const triggerKey = `${edge.source}::${normalizedEdgeTrigger}`;
      const current = staticTriggeredTargets.get(triggerKey) ?? [];
      if (!current.includes(edge.target)) {
        current.push(edge.target);
      }
      staticTriggeredTargets.set(triggerKey, current);
    }

    if (normalizedEdgeTrigger === "continue") {
      actionRequiredLoopLimitByEdge.set(
        buildReviewFailLoopEdgeKey(edge.source, edge.target),
        typeof edge.maxRevisionRounds === "number" && Number.isFinite(edge.maxRevisionRounds)
          ? Math.max(1, Math.floor(edge.maxRevisionRounds))
          : DEFAULT_ACTION_REQUIRED_MAX_ROUNDS,
      );
    }

    const outgoing = staticOutgoingTargets.get(edge.source) ?? new Set<string>();
    outgoing.add(edge.target);
    staticOutgoingTargets.set(edge.source, outgoing);
  }

  const spawnRuleStates: SpawnRuleState[] = (topology.spawnRules ?? []).map((rule) => {
    const spawnNodeName = rule.spawnNodeName
      || topology.nodeRecords?.find((node) => node.spawnRuleId === rule.id)?.id
      || "";
    const roleToTemplate = new Map(rule.spawnedAgents.map((agent) => [agent.role, agent.templateName]));
    const templateToRole = new Map<string, string>();
    for (const agent of rule.spawnedAgents) {
      if (!templateToRole.has(agent.templateName)) {
        templateToRole.set(agent.templateName, agent.role);
      }
    }
    const terminalRoles = rule.spawnedAgents
      .map((agent) => agent.role)
      .filter((role) => !rule.edges.some((edge) => edge.sourceRole === role));
    return {
      ruleId: rule.id,
      spawnNodeName,
      sourceTemplateName: rule.sourceTemplateName ?? null,
      reportToTemplateName: rule.reportToTemplateName ?? null,
      reportToTriggerOn: rule.reportToTriggerOn ?? "complete",
      entryRole: rule.entryRole,
      entryTemplateName: roleToTemplate.get(rule.entryRole) ?? null,
      roleToTemplate,
      templateToRole,
      edges: rule.edges.map((edge) => ({ ...edge })),
      terminalRoles,
    };
  });

  const spawnRuleById = new Map(spawnRuleStates.map((state) => [state.ruleId, state]));
  const dynamicRuleIdByTemplateName = new Map<string, string>();
  const dynamicRefsByKey = new Map<string, DynamicSpawnAgentRef>();

  for (const state of spawnRuleStates) {
    for (const [templateName] of state.templateToRole.entries()) {
      if (templateName === state.spawnNodeName) {
        continue;
      }
      const existing = dynamicRuleIdByTemplateName.get(templateName);
      assert.ok(
        existing === undefined || existing === state.ruleId,
        `spawn 模板名 ${templateName} 在多个 spawn rule 中重复，脚本引用会产生歧义。`,
      );
      dynamicRuleIdByTemplateName.set(templateName, state.ruleId);
    }
  }

  const createDynamicRef = (input: {
    ruleId: string;
    templateName: string;
    role: string;
    index: number;
  }): DynamicSpawnAgentRef => {
    const ruleState = spawnRuleById.get(input.ruleId);
    assert.notEqual(ruleState, undefined, `未知 spawn rule：${input.ruleId}`);
    const ensuredRuleState = ruleState!;
    const key = createDynamicSpawnAgentKey({
      spawnNodeName: ensuredRuleState.spawnNodeName,
      templateName: input.templateName,
      index: input.index,
    });
    const existing = dynamicRefsByKey.get(key);
    if (existing) {
      return existing;
    }
    const created: DynamicSpawnAgentRef = {
      key,
      spawnNodeName: ensuredRuleState.spawnNodeName,
      spawnRuleId: ensuredRuleState.ruleId,
      templateName: input.templateName,
      role: input.role,
      index: input.index,
      sourceTemplateName: ensuredRuleState.sourceTemplateName,
      reportToTemplateName: ensuredRuleState.reportToTemplateName,
      reportToTriggerOn: ensuredRuleState.reportToTriggerOn,
      isEntry: input.role === ensuredRuleState.entryRole,
    };
    dynamicRefsByKey.set(key, created);
    return created;
  };

  const resolveDisplayNameRef = (trimmed: string): string | null => {
    const parsedAlias = parseSpawnAliasRef(trimmed);
    if (!parsedAlias) {
      return null;
    }
    const { templateName, index } = parsedAlias;
    if (staticSpawnTemplateNames.has(templateName) && staticAgents.has(templateName)) {
      return templateName;
    }
    const ruleId = dynamicRuleIdByTemplateName.get(templateName);
    if (!ruleId) {
      return null;
    }
    const ruleState = spawnRuleById.get(ruleId);
    const role = ruleState?.templateToRole.get(templateName);
    if (!ruleState || !role) {
      return null;
    }
    return createDynamicRef({
      ruleId,
      templateName,
      role,
      index,
    }).key;
  };

  const resolveRuntimeIdRef = (trimmed: string): string | null => {
    const match = trimmed.match(/^([^#]+)#(.+)$/u);
    if (!match) {
      return null;
    }
    const role = match[1]?.trim() ?? "";
    const groupId = match[2]?.trim() ?? "";
    if (!role || !groupId) {
      return null;
    }
    const ruleState = spawnRuleStates.find((state) => groupId.startsWith(`${state.ruleId}:`));
    if (!ruleState) {
      return null;
    }
    const templateName = ruleState.roleToTemplate.get(role);
    if (!templateName) {
      return null;
    }
    if (templateName === ruleState.spawnNodeName) {
      return ruleState.spawnNodeName;
    }
    const indexMatch = groupId.match(/(\d+)(?!.*\d)/u);
    const index = Number.parseInt(indexMatch?.[1] ?? "", 10);
    if (!Number.isInteger(index) || index <= 0) {
      return null;
    }
    return createDynamicRef({
      ruleId: ruleState.ruleId,
      templateName,
      role,
      index,
    }).key;
  };

  const resolve = (name: string): string => {
    const trimmed = name.trim();
    if (!trimmed) {
      return "";
    }
    if (staticAgents.has(trimmed)) {
      return trimmed;
    }
    return resolveRuntimeIdRef(trimmed) ?? resolveDisplayNameRef(trimmed) ?? trimmed;
  };

  const isKnown = (agentId: string): boolean => staticAgents.has(agentId) || dynamicRefsByKey.has(agentId);

  const normalizeTrigger = (
    triggerOn: "transfer" | "continue" | "complete" | TopologyEdgeTrigger,
  ): TopologyEdgeTrigger | "transfer" => triggerOn;

  const getDynamicRef = (agentId: string): DynamicSpawnAgentRef | null => dynamicRefsByKey.get(agentId) ?? null;

  const getHandoffTargets = (agentId: string): string[] => {
    if (staticAgents.has(agentId)) {
      return [...(staticHandoffTargets.get(agentId) ?? [])];
    }
    return [];
  };

  const getTriggeredTargets = (
    agentId: string,
    triggerOn: "continue" | "complete",
  ): string[] => {
    const dynamicRef = getDynamicRef(agentId);
    const normalizedTrigger = normalizeTrigger(triggerOn);
    if (!dynamicRef) {
      return [...(staticTriggeredTargets.get(`${agentId}::${normalizedTrigger}`) ?? [])];
    }

    const ruleState = spawnRuleById.get(dynamicRef.spawnRuleId);
    if (!ruleState) {
      return [];
    }

    const targets: string[] = [];
    for (const edge of ruleState.edges) {
      if (edge.sourceRole !== dynamicRef.role || edge.triggerOn !== normalizedTrigger) {
        continue;
      }
      const targetTemplateName = ruleState.roleToTemplate.get(edge.targetRole);
      if (!targetTemplateName) {
        continue;
      }
      if (targetTemplateName === ruleState.spawnNodeName) {
        targets.push(ruleState.spawnNodeName);
        continue;
      }
      targets.push(createDynamicRef({
        ruleId: ruleState.ruleId,
        templateName: targetTemplateName,
        role: edge.targetRole,
        index: dynamicRef.index,
      }).key);
    }

    if (
      ruleState.terminalRoles.includes(dynamicRef.role)
      && dynamicRef.reportToTemplateName
      && dynamicRef.reportToTriggerOn === normalizedTrigger
      && !targets.includes(dynamicRef.reportToTemplateName)
    ) {
      targets.push(dynamicRef.reportToTemplateName);
    }

    return targets;
  };

  const getAllOutgoingTargets = (agentId: string): Set<string> => {
    const dynamicRef = getDynamicRef(agentId);
    if (!dynamicRef) {
      return new Set(staticOutgoingTargets.get(agentId) ?? []);
    }

    const ruleState = spawnRuleById.get(dynamicRef.spawnRuleId);
    if (!ruleState) {
      return new Set();
    }

    const targets = new Set<string>();
    for (const edge of ruleState.edges) {
      if (edge.sourceRole !== dynamicRef.role) {
        continue;
      }
      const targetTemplateName = ruleState.roleToTemplate.get(edge.targetRole);
      if (!targetTemplateName) {
        continue;
      }
      if (targetTemplateName === ruleState.spawnNodeName) {
        targets.add(ruleState.spawnNodeName);
        continue;
      }
      targets.add(createDynamicRef({
        ruleId: ruleState.ruleId,
        templateName: targetTemplateName,
        role: edge.targetRole,
        index: dynamicRef.index,
      }).key);
    }

    if (ruleState.terminalRoles.includes(dynamicRef.role) && dynamicRef.reportToTemplateName) {
      targets.add(dynamicRef.reportToTemplateName);
    }

    return targets;
  };

  const hasOutgoingTarget = (sourceAgentId: string, targetAgentId: string): boolean =>
    {
      if (getAllOutgoingTargets(sourceAgentId).has(targetAgentId)) {
        return true;
      }
      const dynamicRef = getDynamicRef(targetAgentId);
      if (!dynamicRef) {
        return false;
      }
      return (
        dynamicRef.isEntry
        && (dynamicRef.sourceTemplateName === sourceAgentId
          || (staticOutgoingTargets.get(sourceAgentId) ?? new Set<string>()).has(dynamicRef.spawnNodeName))
      );
    };
  const hasAnyOutgoingTargets = (agentId: string): boolean => getAllOutgoingTargets(agentId).size > 0;

  const getReviewFailLoopLimit = (sourceAgentId: string, targetAgentId: string): number =>
    actionRequiredLoopLimitByEdge.get(buildReviewFailLoopEdgeKey(sourceAgentId, targetAgentId))
    ?? DEFAULT_ACTION_REQUIRED_MAX_ROUNDS;

  const findNextPendingRepairReviewer = (
    repairTargetAgentId: string,
    excludeReviewerAgentId: string,
    pendingReviewerIds: Iterable<string>,
  ): string | null => {
    const pendingSet = new Set(pendingReviewerIds);
    for (const edge of topology.edges) {
      const normalizedEdgeTrigger = normalizeStoredTrigger(edge.triggerOn);
      if (
        normalizedEdgeTrigger === "continue"
        && edge.target === repairTargetAgentId
        && edge.source !== excludeReviewerAgentId
        && pendingSet.has(edge.source)
      ) {
        return edge.source;
      }
    }
    return null;
  };

  const matchesCanonicalTarget = (
    sourceAgentId: string,
    actualTargetName: string,
    canonicalTargetName: string,
    _triggerOn: "transfer" | "continue" | "complete",
  ): boolean => {
    if (actualTargetName === canonicalTargetName) {
      return true;
    }
    const dynamicRef = getDynamicRef(actualTargetName);
    if (!dynamicRef) {
      return false;
    }
    return (
      dynamicRef.isEntry
      && dynamicRef.spawnNodeName === canonicalTargetName
      && (dynamicRef.sourceTemplateName === sourceAgentId
        || (staticOutgoingTargets.get(sourceAgentId) ?? new Set<string>()).has(dynamicRef.spawnNodeName))
    );
  };

  const matchCanonicalTargets = (
    sourceAgentId: string,
    actualTargets: string[],
    canonicalTargets: string[],
    triggerOn: "transfer" | "continue" | "complete",
  ): string[] | null => {
    if (actualTargets.length !== canonicalTargets.length) {
      return null;
    }
    const matched = canonicalTargets.every((canonicalTarget, index) =>
      matchesCanonicalTarget(sourceAgentId, actualTargets[index] ?? "", canonicalTarget, triggerOn),
    );
    return matched ? canonicalTargets : null;
  };

  return {
    resolve,
    isKnown,
    getDynamicRef,
    getHandoffTargets,
    getTriggeredTargets,
    hasAnyOutgoingTargets,
    hasOutgoingTarget,
    getReviewFailLoopLimit,
    findNextPendingRepairReviewer,
    matchCanonicalTargets,
  };
}

function parseScriptLine(line: string): ParsedScriptLine {
  const separatorIndex = line.indexOf(": ");
  const resolvedSeparatorIndex = separatorIndex >= 0 ? separatorIndex : line.indexOf(":");
  assert.notEqual(resolvedSeparatorIndex, -1, `脚本缺少 sender 前缀：${line}`);
  const separatorLength = separatorIndex >= 0 ? 2 : 1;
  const sender = line.slice(0, resolvedSeparatorIndex).trim();
  const content = line.slice(resolvedSeparatorIndex + separatorLength).trim();
  return {
    sender,
    content,
    normalized: formatScriptLine(sender, content),
  };
}

function parseReply(line: ParsedScriptLine): ParsedReply {
  const inlineDispatch = extractInlineDispatch(line.content);
  return {
    sender: line.sender,
    content: line.content,
    body: inlineDispatch?.body ?? (isMentionOnlyContent(line.content) ? "" : line.content),
    targets: inlineDispatch?.targets ?? (isMentionOnlyContent(line.content) ? extractMentions(line.content) : []),
    normalized: line.normalized,
  };
}

function extractLeadingMention(content: string): string | undefined {
  const match = content.trim().match(/^@(\S+)/u);
  return match?.[1];
}

function extractMentions(content: string): string[] {
  return [...content.matchAll(/@(\S+)/gu)]
    .map((match) => match[1] ?? "")
    .filter(Boolean);
}

function isMentionOnlyContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }
  return trimmed
    .split(/\s+/)
    .every((token) => /^@\S+$/u.test(token));
}

function extractInlineDispatch(content: string): { body: string; targets: string[] } | null {
  const trimmed = content.trim();
  if (!trimmed || isMentionOnlyContent(trimmed)) {
    return null;
  }

  const match = trimmed.match(/[\s，,]+(@\S+(?:\s+@\S+)*)\s*$/u);
  if (!match || typeof match.index !== "number") {
    return null;
  }

  const targets = extractMentions(match[1] ?? "");
  if (targets.length === 0) {
    return null;
  }

  const body = trimmed.slice(0, match.index).replace(/[，,\s]+$/u, "").trim();
  if (!body) {
    return null;
  }

  return { body, targets };
}

function formatScriptLine(sender: string, content: string): string {
  return `${sender}: ${content.trim()}`;
}

function buildReviewFailLoopEdgeKey(sourceAgentId: string, targetAgentId: string): string {
  return `${sourceAgentId}->${targetAgentId}`;
}

function clearReviewFailLoopCountsForReviewer(
  actionRequiredLoopCountByEdge: Map<string, number>,
  reviewerAgentId: string,
): void {
  for (const edgeKey of actionRequiredLoopCountByEdge.keys()) {
    if (edgeKey.startsWith(`${reviewerAgentId}->`)) {
      actionRequiredLoopCountByEdge.delete(edgeKey);
    }
  }
}

function shouldFinishFromEndEdge(
  topology: TopologyRecord,
  agentId: string,
  replyContent: string | undefined,
): boolean {
  const endNode = topology.langgraph?.end;
  if (!endNode?.sources.includes(agentId)) {
    return false;
  }
  const incoming = endNode.incoming?.filter((edge) => edge.source === agentId) ?? [];
  if (incoming.length === 0) {
    return false;
  }

  const signal = extractTrailingReviewSignalBlock(replyContent ?? "");
  if (!signal) {
    return false;
  }

  return incoming.some((edge) => {
    if (!edge.triggerOn) {
      return true;
    }
    return edge.triggerOn === signal.kind;
  });
}
