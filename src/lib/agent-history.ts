import type {
  AgentFinalMessageRecord,
  AgentProgressMessageRecord,
  MessageRecord,
  TopologyRecord,
  UtcIsoTimestamp,
} from "@shared/types";
import {
  getTopologyNodeRecords,
  isAgentFinalMessageRecord,
  isAgentProgressMessageRecord,
  normalizeTopologyEdgeTrigger,
} from "@shared/types";
import { stripDecisionResponseMarkup } from "@shared/decision-response";

export interface AgentHistoryItem {
  label: string;
  detailSnippet: string;
  detail: string;
  timestamp: UtcIsoTimestamp;
  sortTimestamp: string;
  tone:
    | "success"
    | "failure"
    | "runtime-tool"
    | "runtime-thinking"
    | "runtime-step"
    | "runtime-message";
}

const EMPTY_AGENT_HISTORY_DETAIL = "暂无详细记录";

interface AgentHistoryRange {
  startedAt?: UtcIsoTimestamp;
  endedAt?: UtcIsoTimestamp;
}

function getAgentAllowedTriggers(
  topology: Pick<TopologyRecord, "edges" | "flow" | "nodeRecords" | "groupRules">,
  agentId: string,
): string[] {
  const sourceAgentIds = getHistorySourceAgentIds(topology, agentId);
  return [...new Set(
    [
      ...topology.edges
        .filter((edge) => sourceAgentIds.includes(edge.source))
        .map((edge) => normalizeTopologyEdgeTrigger(edge.trigger)),
      ...topology.flow.end.incoming
        .filter((edge) => sourceAgentIds.includes(edge.source))
        .map((edge) => normalizeTopologyEdgeTrigger(edge.trigger)),
      ...sourceAgentIds.flatMap((templateName) => getUniqueGroupRuleTriggersForTemplate(topology, templateName)),
    ],
  )];
}

function getUniqueGroupRuleTriggersForTemplate(
  topology: Pick<TopologyRecord, "groupRules">,
  templateName: string,
): string[] {
  const matchedRules = (topology.groupRules ?? []).filter((rule) =>
    rule.members.some((agent) => agent.templateName === templateName),
  );
  if (matchedRules.length !== 1) {
    return [];
  }

  const sourceRoles = matchedRules[0]!.members
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
  const matchedNode = getTopologyNodeRecords(topology as TopologyRecord)
    .find((node) => node.templateName === runtimeTemplateName);
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
  topology: Pick<TopologyRecord, "edges" | "flow" | "nodeRecords" | "groupRules">,
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
  message: AgentFinalMessageRecord;
  status: AgentFinalMessageRecord["status"];
}) {
  if (input.status === "error") {
    return {
      label: "执行失败",
      tone: "failure" as const,
    };
  }

  return {
    label: input.message.routingKind === "triggered" ? input.message.trigger : "已完成",
    tone: "success" as const,
  };
}

function isTimestampWithinAgentHistoryRange(
  timestamp: UtcIsoTimestamp,
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

function mapAgentFinalHistoryItem(input: {
  agentId: string;
  messages: MessageRecord[];
  topology: Pick<TopologyRecord, "edges" | "flow" | "nodeRecords" | "groupRules">;
  message: AgentFinalMessageRecord;
}) {
  const decisionAgent = isHistoryDecisionAgent(input.topology, input.agentId);
  const allowedTriggers = decisionAgent ? getAgentAllowedTriggers(input.topology, input.agentId) : [];

  const presentation = getFinalItemPresentation({
    message: input.message,
    status: input.message.status,
  });
  const detail = decisionAgent
    ? stripDecisionResponseMarkup(input.message.rawResponse, allowedTriggers)
      .replace(/\r\n?/gu, "\n")
      .replace(/[ \t]+\n/gu, "\n")
      .trim()
    : normalizeHistoryDetail(input.message.content, allowedTriggers);

  return {
    label: presentation.label,
    detailSnippet: buildHistoryDetailSnippet(detail),
    detail,
    timestamp: input.message.timestamp,
    sortTimestamp: `${input.message.timestamp}#z-final`,
    tone: presentation.tone,
  } satisfies AgentHistoryItem;
}

function buildFilteredAgentFinalHistoryItems(input: {
  agentId: string;
  messages: MessageRecord[];
  topology: Pick<TopologyRecord, "edges" | "flow" | "nodeRecords" | "groupRules">;
  range?: AgentHistoryRange;
  finalMessageId?: string;
}) {
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
    .map((message) =>
      mapAgentFinalHistoryItem({
        agentId: input.agentId,
        messages: input.messages,
        topology: input.topology,
        message,
      }),
    );
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

export function buildAgentFinalHistoryItems(input: {
  agentId: string;
  messages: MessageRecord[];
  topology: Pick<TopologyRecord, "edges" | "flow" | "nodeRecords" | "groupRules">;
}) {
  return buildFilteredAgentFinalHistoryItems(input)
    .filter((item) => item.detail !== EMPTY_AGENT_HISTORY_DETAIL)
    .sort((left, right) => left.sortTimestamp.localeCompare(right.sortTimestamp));
}

export function buildAgentHistoryItems(input: {
  agentId: string;
  messages: MessageRecord[];
  topology: Pick<TopologyRecord, "edges" | "flow" | "nodeRecords" | "groupRules">;
}) {
  const allowedTriggers = isHistoryDecisionAgent(input.topology, input.agentId)
    ? getAgentAllowedTriggers(input.topology, input.agentId)
    : [];
  const finalHistoryItems = buildFilteredAgentFinalHistoryItems(input);
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
  topology: Pick<TopologyRecord, "edges" | "flow" | "nodeRecords" | "groupRules">;
  startedAt: UtcIsoTimestamp;
  finalMessageId?: string;
  completedAt?: UtcIsoTimestamp;
}) {
  // 2026-05-29: 用户要求历史范围对象只在边界写入确定字段，禁止通过共享 helper 传播可空 completedAt/finalMessageId 语义。
  const allowedTriggers = isHistoryDecisionAgent(input.topology, input.agentId)
    ? getAgentAllowedTriggers(input.topology, input.agentId)
    : [];
  const range = input.completedAt
    ? {
        startedAt: input.startedAt,
        endedAt: input.completedAt,
      }
    : {
        startedAt: input.startedAt,
      } satisfies AgentHistoryRange;
  const finalHistoryItems = buildFilteredAgentFinalHistoryItems(input.finalMessageId
    ? {
        agentId: input.agentId,
        messages: input.messages,
        topology: input.topology,
        range,
        finalMessageId: input.finalMessageId,
      }
    : {
      agentId: input.agentId,
      messages: input.messages,
      topology: input.topology,
      range,
    });

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
