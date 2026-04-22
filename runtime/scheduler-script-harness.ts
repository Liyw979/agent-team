import assert from "node:assert/strict";

import type { TopologyEdgeTrigger, TopologyRecord } from "@shared/types";

const MAX_REVIEW_FAIL_LOOP_COUNT = 4;

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
  expectedNextTargets: string[] | null;
}

interface BatchResponse {
  agent: string;
  outcome: "pass" | "fail";
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

interface AssertSchedulerScriptOptions {
  topology: TopologyRecord;
  script: string[];
}

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
  isKnown(agentName: string): boolean;
  getAssociationTargets(agentName: string): string[];
  getTriggeredTargets(agentName: string, triggerOn: "review_fail" | "review_pass"): string[];
  hasOutgoingTarget(sourceAgentName: string, targetAgentName: string): boolean;
  matchCanonicalTargets(
    sourceAgentName: string,
    actualTargets: string[],
    canonicalTargets: string[],
    triggerOn: "association" | "review_fail" | "review_pass",
  ): string[] | null;
}

export async function assertSchedulerScript(
  options: AssertSchedulerScriptOptions,
): Promise<void> {
  const parsed = parseScenario(options.topology, options.script);
  const sourceStates = new Map<string, SourceState>();
  const ensureSourceState = (agentName: string): SourceState => {
    const existing = sourceStates.get(agentName);
    if (existing) {
      return existing;
    }
    const created: SourceState = {
      defaultTargets: parsed.resolver.getAssociationTargets(agentName),
      currentRevision: 0,
      reviewerPassRevision: new Map(),
      expectedNextTargets: null,
    };
    sourceStates.set(agentName, created);
    return created;
  };
  for (const agentName of parsed.agentOrder) {
    ensureSourceState(agentName);
  }

  const actualScript: string[] = [];
  const replyIndexByAgent = new Map<string, number>();
  const activeBatches: ActiveBatch[] = [];
  const reviewFailLoopCountByEdge = new Map<string, number>();

  const appendLine = (line: string) => {
    actualScript.push(line);
    const expected = parsed.normalizedScript[actualScript.length - 1];
    assert.equal(line, expected, `第 ${actualScript.length} 条脚本不匹配`);
  };

  const getNextReply = (agentName: string): ParsedReply => {
    const currentIndex = replyIndexByAgent.get(agentName) ?? 0;
    const replies = parsed.repliesByAgent.get(agentName) ?? [];
    const reply = replies[currentIndex];
    assert.notEqual(reply, undefined, `脚本里缺少 ${agentName} 第 ${currentIndex + 1} 轮回复`);
    replyIndexByAgent.set(agentName, currentIndex + 1);
    return reply;
  };

  const finalizeBatchIfPossible = () => {
    while (activeBatches.length > 0) {
      const current = activeBatches[activeBatches.length - 1];
      if (!current || current.remainingTargets.length > 0) {
        return;
      }

      activeBatches.pop();
      const sourceState = ensureSourceState(current.source);
      const firstFailed = current.responses.find((item) => item.outcome === "fail") ?? null;
      if (firstFailed) {
        sourceState.expectedNextTargets = [firstFailed.agent];
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
        sourceState.expectedNextTargets = staleTargets.length > 0 ? staleTargets : null;
        continue;
      }

      sourceState.expectedNextTargets = null;
    }
  };

  const processReplyLine = (agentName: string): void => {
    const reply = getNextReply(agentName);
    const currentBatch = activeBatches[activeBatches.length - 1] ?? null;
    const normalizedReplyTargets = reply.targets.map((target) => parsed.resolver.resolve(target));

    if (currentBatch) {
      const responderIndex = currentBatch.remainingTargets.indexOf(agentName);
      assert.notEqual(
        responderIndex,
        -1,
        `${agentName} 不是当前批次 ${currentBatch.source} 等待中的 reviewer`,
      );
      currentBatch.remainingTargets.splice(responderIndex, 1);
    } else {
      const sourceState = ensureSourceState(agentName);
      const expectedTargets = sourceState.expectedNextTargets;
      if (expectedTargets) {
        assert.deepEqual(
          normalizedReplyTargets,
          expectedTargets,
          `${agentName} 的 @ 目标与预期不一致`,
        );
      } else if (normalizedReplyTargets.length > 0) {
        const directReviewFailTargets = parsed.resolver.getTriggeredTargets(agentName, "review_fail");
        const matchesAssociationTargets = parsed.resolver.matchCanonicalTargets(
          agentName,
          normalizedReplyTargets,
          sourceState.defaultTargets,
          "association",
        );
        const matchesDirectReviewFailTargets = parsed.resolver.matchCanonicalTargets(
          agentName,
          normalizedReplyTargets,
          directReviewFailTargets,
          "review_fail",
        );
        assert.equal(
          Boolean(matchesAssociationTargets || matchesDirectReviewFailTargets),
          true,
          `${agentName} 的初始/全量派发目标必须等于 topology.association 默认顺序，或匹配其 direct review_fail 下游`,
        );
      }
    }

    appendLine(reply.normalized);

    if (!currentBatch) {
      const sourceState = ensureSourceState(agentName);
      sourceState.expectedNextTargets = null;

      if (normalizedReplyTargets.length === 0) {
        return;
      }

      if (reply.body) {
        sourceState.currentRevision += 1;
      }

      for (const target of normalizedReplyTargets) {
        assert.ok(
          parsed.resolver.hasOutgoingTarget(agentName, target),
          `脚本里的派发 ${agentName}: @${target} 没有对应的拓扑边`,
        );
      }

      const directReviewFailTargets = parsed.resolver.getTriggeredTargets(agentName, "review_fail");
      const canonicalTargets = sourceState.expectedNextTargets
        ?? parsed.resolver.matchCanonicalTargets(
          agentName,
          normalizedReplyTargets,
          sourceState.defaultTargets,
          "association",
        )
        ?? parsed.resolver.matchCanonicalTargets(
          agentName,
          normalizedReplyTargets,
          directReviewFailTargets,
          "review_fail",
        )
        ?? normalizedReplyTargets;

      activeBatches.push({
        source: agentName,
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
      return;
    }

    const currentSource = currentBatch.source;
    const failTargets = parsed.resolver.getTriggeredTargets(agentName, "review_fail");
    const isFail = normalizedReplyTargets.length === 1
      && normalizedReplyTargets[0] === currentSource
      && failTargets.includes(currentSource);

    currentBatch.responses.push({
      agent: agentName,
      outcome: isFail ? "fail" : "pass",
    });

    if (!isFail) {
      clearReviewFailLoopCountsForReviewer(reviewFailLoopCountByEdge, agentName);
      const sourceState = ensureSourceState(currentSource);
      const canonicalTarget = currentBatch.canonicalTargetByActual.get(agentName) ?? agentName;
      sourceState.reviewerPassRevision.set(canonicalTarget, currentBatch.sourceRevision);
    } else {
      const edgeKey = buildReviewFailLoopEdgeKey(agentName, currentSource);
      const nextLoopCount = (reviewFailLoopCountByEdge.get(edgeKey) ?? 0) + 1;
      reviewFailLoopCountByEdge.set(edgeKey, nextLoopCount);
      assert.ok(
        nextLoopCount <= MAX_REVIEW_FAIL_LOOP_COUNT,
        `${agentName} -> ${currentSource} 连续回流已超过 ${MAX_REVIEW_FAIL_LOOP_COUNT} 轮上限`,
      );
    }

    if (!isFail && normalizedReplyTargets.length > 0) {
      for (const target of normalizedReplyTargets) {
        assert.ok(
          parsed.resolver.hasOutgoingTarget(agentName, target),
          `脚本里的派发 ${agentName}: @${target} 没有对应的拓扑边`,
        );
      }

      const nestedSourceState = ensureSourceState(agentName);
      if (reply.body) {
        nestedSourceState.currentRevision += 1;
      }
      nestedSourceState.expectedNextTargets = null;

      activeBatches.push({
        source: agentName,
        targets: [...normalizedReplyTargets],
        canonicalTargets: [...normalizedReplyTargets],
        canonicalTargetByActual: new Map(normalizedReplyTargets.map((target) => [target, target])),
        remainingTargets: [...normalizedReplyTargets],
        responses: [],
        sourceRevision: nestedSourceState.currentRevision,
        sourceHadBody: reply.body.length > 0,
      });
    }

    finalizeBatchIfPossible();
  };

  const firstLine = parsed.lines[0];
  assert.notEqual(firstLine, undefined, "脚本不能为空");
  appendLine(firstLine.normalized);

  while (actualScript.length < parsed.normalizedScript.length) {
    const currentBatch = activeBatches[activeBatches.length - 1] ?? null;
    if (currentBatch) {
      const nextLine = parsed.lines[actualScript.length];
      const nextAgent = nextLine ? parsed.resolver.resolve(nextLine.sender) : undefined;
      assert.notEqual(nextAgent, undefined, `批次 ${currentBatch.source} 缺少下一个回应者`);
      processReplyLine(nextAgent);
      continue;
    }

    const nextExpectedSources = [...sourceStates.entries()]
      .filter(([, state]) => state.expectedNextTargets && state.expectedNextTargets.length > 0)
      .map(([agentName]) => agentName);
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
  const staticAssociationTargets = new Map<string, string[]>();
  const staticTriggeredTargets = new Map<string, string[]>();
  const staticOutgoingTargets = new Map<string, Set<string>>();
  const normalizeStoredTrigger = (triggerOn: unknown): TopologyEdgeTrigger | "association" | null => {
    if (triggerOn === "association") {
      return "association";
    }
    if (triggerOn === "approved" || triggerOn === "review_pass") {
      return "approved";
    }
    if (triggerOn === "needs_revision" || triggerOn === "review_fail") {
      return "needs_revision";
    }
    return null;
  };
  for (const edge of topology.edges) {
    const normalizedEdgeTrigger = normalizeStoredTrigger(edge.triggerOn);
    if (normalizedEdgeTrigger === "association") {
      const current = staticAssociationTargets.get(edge.source) ?? [];
      if (!current.includes(edge.target)) {
        current.push(edge.target);
      }
      staticAssociationTargets.set(edge.source, current);
    }

    if (normalizedEdgeTrigger === "approved" || normalizedEdgeTrigger === "needs_revision") {
      const triggerKey = `${edge.source}::${normalizedEdgeTrigger}`;
      const current = staticTriggeredTargets.get(triggerKey) ?? [];
      if (!current.includes(edge.target)) {
        current.push(edge.target);
      }
      staticTriggeredTargets.set(triggerKey, current);
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
      reportToTriggerOn: rule.reportToTriggerOn ?? "approved",
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
    const key = createDynamicSpawnAgentKey({
      spawnNodeName: ruleState.spawnNodeName,
      templateName: input.templateName,
      index: input.index,
    });
    const existing = dynamicRefsByKey.get(key);
    if (existing) {
      return existing;
    }
    const created: DynamicSpawnAgentRef = {
      key,
      spawnNodeName: ruleState.spawnNodeName,
      spawnRuleId: ruleState.ruleId,
      templateName: input.templateName,
      role: input.role,
      index: input.index,
      sourceTemplateName: ruleState.sourceTemplateName,
      reportToTemplateName: ruleState.reportToTemplateName,
      reportToTriggerOn: ruleState.reportToTriggerOn,
      isEntry: input.role === ruleState.entryRole,
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

  const isKnown = (agentName: string): boolean => staticAgents.has(agentName) || dynamicRefsByKey.has(agentName);

  const normalizeTrigger = (
    triggerOn: "association" | "review_fail" | "review_pass" | TopologyEdgeTrigger,
  ): TopologyEdgeTrigger | "association" => {
    if (triggerOn === "review_fail") {
      return "needs_revision";
    }
    if (triggerOn === "review_pass") {
      return "approved";
    }
    return triggerOn;
  };

  const getDynamicRef = (agentName: string): DynamicSpawnAgentRef | null => dynamicRefsByKey.get(agentName) ?? null;

  const getAssociationTargets = (agentName: string): string[] => {
    if (staticAgents.has(agentName)) {
      return [...(staticAssociationTargets.get(agentName) ?? [])];
    }
    return [];
  };

  const getTriggeredTargets = (
    agentName: string,
    triggerOn: "review_fail" | "review_pass",
  ): string[] => {
    const dynamicRef = getDynamicRef(agentName);
    const normalizedTrigger = normalizeTrigger(triggerOn);
    if (!dynamicRef) {
      return [...(staticTriggeredTargets.get(`${agentName}::${normalizedTrigger}`) ?? [])];
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

  const getAllOutgoingTargets = (agentName: string): Set<string> => {
    const dynamicRef = getDynamicRef(agentName);
    if (!dynamicRef) {
      return new Set(staticOutgoingTargets.get(agentName) ?? []);
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

  const hasOutgoingTarget = (sourceAgentName: string, targetAgentName: string): boolean =>
    {
      if (getAllOutgoingTargets(sourceAgentName).has(targetAgentName)) {
        return true;
      }
      const dynamicRef = getDynamicRef(targetAgentName);
      if (!dynamicRef) {
        return false;
      }
      return (
        dynamicRef.isEntry
        && (dynamicRef.sourceTemplateName === sourceAgentName
          || (staticOutgoingTargets.get(sourceAgentName) ?? new Set<string>()).has(dynamicRef.spawnNodeName))
      );
    };

  const matchesCanonicalTarget = (
    sourceAgentName: string,
    actualTargetName: string,
    canonicalTargetName: string,
    triggerOn: "association" | "review_fail" | "review_pass",
  ): boolean => {
    if (actualTargetName === canonicalTargetName) {
      return true;
    }
    if (triggerOn !== "association") {
      return false;
    }
    const dynamicRef = getDynamicRef(actualTargetName);
    if (!dynamicRef) {
      return false;
    }
    return (
      dynamicRef.isEntry
      && dynamicRef.spawnNodeName === canonicalTargetName
      && (dynamicRef.sourceTemplateName === sourceAgentName
        || (staticOutgoingTargets.get(sourceAgentName) ?? new Set<string>()).has(dynamicRef.spawnNodeName))
    );
  };

  const matchCanonicalTargets = (
    sourceAgentName: string,
    actualTargets: string[],
    canonicalTargets: string[],
    triggerOn: "association" | "review_fail" | "review_pass",
  ): string[] | null => {
    if (actualTargets.length !== canonicalTargets.length) {
      return null;
    }
    const matched = canonicalTargets.every((canonicalTarget, index) =>
      matchesCanonicalTarget(sourceAgentName, actualTargets[index] ?? "", canonicalTarget, triggerOn),
    );
    return matched ? canonicalTargets : null;
  };

  return {
    resolve,
    isKnown,
    getAssociationTargets,
    getTriggeredTargets,
    hasOutgoingTarget,
    matchCanonicalTargets,
  };
}

function parseScriptLine(line: string): ParsedScriptLine {
  const separatorIndex = line.indexOf(": ");
  const fallbackSeparatorIndex = separatorIndex >= 0 ? separatorIndex : line.indexOf(":");
  const resolvedSeparatorIndex = fallbackSeparatorIndex;
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
  const match = content.trim().match(/^@([^\s]+)/u);
  return match?.[1];
}

function extractMentions(content: string): string[] {
  return [...content.matchAll(/@([^\s]+)/gu)]
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
    .every((token) => /^@[^\s]+$/u.test(token));
}

function extractInlineDispatch(content: string): { body: string; targets: string[] } | null {
  const trimmed = content.trim();
  if (!trimmed || isMentionOnlyContent(trimmed)) {
    return null;
  }

  const match = trimmed.match(/(?:[\s，,]+)(@[^\s]+(?:\s+@[^\s]+)*)\s*$/u);
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
  reviewFailLoopCountByEdge: Map<string, number>,
  reviewerAgentId: string,
): void {
  for (const edgeKey of reviewFailLoopCountByEdge.keys()) {
    if (edgeKey.startsWith(`${reviewerAgentId}->`)) {
      reviewFailLoopCountByEdge.delete(edgeKey);
    }
  }
}
