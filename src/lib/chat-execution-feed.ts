import type {
  AgentFinalMessageRecord,
  MessageRecord,
  TopologyRecord,
} from "@shared/types";
import { parseTargetAgentIds } from "@shared/chat-message-format";
import {
  buildAgentExecutionHistoryItems,
  type AgentHistoryItem,
} from "./agent-history";
import { mergeTaskChatMessages, type ChatMessageItem } from "./chat-messages";

interface ChatExecutionWindowBase {
  id: string;
  agentId: string;
  runCount: number;
  anchorMessageId: string;
  triggerMessageId: string;
  startedAt: string;
}

type RunningChatExecutionWindow = ChatExecutionWindowBase & {
  status: "running";
};

type SettledChatExecutionWindow = ChatExecutionWindowBase & {
  status: "settled";
  finalMessageId: string;
  finalRawMessageId: string;
  completedAt: string;
};

type ChatExecutionWindow =
  | RunningChatExecutionWindow
  | SettledChatExecutionWindow;

type ChatFeedMessageItem = {
  type: "message";
  id: string;
  message: ChatMessageItem;
};

export type ChatFeedExecutionItem =
  | {
      type: "execution";
      id: string;
      status: "running";
      agentId: string;
      anchorMessageId: string;
      startedAt: string;
      historyItems: AgentHistoryItem[];
    }
  | {
      type: "execution";
      id: string;
      status: "settled";
      agentId: string;
      anchorMessageId: string;
      startedAt: string;
      completedAt: string;
      message: ChatMessageItem;
    };

type ChatFeedItem = ChatFeedMessageItem | ChatFeedExecutionItem;

function isVisibleChatExecutionTrigger(message: MessageRecord) {
  return (
    message.kind === "user" ||
    message.kind === "agent-dispatch" ||
    message.kind === "action-required-request"
  );
}

function getVisibleChatExecutionTargets(message: MessageRecord): string[] {
  if (!isVisibleChatExecutionTrigger(message)) {
    return [];
  }
  return parseTargetAgentIds(message.targetAgentIds);
}

function getVisibleChatExecutionTargetRunCounts(
  message: MessageRecord,
): number[] {
  if (!isVisibleChatExecutionTrigger(message)) {
    return [];
  }
  return message.targetRunCounts;
}

function getMergedMessageIndexByRawMessageId(
  mergedMessages: ChatMessageItem[],
) {
  const indexByRawMessageId = new Map<string, number>();

  for (const [index, message] of mergedMessages.entries()) {
    for (const chainedMessage of message.messageChain) {
      indexByRawMessageId.set(chainedMessage.id, index);
    }
  }

  return indexByRawMessageId;
}

function getFinalRawMessageFromMergedMessage(
  message: ChatMessageItem,
): AgentFinalMessageRecord | undefined {
  for (const chainedMessage of message.messageChain) {
    if (chainedMessage.kind === "agent-final") {
      return chainedMessage;
    }
  }
  return undefined;
}

function compareExecutionWindows(
  left: ChatExecutionWindow,
  right: ChatExecutionWindow,
): number {
  return left.startedAt.localeCompare(right.startedAt);
}

export function buildChatExecutionWindows(
  messages: MessageRecord[],
  mergedMessages: ChatMessageItem[],
): ChatExecutionWindow[] {
  const mergedMessageIndexByRawMessageId =
    getMergedMessageIndexByRawMessageId(mergedMessages);
  const windows: ChatExecutionWindow[] = messages.flatMap((message) => {
    const targets = getVisibleChatExecutionTargets(message);
    const targetRunCounts = getVisibleChatExecutionTargetRunCounts(message);
    if (targets.length === 0) {
      return [];
    }

    const mergedMessageIndex = mergedMessageIndexByRawMessageId.get(message.id);
    if (mergedMessageIndex === undefined) {
      return [];
    }

    const anchorMessageId = mergedMessages[mergedMessageIndex]?.id;
    if (!anchorMessageId) {
      return [];
    }

    return targets.map((agentId, targetIndex) => {
      const runCount = targetRunCounts[targetIndex];
      if (runCount === undefined) {
        throw new Error(
          `消息 ${message.id} 缺少 ${agentId} 的 targetRunCounts`,
        );
      }
      return {
        id: `${message.id}:${agentId}:${targetIndex}`,
        status: "running" as const,
        agentId,
        runCount,
        anchorMessageId,
        triggerMessageId: message.id,
        startedAt: message.timestamp,
      };
    });
  });

  const pendingWindowIndexesByExecutionKey = new Map<string, number>();
  for (const [index, window] of windows.entries()) {
    pendingWindowIndexesByExecutionKey.set(
      `${window.agentId}::${window.runCount}`,
      index,
    );
  }

  for (const mergedMessage of mergedMessages) {
    const finalRawMessage = getFinalRawMessageFromMergedMessage(mergedMessage);
    if (!finalRawMessage) {
      continue;
    }

    const matchedWindowIndex = pendingWindowIndexesByExecutionKey.get(
      `${finalRawMessage.sender}::${finalRawMessage.runCount}`,
    );
    if (matchedWindowIndex === undefined) {
      continue;
    }

    const matchedWindow = windows[matchedWindowIndex];
    if (!matchedWindow || matchedWindow.status !== "running") {
      continue;
    }

    windows[matchedWindowIndex] = {
      ...matchedWindow,
      status: "settled",
      finalMessageId: mergedMessage.id,
      finalRawMessageId: finalRawMessage.id,
      completedAt: finalRawMessage.timestamp,
    };
  }

  return windows.sort(compareExecutionWindows);
}

export function buildChatFeedItems(input: {
  messages: MessageRecord[];
  topology: Pick<
    TopologyRecord,
    "edges" | "nodes" | "nodeRecords" | "langgraph" | "spawnRules"
  >;
}): ChatFeedItem[] {
  const orderedMessages = [...input.messages].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );
  const mergedMessages = mergeTaskChatMessages(
    orderedMessages.filter((message) => message.kind !== "agent-progress"),
  );
  const executionWindows = buildChatExecutionWindows(
    orderedMessages,
    mergedMessages,
  ).sort(compareExecutionWindows);
  const absorbedMergedMessageIds = new Set(
    executionWindows
      .filter(
        (window): window is SettledChatExecutionWindow =>
          window.status === "settled",
      )
      .map((window) => window.finalMessageId),
  );
  const windowsByAnchorMessageId = new Map<string, ChatExecutionWindow[]>();
  const mergedMessageById = new Map(
    mergedMessages.map((message) => [message.id, message]),
  );

  for (const window of executionWindows) {
    const windows = windowsByAnchorMessageId.get(window.anchorMessageId) ?? [];
    windows.push(window);
    windowsByAnchorMessageId.set(window.anchorMessageId, windows);
  }

  const feedItems: ChatFeedItem[] = [];
  for (const mergedMessage of mergedMessages) {
    if (!absorbedMergedMessageIds.has(mergedMessage.id)) {
      feedItems.push({
        type: "message",
        id: mergedMessage.id,
        message: mergedMessage,
      });
    }

    const anchoredWindows =
      windowsByAnchorMessageId.get(mergedMessage.id) ?? [];
    for (const window of anchoredWindows) {
      if (window.status === "settled") {
        const finalMessage = mergedMessageById.get(window.finalMessageId);
        if (!finalMessage) {
          continue;
        }

        feedItems.push({
          type: "execution",
          id: window.id,
          status: "settled",
          agentId: window.agentId,
          anchorMessageId: window.anchorMessageId,
          startedAt: window.startedAt,
          completedAt: window.completedAt,
          message: finalMessage,
        });
        continue;
      }

      feedItems.push({
        type: "execution",
        id: window.id,
        status: "running",
        agentId: window.agentId,
        anchorMessageId: window.anchorMessageId,
        startedAt: window.startedAt,
        historyItems: buildAgentExecutionHistoryItems({
          agentId: window.agentId,
          messages: orderedMessages,
          topology: input.topology,
          startedAt: window.startedAt,
        }),
      });
    }
  }

  return feedItems;
}
