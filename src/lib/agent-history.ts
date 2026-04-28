import type {
  AgentFinalMessageRecord,
  AgentRuntimeSnapshot,
  MessageRecord,
  TopologyRecord,
} from "@shared/types";
import { withOptionalValue } from "@shared/object-utils";
import { isAgentFinalMessageRecord, isDecisionAgentInTopology } from "@shared/types";
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

function normalizeHistoryDetail(content: string | null | undefined) {
  const normalized = stripDecisionResponseMarkup(content ?? "")
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

function getRuntimeItemPresentation(kind: AgentRuntimeSnapshot["activities"][number]["kind"]) {
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

  if (input.status === "continue") {
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
  topology: Pick<TopologyRecord, "edges">;
  range?: AgentHistoryRange;
  finalMessageId?: string;
}) {
  const decisionAgent = isDecisionAgentInTopology(input.topology, input.agentId);
  const finalLoopDecisionAgentName = getLoopLimitFailedDecisionAgentName(input.messages);

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
        message.decision === "continue"
          ? "continue"
          : decisionAgent && finalLoopDecisionAgentName === input.agentId
            ? "final_failed_decision"
            : message.status;
      const presentation = getFinalItemPresentation({
        decisionAgent,
        status,
      });
      const detail = normalizeHistoryDetail(message.content);

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

function buildRuntimeHistoryItems(input: {
  agentId: string;
  runtimeSnapshot?: AgentRuntimeSnapshot;
  finalHistoryItems?: AgentHistoryItem[];
  range?: AgentHistoryRange;
}) {
  if (!input.runtimeSnapshot) {
    return [];
  }

  const finalMessageSignatures = new Set(
    (input.finalHistoryItems ?? []).map((item) => `${item.timestamp}:::${item.detail}`),
  );
  const finalMessageIds = new Set((input.finalHistoryItems ?? []).map((item) => item.id));
  const belongsToFinalMessage = (activityId: string) =>
    [...finalMessageIds].some((messageId) => activityId.startsWith(`${messageId}:`));

  return mergeAdjacentRuntimeToolHistoryItems(
    input.runtimeSnapshot.activities
      .filter((activity) => isTimestampWithinAgentHistoryRange(activity.timestamp, input.range ?? {}))
      .map((activity, index) => {
        const presentation = getRuntimeItemPresentation(activity.kind);
        const detail =
          activity.kind === "tool"
            ? normalizeToolHistory(activity.label, activity.detail)
            : normalizeHistoryDetail(activity.detail || activity.label);
        const runtimeItem = {
          id: `${input.agentId}-runtime-${activity.id}-${index}`,
          label: presentation.label,
          detailSnippet: buildHistoryDetailSnippet(detail),
          detail,
          timestamp: activity.timestamp,
          sortTimestamp: `${activity.timestamp}#a-runtime-${String(index).padStart(6, "0")}`,
          tone: presentation.tone,
        } satisfies AgentHistoryItem;
        return {
          runtimeItem,
          activityId: activity.id,
        };
      })
      .filter((item) => {
        if (item.runtimeItem.tone === "runtime-message" && belongsToFinalMessage(item.activityId)) {
          return false;
        }

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
  topology: Pick<TopologyRecord, "edges">;
  runtimeSnapshot?: AgentRuntimeSnapshot;
}) {
  const finalHistoryItems = buildFinalHistoryItems(input);
  return [
    ...finalHistoryItems,
    ...buildRuntimeHistoryItems({
      ...input,
      finalHistoryItems,
    }),
  ].sort((left, right) => left.sortTimestamp.localeCompare(right.sortTimestamp));
}

export function buildAgentExecutionHistoryItems(input: {
  agentId: string;
  messages: MessageRecord[];
  topology: Pick<TopologyRecord, "edges">;
  runtimeSnapshot?: AgentRuntimeSnapshot;
  startedAt: string;
  finalMessageId?: string;
  completedAt?: string;
}) {
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
    ...buildRuntimeHistoryItems(withOptionalValue({
      agentId: input.agentId,
      finalHistoryItems,
      range,
    }, "runtimeSnapshot", input.runtimeSnapshot)),
    ...finalHistoryItems,
  ].sort((left, right) => left.sortTimestamp.localeCompare(right.sortTimestamp));
}
