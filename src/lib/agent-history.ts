import type {
  AgentRuntimeSnapshot,
  MessageRecord,
  TopologyRecord,
} from "@shared/types";
import { isReviewAgentInTopology } from "@shared/types";
import { stripReviewResponseMarkup } from "@shared/review-response";
import { getLoopLimitFailedReviewerName } from "./review-loop-limit";

export interface AgentHistoryItem {
  id: string;
  label: string;
  previewDetail: string;
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

function normalizeHistoryDetail(content: string | null | undefined) {
  const normalized = stripReviewResponseMarkup(content ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .trim();
  return normalized || "暂无详细记录";
}

function buildHistoryPreviewDetail(detail: string) {
  const normalized = detail
    .replace(/\n\s*\n+/gu, "\n")
    .trim();
  return normalized || "暂无详细记录";
}

function normalizeToolHistory(toolName: string, detail: string) {
  const normalizedDetail = detail.replace(/^参数:\s*/u, "").trim();
  return normalizeHistoryDetail(
    normalizedDetail ? `${toolName.trim()} · 参数: ${normalizedDetail}` : toolName.trim(),
  );
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
  reviewAgent: boolean;
  status: string;
}) {
  if (input.status === "final_failed_review") {
    return {
      label: "审视不通过，最后一次",
      tone: "failure" as const,
    };
  }

  if (input.status === "needs_revision") {
    return {
      label: "审视不通过",
      tone: "failure" as const,
    };
  }

  if (input.status === "failed") {
    return {
      label: input.reviewAgent ? "审视不通过" : "执行失败",
      tone: "failure" as const,
    };
  }

  return {
    label: input.reviewAgent ? "审视通过" : "已完成",
    tone: "success" as const,
  };
}

function buildFinalHistoryItems(input: {
  agentId: string;
  messages: MessageRecord[];
  topology: Pick<TopologyRecord, "edges">;
}) {
  const reviewAgent = isReviewAgentInTopology(input.topology, input.agentId);
  const finalLoopReviewerName = getLoopLimitFailedReviewerName(input.messages);

  return input.messages
    .filter((message) => message.sender === input.agentId && message.meta?.kind === "agent-final")
    .map((message) => {
      const status =
        message.meta?.reviewDecision === "needs_revision"
          ? "needs_revision"
          : reviewAgent && message.meta?.status === "failed" && finalLoopReviewerName === input.agentId
            ? "final_failed_review"
            : message.meta?.status ?? "completed";
      const presentation = getFinalItemPresentation({
        reviewAgent,
        status,
      });
      const detail = normalizeHistoryDetail(message.meta?.finalMessage ?? message.content);

      return {
        id: message.id,
        label: presentation.label,
        previewDetail: buildHistoryPreviewDetail(detail),
        detail,
        timestamp: message.timestamp,
        sortTimestamp: message.timestamp,
        tone: presentation.tone,
      } satisfies AgentHistoryItem;
    });
}

function buildRuntimeHistoryItems(input: {
  agentId: string;
  runtimeSnapshot?: AgentRuntimeSnapshot;
  finalHistoryItems?: AgentHistoryItem[];
}) {
  if (!input.runtimeSnapshot) {
    return [];
  }

  const finalMessageSignatures = new Set(
    (input.finalHistoryItems ?? []).map((item) => `${item.sortTimestamp}:::${item.detail}`),
  );
  const finalMessageIds = new Set((input.finalHistoryItems ?? []).map((item) => item.id));
  const belongsToFinalMessage = (activityId: string) =>
    [...finalMessageIds].some((messageId) => activityId.startsWith(`${messageId}:`));

  return input.runtimeSnapshot.activities.map((activity, index) => {
    const presentation = getRuntimeItemPresentation(activity.kind);
    const detail =
      activity.kind === "tool"
        ? normalizeToolHistory(activity.label, activity.detail)
        : normalizeHistoryDetail(activity.detail || activity.label);
    const runtimeItem = {
      id: `${input.agentId}-runtime-${activity.id}-${index}`,
      label: presentation.label,
      previewDetail: buildHistoryPreviewDetail(detail),
      detail,
      timestamp: activity.timestamp,
      sortTimestamp: activity.timestamp,
      tone: presentation.tone,
    } satisfies AgentHistoryItem;
    return {
      runtimeItem,
      activityId: activity.id,
    };
  }).filter((item) => {
    if (belongsToFinalMessage(item.activityId)) {
      return false;
    }

    if (item.runtimeItem.tone !== "runtime-message") {
      return true;
    }

    return !finalMessageSignatures.has(
      `${item.runtimeItem.sortTimestamp}:::${item.runtimeItem.detail}`,
    );
  }).map((item) => item.runtimeItem);
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
