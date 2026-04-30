import type {
  AgentFinalMessageRecord,
  AgentProgressMessageRecord,
  MessageRecord,
  TopologyRecord,
} from "@shared/types";
import { withOptionalValue } from "@shared/object-utils";
import {
  isAgentFinalMessageRecord,
  isAgentProgressMessageRecord,
  normalizeTopologyEdgeTrigger,
} from "@shared/types";
import { stripDecisionResponseMarkup } from "@shared/decision-response";
import { getLoopLimitFailedDecisionAgentName } from "./decision-loop-limit";

export interface AgentHistoryItem {
  id: string;
  label: string;
  detailSnippet: string;
  detail: string;
  timestamp: string;
  sortTimestamp: string;
  tone:
    | "success"
    | "failure"
    | "runtime-tool"
    | "runtime-thinking"
    | "runtime-step"
    | "runtime-message";
}

export const EMPTY_AGENT_HISTORY_DETAIL = "暂无详细记录";

interface AgentHistoryRange {
  startedAt?: string;
  endedAt?: string;
}

function hasActionRequiredFollowUp(messages: MessageRecord[], finalMessageId: string): boolean {
  return messages.some((message) =>
    message.kind === "action-required-request" && message.followUpMessageId === finalMessageId
  );
}

function getAgentAllowedTriggers(
  topology: Pick<TopologyRecord, "edges" | "langgraph" | "nodeRecords" | "spawnRules">,
  agentId: string,
): string[] {
  const sourceAgentIds = getHistorySourceAgentIds(topology, agentId);
  return [...new Set(
    [
      ...topology.edges
        .filter((edge) => sourceAgentIds.includes(edge.source))
        .map((edge) => normalizeTopologyEdgeTrigger(edge.trigger)),
      ...(topology.langgraph?.end?.incoming ?? [])
        .filter((edge) => sourceAgentIds.includes(edge.source))
        .map((edge) => normalizeTopologyEdgeTrigger(edge.trigger)),
      ...sourceAgentIds.flatMap((templateName) => getUniqueSpawnRuleTriggersForTemplate(topology, templateName)),
    ],
  )];
}

function getUniqueSpawnRuleTriggersForTemplate(
  topology: Pick<TopologyRecord, "spawnRules">,
  templateName: string,
): string[] {
  const matchedRules = (topology.spawnRules ?? []).filter((rule) =>
    rule.spawnedAgents.some((agent) => agent.templateName === templateName),
  );
  if (matchedRules.length !== 1) {
    return [];
  }

  const sourceRoles = matchedRules[0]!.spawnedAgents
    .filter((agent) => agent.templateName === templateName)
    .map((agent) => agent.role);
  return matchedRules[0]!.edges
    .filter((edge) => sourceRoles.includes(edge.sourceRole))
    .map((edge) => normalizeTopologyEdgeTrigger(edge.trigger));
}

function getHistorySourceAgentIds(
  topology: Pick<TopologyRecord, "edges" | "nodeRecords">,
  agentId: string,
): string[] {
  const resolved = new Set([agentId]);
  if (topology.edges.some((edge) => edge.source === agentId)) {
    return [...resolved];
  }

  const runtimeTemplateName = resolveRuntimeAgentTemplateName(agentId);
  if (!runtimeTemplateName) {
    return [...resolved];
  }
  const matchedNode = (topology.nodeRecords ?? []).find((node) => node.templateName === runtimeTemplateName);
  if (matchedNode) {
    resolved.add(matchedNode.templateName);
  }
  return [...resolved];
}

function resolveRuntimeAgentTemplateName(agentId: string): string {
  const match = /^(.*)-(\d+)$/u.exec(agentId);
  const templateName = match?.[1]?.trim() ?? "";
  return templateName;
}

function isHistoryDecisionAgent(
  topology: Pick<TopologyRecord, "edges" | "langgraph" | "nodeRecords" | "spawnRules">,
  agentId: string,
): boolean {
  return getAgentAllowedTriggers(topology, agentId).some((trigger) => trigger !== "<default>");
}

function normalizeHistoryDetail(
  content: string,
  allowedTriggers: readonly string[],
) {
  const normalized = stripDecisionResponseMarkup(content, allowedTriggers)
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .trim();
  return normalized || EMPTY_AGENT_HISTORY_DETAIL;
}

function buildHistoryDetailSnippet(detail: string) {
  const normalized = detail
    .replace(/\n\s*\n+/gu, "\n")
    .trim();
  return normalized || EMPTY_AGENT_HISTORY_DETAIL;
}

function normalizeToolHistory(toolName: string, detail: string) {
  const normalizedDetail = detail.replace(/^参数:\s*/u, "").trim();
  return normalizeHistoryDetail(
    normalizedDetail ? `${toolName.trim()} · 参数: ${normalizedDetail}` : toolName.trim(),
    [],
  );
}

function mergeAdjacentRuntimeToolHistoryItems(items: AgentHistoryItem[]) {
  const mergedItems: AgentHistoryItem[] = [];
  let pendingToolItems: AgentHistoryItem[] = [];

  const flushPendingToolItems = () => {
    if (pendingToolItems.length === 0) {
      return;
    }

    if (pendingToolItems.length === 1) {
      mergedItems.push(pendingToolItems[0]!);
      pendingToolItems = [];
      return;
    }

    const firstToolItem = pendingToolItems[0]!;
    const lastToolItem = pendingToolItems[pendingToolItems.length - 1]!;
    const detail = pendingToolItems.map((item) => `- ${item.detail}`).join("\n");

    mergedItems.push({
      ...firstToolItem,
      id: `${firstToolItem.id}::tool-group::${lastToolItem.id}`,
      label: `工具（${pendingToolItems.length}）`,
      detailSnippet: buildHistoryDetailSnippet(detail),
      detail,
      timestamp: lastToolItem.timestamp,
    });
    pendingToolItems = [];
  };

  for (const item of items) {
    if (item.tone === "runtime-tool") {
      pendingToolItems.push(item);
      continue;
    }

    flushPendingToolItems();
    mergedItems.push(item);
  }

  flushPendingToolItems();
  return mergedItems;
}

function getRuntimeItemPresentation(kind: AgentProgressMessageRecord["activityKind"]) {
  switch (kind) {
    case "tool":
      return { label: "工具", tone: "runtime-tool" as const };
    case "thinking":
      return { label: "思考", tone: "runtime-thinking" as const };
    case "step":
      return { label: "步骤", tone: "runtime-step" as const };
    default:
      return { label: "消息", tone: "runtime-message" as const };
  }
}

function getFinalItemPresentation(input: {
  decisionAgent: boolean;
  status: string;
}) {
  if (input.status === "final_failed_decision") {
    return {
      label: "继续处理，最后一次",
      tone: "failure" as const,
    };
  }

  if (input.status === "action_required") {
    return {
      label: "继续处理",
      tone: "failure" as const,
    };
  }

  if (input.status === "failed") {
    return {
      label: input.decisionAgent ? "继续处理" : "执行失败",
      tone: "failure" as const,
    };
  }

  return {
    label: input.decisionAgent ? "已完成判定" : "已完成",
    tone: "success" as const,
  };
}

function isTimestampWithinAgentHistoryRange(
  timestamp: string,
  range: AgentHistoryRange,
) {
  if (range.startedAt && timestamp.localeCompare(range.startedAt) < 0) {
    return false;
  }
  if (range.endedAt && timestamp.localeCompare(range.endedAt) > 0) {
    return false;
  }
  return true;
}

function buildFinalHistoryItems(input: {
  agentId: string;
  messages: MessageRecord[];
  topology: Pick<TopologyRecord, "edges" | "langgraph" | "nodeRecords" | "spawnRules">;
  range?: AgentHistoryRange;
  finalMessageId?: string;
}) {
  const decisionAgent = isHistoryDecisionAgent(input.topology, input.agentId);
  const finalLoopDecisionAgentName = getLoopLimitFailedDecisionAgentName(input.messages);
  const allowedTriggers = decisionAgent ? getAgentAllowedTriggers(input.topology, input.agentId) : [];

  return input.messages
    .filter(
      (message): message is AgentFinalMessageRecord =>
        message.sender === input.agentId && isAgentFinalMessageRecord(message),
    )
    .filter((message) => {
      if (input.finalMessageId && message.id !== input.finalMessageId) {
        return false;
      }
      return isTimestampWithinAgentHistoryRange(message.timestamp, input.range ?? {});
    })
    .map((message) => {
      const status =
        hasActionRequiredFollowUp(input.messages, message.id)
          ? "action_required"
          : decisionAgent && message.status === "error" && finalLoopDecisionAgentName === input.agentId
            ? "final_failed_decision"
            : message.status;
      const presentation = getFinalItemPresentation({
        decisionAgent,
        status,
      });
      const detail = normalizeHistoryDetail(message.content, allowedTriggers);

      return {
        id: message.id,
        label: presentation.label,
        detailSnippet: buildHistoryDetailSnippet(detail),
        detail,
        timestamp: message.timestamp,
        sortTimestamp: `${message.timestamp}#z-final`,
        tone: presentation.tone,
      } satisfies AgentHistoryItem;
    });
}

function buildProgressHistoryItems(input: {
  agentId: string;
  messages: MessageRecord[];
  finalHistoryItems?: AgentHistoryItem[];
  range?: AgentHistoryRange;
  allowedTriggers: readonly string[];
}) {
  const finalMessageSignatures = new Set(
    (input.finalHistoryItems ?? []).map((item) => `${item.timestamp}:::${item.detail}`),
  );

  return mergeAdjacentRuntimeToolHistoryItems(
    input.messages
      .filter(
        (message): message is AgentProgressMessageRecord =>
          message.sender === input.agentId && isAgentProgressMessageRecord(message),
      )
      .filter((message) => isTimestampWithinAgentHistoryRange(message.timestamp, input.range ?? {}))
      .map((message, index) => {
        const presentation = getRuntimeItemPresentation(message.activityKind);
        const detail =
          message.activityKind === "tool"
            ? normalizeToolHistory(message.label, message.detail)
            : normalizeHistoryDetail(message.detail || message.label, input.allowedTriggers);
        const runtimeItem = {
          id: `${input.agentId}-runtime-${message.id}-${index}`,
          label: presentation.label,
          detailSnippet: buildHistoryDetailSnippet(detail),
          detail,
          timestamp: message.timestamp,
          sortTimestamp: `${message.timestamp}#a-runtime-${String(index).padStart(6, "0")}`,
          tone: presentation.tone,
        } satisfies AgentHistoryItem;
        return {
          runtimeItem,
          message,
        };
      })
      .filter((item) => {
        if (item.runtimeItem.tone !== "runtime-message") {
          return true;
        }

        return !finalMessageSignatures.has(
          `${item.runtimeItem.timestamp}:::${item.runtimeItem.detail}`,
        );
      })
      .map((item) => item.runtimeItem),
  );
}

export function buildAgentHistoryItems(input: {
  agentId: string;
  messages: MessageRecord[];
  topology: Pick<TopologyRecord, "edges" | "langgraph" | "nodeRecords" | "spawnRules">;
}) {
  const allowedTriggers = isHistoryDecisionAgent(input.topology, input.agentId)
    ? getAgentAllowedTriggers(input.topology, input.agentId)
    : [];
  const finalHistoryItems = buildFinalHistoryItems(input);
  return [
    ...finalHistoryItems,
    ...buildProgressHistoryItems({
      agentId: input.agentId,
      messages: input.messages,
      finalHistoryItems,
      allowedTriggers,
    }),
  ].sort((left, right) => left.sortTimestamp.localeCompare(right.sortTimestamp));
}

export function buildAgentExecutionHistoryItems(input: {
  agentId: string;
  messages: MessageRecord[];
  topology: Pick<TopologyRecord, "edges" | "langgraph" | "nodeRecords" | "spawnRules">;
  startedAt: string;
  finalMessageId?: string;
  completedAt?: string;
}) {
  const allowedTriggers = isHistoryDecisionAgent(input.topology, input.agentId)
    ? getAgentAllowedTriggers(input.topology, input.agentId)
    : [];
  const range = withOptionalValue({
    startedAt: input.startedAt,
  }, "endedAt", input.completedAt) satisfies AgentHistoryRange;
  const finalHistoryItems = buildFinalHistoryItems(withOptionalValue({
    agentId: input.agentId,
    messages: input.messages,
    topology: input.topology,
    range,
  }, "finalMessageId", input.finalMessageId));

  return [
    ...buildProgressHistoryItems({
      agentId: input.agentId,
      messages: input.messages,
      finalHistoryItems,
      range,
      allowedTriggers,
    }),
    ...finalHistoryItems,
  ].sort((left, right) => left.sortTimestamp.localeCompare(right.sortTimestamp));
}
