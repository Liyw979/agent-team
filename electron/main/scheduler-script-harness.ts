import assert from "node:assert/strict";

import type { TopologyRecord } from "@shared/types";

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
  validAgents: Set<string>;
}

export interface AssertSchedulerScriptOptions {
  topology: TopologyRecord;
  script: string[];
}

export async function assertSchedulerScript(
  options: AssertSchedulerScriptOptions,
): Promise<void> {
  const parsed = parseScenario(options.topology, options.script);
  const associationTargets = buildAssociationTargets(options.topology);
  const outgoingTargets = buildOutgoingTargets(options.topology);
  const reviewFailTargets = buildTriggeredTargets(options.topology, "review_fail");
  const sourceStates = new Map<string, SourceState>();
  for (const agentName of parsed.agentOrder) {
    sourceStates.set(agentName, {
      defaultTargets: associationTargets.get(agentName) ?? [],
      currentRevision: 0,
      reviewerPassRevision: new Map(),
      expectedNextTargets: null,
    });
  }

  const actualScript: string[] = [];
  const replyIndexByAgent = new Map<string, number>();
  const activeBatches: ActiveBatch[] = [];

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
      const sourceState = sourceStates.get(current.source);
      assert.notEqual(sourceState, undefined, `缺少 SourceState：${current.source}`);

      const firstFailed = current.responses.find((item) => item.outcome === "fail") ?? null;
      if (firstFailed) {
        sourceState.expectedNextTargets = [firstFailed.agent];
        continue;
      }

      if (current.sourceHadBody && current.targets.length === 1) {
        const currentReviewer = current.targets[0] ?? "";
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

    if (currentBatch) {
      const expectedTarget = currentBatch.remainingTargets.shift();
      assert.equal(
        agentName,
        expectedTarget,
        `${agentName} 的回应顺序不等于当前批次的 @ 顺序`,
      );
    } else {
      const sourceState = sourceStates.get(agentName);
      assert.notEqual(sourceState, undefined, `缺少 SourceState：${agentName}`);
      const expectedTargets = sourceState.expectedNextTargets;
      if (expectedTargets) {
        assert.deepEqual(
          reply.targets,
          expectedTargets,
          `${agentName} 的 @ 目标与预期不一致`,
        );
      } else if (reply.targets.length > 0) {
        assert.deepEqual(
          reply.targets,
          sourceState.defaultTargets,
          `${agentName} 的初始/全量派发目标必须等于 topology.association 默认顺序`,
        );
      }
    }

    appendLine(reply.normalized);

    if (!currentBatch) {
      const sourceState = sourceStates.get(agentName);
      assert.notEqual(sourceState, undefined, `缺少 SourceState：${agentName}`);
      sourceState.expectedNextTargets = null;

      if (reply.targets.length === 0) {
        return;
      }

      if (reply.body) {
        sourceState.currentRevision += 1;
      }

      for (const target of reply.targets) {
        assert.ok(
          (outgoingTargets.get(agentName) ?? new Set()).has(target),
          `脚本里的派发 ${agentName}: @${target} 没有对应的拓扑边`,
        );
      }

      activeBatches.push({
        source: agentName,
        targets: [...reply.targets],
        remainingTargets: [...reply.targets],
        responses: [],
        sourceRevision: sourceState.currentRevision,
        sourceHadBody: reply.body.length > 0,
      });
      return;
    }

    const currentSource = currentBatch.source;
    const failTargets = reviewFailTargets.get(agentName) ?? [];
    const isFail = reply.targets.length === 1
      && reply.targets[0] === currentSource
      && failTargets.includes(currentSource);

    currentBatch.responses.push({
      agent: agentName,
      outcome: isFail ? "fail" : "pass",
    });

    if (!isFail) {
      const sourceState = sourceStates.get(currentSource);
      assert.notEqual(sourceState, undefined, `缺少 SourceState：${currentSource}`);
      sourceState.reviewerPassRevision.set(agentName, currentBatch.sourceRevision);
    }

    if (!isFail && reply.targets.length > 0) {
      for (const target of reply.targets) {
        assert.ok(
          (outgoingTargets.get(agentName) ?? new Set()).has(target),
          `脚本里的派发 ${agentName}: @${target} 没有对应的拓扑边`,
        );
      }

      const nestedSourceState = sourceStates.get(agentName);
      assert.notEqual(nestedSourceState, undefined, `缺少 SourceState：${agentName}`);
      if (reply.body) {
        nestedSourceState.currentRevision += 1;
      }
      nestedSourceState.expectedNextTargets = null;

      activeBatches.push({
        source: agentName,
        targets: [...reply.targets],
        remainingTargets: [...reply.targets],
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
      const nextAgent = currentBatch.remainingTargets[0];
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
  const lines = script
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseScriptLine);

  assert.ok(lines.length > 0, "脚本不能为空");
  const firstLine = lines[0];
  assert.equal(firstLine?.sender, "user", "第一条脚本必须是 user: @Agent ...");

  const startAgent = extractLeadingMention(firstLine.content);
  assert.notEqual(startAgent, undefined, "第一条脚本必须以 @Agent 开头");
  assert.equal(startAgent, topology.startAgentId, "第一条 user 消息的 @Agent 必须等于 topology.startAgentId");

  const validAgents = new Set(topology.nodes);
  const agentOrder = [...topology.nodes];
  for (const agentName of agentOrder) {
    assert.ok(validAgents.has(agentName), `topology.nodes 包含未知 Agent：${agentName}`);
  }

  const repliesByAgent = new Map<string, ParsedReply[]>();
  for (const line of lines.slice(1)) {
    assert.ok(validAgents.has(line.sender), `脚本里出现了 topology 中不存在的 Agent：${line.sender}`);
    const parsedReply = parseReply(line);
    for (const target of parsedReply.targets) {
      assert.ok(validAgents.has(target), `脚本里 @ 了 topology 中不存在的 Agent：${target}`);
    }
    const currentReplies = repliesByAgent.get(line.sender) ?? [];
    currentReplies.push(parsedReply);
    repliesByAgent.set(line.sender, currentReplies);
  }

  return {
    normalizedScript: lines.map((line) => line.normalized),
    startAgent,
    lines,
    repliesByAgent,
    agentOrder,
    validAgents,
  };
}

function parseScriptLine(line: string): ParsedScriptLine {
  const separatorIndex = line.indexOf(":");
  assert.notEqual(separatorIndex, -1, `脚本缺少 sender 前缀：${line}`);
  const sender = line.slice(0, separatorIndex).trim();
  const content = line.slice(separatorIndex + 1).trim();
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

function buildAssociationTargets(topology: TopologyRecord): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const edge of topology.edges) {
    if (edge.triggerOn !== "association") {
      continue;
    }
    const current = map.get(edge.source) ?? [];
    if (!current.includes(edge.target)) {
      current.push(edge.target);
    }
    map.set(edge.source, current);
  }
  return map;
}

function buildOutgoingTargets(topology: TopologyRecord): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const edge of topology.edges) {
    const current = map.get(edge.source) ?? new Set<string>();
    current.add(edge.target);
    map.set(edge.source, current);
  }
  return map;
}

function buildTriggeredTargets(
  topology: TopologyRecord,
  triggerOn: "review_fail" | "review_pass",
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const edge of topology.edges) {
    if (edge.triggerOn !== triggerOn) {
      continue;
    }
    const current = map.get(edge.source) ?? [];
    if (!current.includes(edge.target)) {
      current.push(edge.target);
    }
    map.set(edge.source, current);
  }
  return map;
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
