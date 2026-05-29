import { useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import {
  type AgentIdResolution,
  resolvePrimaryTopologyStartTarget,
  type TaskSnapshot,
  type WorkspaceSnapshot,
} from "@shared/types";
import { resolveTaskSubmissionTarget } from "@shared/task-submission";
import { cn } from "@/lib/utils";
import { getAgentColorToken } from "@/lib/agent-colors";
import { resolveChatMessageAttachButtonState } from "@/lib/chat-attach-button";
import type { AgentHistoryItem } from "@/lib/agent-history";
import { mergeTaskChatMessages, type ChatMessageItem } from "@/lib/chat-messages";
import {
  buildChatFeedItems,
  type ChatFeedExecutionItem,
} from "@/lib/chat-execution-feed";
import {
  AGENT_HISTORY_DETAIL_TEXT_CLASS,
  AGENT_HISTORY_META_TEXT_CLASS,
} from "@/lib/agent-history-display";
import {
  getMentionContext,
  getMentionOptionItems,
  type MentionContextState,
} from "@/lib/chat-mentions";
import { AgentHistoryMarkdown } from "@/lib/agent-history-markdown";
import { MarkdownMessage } from "@/lib/chat-markdown";
import { PANEL_HEADER_ACTION_BUTTON_CLASS } from "@/lib/panel-header-action-button";
import { getPanelFullscreenButtonCopy } from "@/lib/panel-fullscreen-label";
import {
  PANEL_HEADER_CLASS,
  PANEL_HEADER_LEADING_CLASS,
  PANEL_HEADER_TITLE_CLASS,
  PANEL_SECTION_BODY_CLASS,
  PANEL_SURFACE_CLASS,
} from "@/lib/panel-header";
import { formatChatTranscript, getChatSenderLabel } from "@/lib/chat-transcript";
import {
  scrollTopologyHistoryToBottom,
  shouldAutoScrollTopologyHistory,
  shouldStickTopologyHistoryToBottom,
} from "@/lib/topology-history-scroll";

interface ChatWindowProps {
  workspace: WorkspaceSnapshot;
  task: TaskSnapshot;
  availableAgents: string[];
  taskLogFilePath: string;
  taskUrl: string;
  isMaximized?: boolean;
  onToggleMaximize?: () => void;
  onOpenAgentTerminal?: (agentId: string) => void;
  onSubmit: (payload: { content: string }) => Promise<void>;
}

const MENTION_MENU_WIDTH = 224;
const MENTION_MENU_MAX_VISIBLE_ITEMS = 5;
const MENTION_MENU_ITEM_HEIGHT = 41;
const MENTION_MENU_HEADER_HEIGHT = 28;
const MENTION_MENU_VERTICAL_PADDING = 16;
const MENTION_MENU_GAP = 12;
const MENTION_MENU_VIEWPORT_MARGIN = 12;
const CHAT_EXECUTION_BUBBLE_MAX_HEIGHT_PX = 300;
const CHAT_VISIBLE_FEED_ITEM_LIMIT = 30;
type RunningChatFeedExecutionItem = Exclude<ChatFeedExecutionItem, { status: "settled" }>;

function buildChatFeedItemRenderKey(
  item: ReturnType<typeof buildChatFeedItems>[number],
) {
  return item.type === "message"
    ? `message:${item.message.id}`
    : `execution:${item.agentId}:${item.anchorMessageId}:${item.runCount}`;
}

function resolveHistoryTailVersion(items: readonly AgentHistoryItem[]) {
  const last = items.at(-1);
  return last ? `${items.length}:${last.sortTimestamp}` : "0:";
}

function getRuntimeExecutionBadgePresentation() {
  return {
    ariaLabel: "运行中",
    title: "运行中",
    className: "border border-[#d8b14a]/70 bg-[linear-gradient(180deg,#fff7d8_0%,#ffedb8_100%)] text-[#6b5208] topology-status-badge-running",
    iconClassName: "animate-spin motion-reduce:animate-none",
  };
}

function getCaretCoordinates(textarea: HTMLTextAreaElement, position: number) {
  const div = document.createElement("div");
  const style = window.getComputedStyle(textarea);
  const properties = [
    "boxSizing",
    "width",
    "height",
    "overflowX",
    "overflowY",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "fontStyle",
    "fontVariant",
    "fontWeight",
    "fontStretch",
    "fontSize",
    "fontSizeAdjust",
    "lineHeight",
    "fontFamily",
    "textAlign",
    "textTransform",
    "textIndent",
    "textDecoration",
    "letterSpacing",
    "wordSpacing",
    "tabSize",
    "MozTabSize",
  ] as const;

  div.style.position = "absolute";
  div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap";
  div.style.wordWrap = "break-word";

  for (const property of properties) {
    div.style.setProperty(property, style.getPropertyValue(property));
  }

  div.textContent = textarea.value.slice(0, position);
  const span = document.createElement("span");
  span.textContent = textarea.value.slice(position) || ".";
  div.append(span);
  document.body.append(div);

  const { offsetLeft, offsetTop } = span;
  const result = {
    left: offsetLeft - textarea.scrollLeft,
    top: offsetTop - textarea.scrollTop,
    height: Number.parseFloat(style.lineHeight || "20"),
  };

  document.body.removeChild(div);
  return result;
}

function getDefaultAgent(
  task: TaskSnapshot,
): AgentIdResolution {
  return resolvePrimaryTopologyStartTarget(task.topology);
}

function MessageBubble({
  message,
  taskAgentEntries,
  onOpenAgentTerminal,
}: {
  message: ChatMessageItem;
  taskAgentEntries: ReadonlyArray<Pick<TaskSnapshot["agents"][number], "id" | "opencodeSessionId">>;
  onOpenAgentTerminal: ((agentId: string) => void) | undefined;
}) {
  const isUser = message.sender === "user";
  const isSystem = message.sender === "system";
  const isAgent = !isUser && !isSystem;
  const hasAgentDispatch = message.kinds.includes("agent-dispatch");
  const hasTaskCreated = message.kinds.includes("task-created");
  const hasTaskCompleted = message.kinds.includes("task-completed");
  const hasTaskRoundFinished = message.kinds.includes("task-round-finished");
  const hasTopologyBlocked = message.kinds.includes("topology-blocked");
  const agentColor = isAgent ? getAgentColorToken(message.sender) : null;
  const senderLabel = isUser ? null : getChatSenderLabel(message.senderDisplayName);
  const bubbleStyle =
    isAgent && agentColor
      ? {
          background: agentColor.soft,
          borderColor: agentColor.border,
          color: agentColor.text,
          boxShadow: "0 10px 24px rgba(23,32,25,0.06)",
        }
      : undefined;
  const senderBadgeStyle =
    isAgent && agentColor
      ? {
          background: agentColor.solid,
          color: agentColor.badgeText,
        }
      : isSystem
        ? {
            background: "#5867C8",
            color: "#F8FAFF",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.16)",
          }
      : isUser
        ? {
            background: "#D8C27A",
            color: "#43350D",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.22)",
          }
      : undefined;
  const metaTextStyle =
    isAgent && agentColor
      ? {
          color: agentColor.mutedText,
        }
      : isUser
        ? {
            color: "rgba(247, 251, 249, 0.8)",
          }
      : undefined;
  const attachButtonState = resolveChatMessageAttachButtonState({
    sender: message.sender,
    taskAgents: taskAgentEntries,
  });

  return (
    <article
      className={cn(
        "max-w-[88%] rounded-[8px] px-3 py-2",
        isUser && "ml-auto bg-primary text-primary-foreground",
        isAgent && "border",
        hasAgentDispatch && !isAgent && "border border-accent/60 bg-accent/35 text-foreground",
        hasTaskCreated && "border border-border/70 bg-muted/70 text-foreground",
        hasTaskCompleted && "border border-primary/20 bg-primary/10 text-foreground",
        hasTaskRoundFinished && "border border-primary/20 bg-primary/10 text-foreground",
        hasTopologyBlocked && "border border-primary/40 bg-primary/10 text-foreground",
        isSystem && message.kinds.length === 0 && "bg-muted text-foreground",
        isAgent && "shadow-sm",
      )}
      style={bubbleStyle}
    >
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {senderLabel ? (
            <span
              className={cn(
                "inline-flex h-6 max-w-full shrink-0 items-center rounded-[8px] px-2 text-center text-[13px] font-semibold leading-[1.2] tracking-[0.02em]",
                !isAgent && !isUser && !isSystem && "bg-black/8 text-current",
              )}
              style={senderBadgeStyle}
            >
              {senderLabel}
            </span>
          ) : null}
          <span
            className="inline-flex h-6 shrink-0 items-center text-[13px] leading-[1.2] opacity-80"
            style={metaTextStyle}
          >
            {new Date(message.timestamp).toLocaleString()}
          </span>
          {attachButtonState !== false ? (
            <button
              type="button"
              aria-label={`打开 ${attachButtonState.agentId} 的 attach 终端`}
              title={attachButtonState.title}
              disabled={attachButtonState.disabled}
              onClick={() => {
                if (attachButtonState.disabled || !onOpenAgentTerminal) {
                  return;
                }
                onOpenAgentTerminal(attachButtonState.agentId);
              }}
              className="inline-flex h-6 items-center justify-center gap-1 rounded-full border border-[#d8cdbd] bg-[#fffaf2] px-2 text-[13px] font-semibold text-foreground/76 shadow-[0_1px_0_rgba(255,255,255,0.45)] transition hover:border-[#cda27d] hover:bg-white disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-[#d8cdbd] disabled:hover:bg-[#fffaf2]"
            >
              <svg
                viewBox="0 0 16 16"
                className="h-3 w-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="2.3" y="3.1" width="11.4" height="7.8" rx="1.7" />
                <path d="M5.2 12.9h5.6" />
                <path d="M8 10.9v2" />
              </svg>
              <span>{attachButtonState.label}</span>
            </button>
          ) : null}
        </div>
        {isAgent ? (
          <MarkdownMessage content={message.content} />
        ) : (
          <div className="min-w-0 whitespace-pre-wrap text-sm leading-[1.36] break-words">
            {message.content}
          </div>
        )}
      </div>
    </article>
  );
}

function getExecutionHistoryItemClassName(item: AgentHistoryItem) {
  switch (item.tone) {
    case "failure":
      return "border-rose-200 bg-rose-50 text-rose-900";
    case "runtime-tool":
      return "border-amber-200 bg-amber-50 text-amber-900";
    case "runtime-thinking":
      return "border-slate-200 bg-slate-50 text-slate-800";
    case "runtime-step":
      return "border-sky-200 bg-sky-50 text-sky-900";
    case "runtime-message":
      return "border-emerald-200 bg-emerald-50 text-emerald-900";
    default:
      return "border-emerald-200 bg-emerald-50 text-emerald-900";
  }
}

function RunningExecutionBubble({
  item,
  taskAgentEntries,
  onOpenAgentTerminal,
  viewportRef,
  onViewportScroll,
}: {
  item: RunningChatFeedExecutionItem;
  taskAgentEntries: ReadonlyArray<Pick<TaskSnapshot["agents"][number], "id" | "opencodeSessionId">>;
  onOpenAgentTerminal: ((agentId: string) => void) | undefined;
  viewportRef: (element: HTMLDivElement | null) => void;
  onViewportScroll: (event: UIEvent<HTMLDivElement>) => void;
}) {
  const agentColor = getAgentColorToken(item.agentId);
  const attachButtonState = resolveChatMessageAttachButtonState({
    sender: item.agentId,
    taskAgents: taskAgentEntries,
  });
  const badgePresentation = getRuntimeExecutionBadgePresentation();

  return (
    <article
      className="max-w-[88%] rounded-[8px] border px-3 py-2 shadow-sm"
      style={{
        background: agentColor.soft,
        borderColor: agentColor.border,
        color: agentColor.text,
        boxShadow: "0 10px 24px rgba(23,32,25,0.06)",
      }}
    >
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className="inline-flex h-6 max-w-full shrink-0 items-center rounded-[8px] px-2 text-center text-[13px] font-semibold leading-[1.2] tracking-[0.02em]"
            style={{
              background: agentColor.solid,
              color: agentColor.badgeText,
            }}
          >
            {getChatSenderLabel(item.agentId)}
          </span>
          <span
            className="inline-flex h-6 shrink-0 items-center text-[13px] leading-[1.2] opacity-80"
            style={{ color: agentColor.mutedText }}
          >
            {new Date(item.startedAt).toLocaleString()}
          </span>
          <span
            aria-label={badgePresentation.ariaLabel}
            title={badgePresentation.title}
            className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[13px] font-semibold shadow-[0_1px_0_rgba(255,255,255,0.45)] ${badgePresentation.className}`}
          >
            <svg
              viewBox="0 0 16 16"
              className={`h-3.5 w-3.5 origin-center [transform-box:fill-box] ${badgePresentation.iconClassName}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M13 8a5 5 0 1 1-1.46-3.54" />
              <path d="M10.8 2.7H13v2.2" />
            </svg>
          </span>
          {attachButtonState !== false ? (
            <button
              type="button"
              aria-label={`打开 ${attachButtonState.agentId} 的 attach 终端`}
              title={attachButtonState.title}
              disabled={attachButtonState.disabled}
              onClick={() => {
                if (attachButtonState.disabled || !onOpenAgentTerminal) {
                  return;
                }
                onOpenAgentTerminal(attachButtonState.agentId);
              }}
              className="inline-flex h-6 items-center justify-center gap-1 rounded-full border border-[#d8cdbd] bg-[#fffaf2] px-2 text-[13px] font-semibold text-foreground/76 shadow-[0_1px_0_rgba(255,255,255,0.45)] transition hover:border-[#cda27d] hover:bg-white disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-[#d8cdbd] disabled:hover:bg-[#fffaf2]"
            >
              <svg
                viewBox="0 0 16 16"
                className="h-3 w-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="2.3" y="3.1" width="11.4" height="7.8" rx="1.7" />
                <path d="M5.2 12.9h5.6" />
                <path d="M8 10.9v2" />
              </svg>
              <span>{attachButtonState.label}</span>
            </button>
          ) : null}
        </div>

        <div
          ref={viewportRef}
          onScroll={onViewportScroll}
          className="min-h-0 space-y-1 overflow-y-auto rounded-[8px] border border-black/8 bg-white/55 px-2 py-2"
          style={{
            maxHeight: `${CHAT_EXECUTION_BUBBLE_MAX_HEIGHT_PX}px`,
          }}
        >
          {item.historyItems.length > 0 ? (
            item.historyItems.map((historyItem, index) => (
              <article
                key={`${historyItem.sortTimestamp}:${historyItem.tone}:${historyItem.label}:${index}`}
                className={`rounded-[10px] border px-2 py-1.5 ${getExecutionHistoryItemClassName(historyItem)}`}
              >
                <div className="min-w-0 flex-1 select-text">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`${AGENT_HISTORY_META_TEXT_CLASS} font-semibold`}>{historyItem.label}</span>
                    <span className={`${AGENT_HISTORY_META_TEXT_CLASS} opacity-70`}>
                      {new Date(historyItem.timestamp).toLocaleTimeString("zh-CN", {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                        hour12: false,
                      })}
                    </span>
                  </div>
                  <AgentHistoryMarkdown
                    content={historyItem.detailSnippet}
                    className={AGENT_HISTORY_DETAIL_TEXT_CLASS}
                    style={{ marginTop: "0.125rem" }}
                  />
                </div>
              </article>
            ))
          ) : (
            <div className="flex h-9 items-center rounded-[10px] border border-dashed border-black/10 px-2 text-[12px] text-foreground/60">
              正在等待第一条运行记录
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

export function ChatWindow({
  workspace,
  task,
  availableAgents,
  taskLogFilePath,
  taskUrl,
  isMaximized = false,
  onToggleMaximize,
  onOpenAgentTerminal,
  onSubmit,
}: ChatWindowProps) {
  const defaultAgent = getDefaultAgent(task);
  const hasAvailableAgents = availableAgents.length > 0;
  const [draft, setDraft] = useState("");
  const [mentionContext, setMentionContext] = useState<MentionContextState>({ kind: "inactive" });
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuPosition, setMenuPosition] = useState({ left: 24, top: 12 });
  const [submitting, setSubmitting] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messageViewportRef = useRef<HTMLDivElement | null>(null);
  const executionViewportRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const executionShouldStickToBottomRef = useRef<Record<string, boolean>>({});
  const executionLastTailVersionRef = useRef<Record<string, string | null>>({});
  const shouldStickToBottomRef = useRef(true);
  const copyResetTimerRef = useRef<number | null>(null);
  const mentionQuery = mentionContext.kind === "active" ? mentionContext.context.query : "";
  const fullscreenButtonCopy = getPanelFullscreenButtonCopy(isMaximized);

  useEffect(() => {
    if (task) {
      setDraft("");
      setMentionContext({ kind: "inactive" });
      setCopySuccess(false);
      setSubmitError(null);
      shouldStickToBottomRef.current = true;
      return;
    }
  }, [task?.task.id]);

  const messages = useMemo(
    () => mergeTaskChatMessages(
      [...(task?.messages ?? [])].sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
    ),
    [task],
  );
  const feedItems = useMemo(
    () => buildChatFeedItems({
      messages: task?.messages ?? [],
      topology: task.topology ?? workspace.topology,
    }),
    [task?.messages, task?.topology, workspace?.topology],
  );
  const visibleFeedItems = useMemo(
    () => feedItems.slice(-CHAT_VISIBLE_FEED_ITEM_LIMIT),
    [feedItems],
  );
  const taskAgentEntries = useMemo(
    () => task.agents.map((agent) => ({
      id: agent.id,
      opencodeSessionId: agent.opencodeSessionId,
    })),
    [task.agents],
  );
  const mentionOptions = useMemo(() => {
    if (!mentionQuery) {
      return [];
    }
    return getMentionOptionItems(availableAgents, mentionQuery);
  }, [availableAgents, mentionQuery]);

  useEffect(() => {
    const defaultIndex = defaultAgent.kind === "found"
      ? mentionOptions.findIndex((option) => option.agentId === defaultAgent.agentId)
      : -1;
    setActiveIndex(defaultIndex >= 0 ? defaultIndex : 0);
  }, [defaultAgent, mentionOptions]);

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const viewport = messageViewportRef.current;
    if (!viewport || !shouldStickToBottomRef.current) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      const nextViewport = messageViewportRef.current;
      if (!nextViewport) {
        return;
      }
      scrollTopologyHistoryToBottom(nextViewport);
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [visibleFeedItems, task?.task.id]);

  useEffect(() => {
    const activeRunningExecutionKeys = new Set(
      visibleFeedItems
        .filter((item): item is RunningChatFeedExecutionItem =>
          item.type === "execution" && item.status !== "settled")
        .map((item) => buildChatFeedItemRenderKey(item)),
    );

    for (const executionKey of Object.keys(executionViewportRefs.current)) {
      if (!activeRunningExecutionKeys.has(executionKey)) {
        delete executionViewportRefs.current[executionKey];
      }
    }
    for (const executionKey of Object.keys(executionShouldStickToBottomRef.current)) {
      if (!activeRunningExecutionKeys.has(executionKey)) {
        delete executionShouldStickToBottomRef.current[executionKey];
      }
    }
    for (const executionKey of Object.keys(executionLastTailVersionRef.current)) {
      if (!activeRunningExecutionKeys.has(executionKey)) {
        delete executionLastTailVersionRef.current[executionKey];
      }
    }
  }, [visibleFeedItems]);

  useEffect(() => {
    const frameIds: number[] = [];
    for (const feedItem of visibleFeedItems) {
      if (feedItem.type !== "execution" || feedItem.status === "settled") {
        continue;
      }

      const executionKey = buildChatFeedItemRenderKey(feedItem);
      const nextHistoryTailVersion = resolveHistoryTailVersion(feedItem.historyItems);
      const previousHistoryTailVersion = executionLastTailVersionRef.current[executionKey] ?? null;
      const shouldStickToBottom = executionShouldStickToBottomRef.current[executionKey] ?? true;

      if (shouldAutoScrollTopologyHistory({
        previousTailVersion: previousHistoryTailVersion,
        nextTailVersion: nextHistoryTailVersion,
        shouldStickToBottom,
      })) {
        frameIds.push(
          requestAnimationFrame(() => {
            const viewport = executionViewportRefs.current[executionKey];
            if (!viewport) {
              return;
            }
            scrollTopologyHistoryToBottom(viewport);
          }),
        );
      }

      executionLastTailVersionRef.current[executionKey] = nextHistoryTailVersion;
    }

    return () => {
      for (const frameId of frameIds) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [visibleFeedItems]);

  useEffect(() => {
    if (!mentionContext) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const composer = composerRef.current;
      const target = event.target;
      if (!composer || !(target instanceof Node) || composer.contains(target)) {
        return;
      }
      setMentionContext({ kind: "inactive" });
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [mentionContext]);

  function updateMenuPosition(textarea: HTMLTextAreaElement, caret: number, optionCount: number) {
    const caretCoordinates = getCaretCoordinates(textarea, caret);
    const estimatedMenuHeight =
      MENTION_MENU_VERTICAL_PADDING +
      MENTION_MENU_HEADER_HEIGHT +
      Math.max(1, Math.min(optionCount, MENTION_MENU_MAX_VISIBLE_ITEMS)) * MENTION_MENU_ITEM_HEIGHT;
    const textareaRect = textarea.getBoundingClientRect();
    const desiredTop = caretCoordinates.top + caretCoordinates.height + MENTION_MENU_GAP;
    const desiredBottomInViewport = textareaRect.top + desiredTop + estimatedMenuHeight;
    const canOpenBelow =
      desiredBottomInViewport <= window.innerHeight - MENTION_MENU_VIEWPORT_MARGIN;
    const aboveTop =
      caretCoordinates.top - estimatedMenuHeight - MENTION_MENU_GAP;

    setMenuPosition({
      left: Math.min(
        Math.max(caretCoordinates.left + 20, 24),
        Math.max(24, textarea.clientWidth - MENTION_MENU_WIDTH - 8),
      ),
      top: canOpenBelow ? desiredTop : aboveTop,
    });
  }

  function updateMentionState(nextDraft: string, caret: number) {
    const nextContext = getMentionContext(nextDraft, caret);
    setMentionContext(nextContext);

    const textarea = textareaRef.current;
    if (nextContext.kind === "active" && textarea) {
      const matchingOptions = getMentionOptionItems(availableAgents, nextContext.context.query);
      updateMenuPosition(textarea, caret, matchingOptions.length);
    }
  }

  function applyMention(agentId: string) {
    if (mentionContext.kind !== "active") {
      return;
    }

    const nextDraft = `${draft.slice(0, mentionContext.context.start)}@${agentId} ${draft.slice(mentionContext.context.end)}`;
    const nextCaret = mentionContext.context.start + agentId.length + 2;
    setDraft(nextDraft);
    setMentionContext({ kind: "inactive" });

    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      textarea?.focus();
      textarea?.setSelectionRange(nextCaret, nextCaret);
    });
  }

  async function handleSubmit() {
    const content = draft.trim();
    if (!content || submitting) {
      return;
    }
    const defaultTargetPayload = defaultAgent.kind === "found"
      ? { defaultTargetAgentId: defaultAgent.agentId }
      : {};
    const resolution = resolveTaskSubmissionTarget({
      content,
      availableAgents,
      ...defaultTargetPayload,
    });
    if (!resolution.ok) {
      setSubmitError(resolution.message);
      return;
    }

    const submitted = draft;
    setSubmitting(true);
    setSubmitError(null);
    setDraft("");
    setMentionContext({ kind: "inactive" });

    try {
      await onSubmit({ content });
    } catch (error) {
      setDraft(submitted);
      setSubmitError(error instanceof Error ? error.message : "发送失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopyTranscript() {
    if (messages.length === 0) {
      return;
    }

    setSubmitError(null);

    try {
      await navigator.clipboard.writeText(
        formatChatTranscript(
          messages.filter((message) =>
            message.sender === "user" ||
            message.sender === "system" ||
            message.kinds.includes("agent-final")
          ),
          {
            headerLines: [
              { label: "日志", value: taskLogFilePath },
              { label: "网页", value: taskUrl },
            ],
          },
        ),
      );
      setCopySuccess(true);

      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopySuccess(false);
        copyResetTimerRef.current = null;
      }, 1600);
    } catch (error) {
      setCopySuccess(false);
      setSubmitError(error instanceof Error ? error.message : "复制对话记录失败，请稍后重试。");
    }
  }

  return (
    <section className={PANEL_SURFACE_CLASS}>
      <header className={PANEL_HEADER_CLASS}>
        <div className={PANEL_HEADER_LEADING_CLASS}>
          <p className={PANEL_HEADER_TITLE_CLASS}>消息</p>
        </div>
        {task ? (
          <div className="flex min-w-0 shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onToggleMaximize}
              className={cn(PANEL_HEADER_ACTION_BUTTON_CLASS, "no-drag")}
              aria-label={fullscreenButtonCopy.ariaLabel}
            >
              {fullscreenButtonCopy.label}
            </button>
            <button
              type="button"
              disabled={messages.length === 0}
              onClick={() => {
                void handleCopyTranscript();
              }}
              className={cn(
                PANEL_HEADER_ACTION_BUTTON_CLASS,
                "no-drag disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {copySuccess ? "已复制记录" : "复制对话记录"}
            </button>
          </div>
        ) : null}
      </header>

      <div
        ref={messageViewportRef}
        onScroll={(event) => {
          const viewport = event.currentTarget;
          const distanceToBottom =
            viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
          shouldStickToBottomRef.current = distanceToBottom <= 48;
        }}
        className={`min-h-0 min-w-0 flex-1 space-y-1.5 overflow-y-auto ${PANEL_SECTION_BODY_CLASS}`}
      >
        {visibleFeedItems.length > 0 ? (
          visibleFeedItems.map((item) => {
            const renderKey = buildChatFeedItemRenderKey(item);
            return item.type === "message" ? (
              <MessageBubble
                key={renderKey}
                message={item.message}
                taskAgentEntries={taskAgentEntries}
                onOpenAgentTerminal={onOpenAgentTerminal}
              />
            ) : item.status === "settled" ? (
              <MessageBubble
                key={renderKey}
                message={item.message}
                taskAgentEntries={taskAgentEntries}
                onOpenAgentTerminal={onOpenAgentTerminal}
              />
            ) : (
              <RunningExecutionBubble
                key={renderKey}
                item={item}
                taskAgentEntries={taskAgentEntries}
                onOpenAgentTerminal={onOpenAgentTerminal}
                viewportRef={(element) => {
                  executionViewportRefs.current[renderKey] = element;
                }}
                onViewportScroll={(event) => {
                  executionShouldStickToBottomRef.current[renderKey] =
                    shouldStickTopologyHistoryToBottom({
                      scrollHeight: event.currentTarget.scrollHeight,
                      clientHeight: event.currentTarget.clientHeight,
                      scrollTop: event.currentTarget.scrollTop,
                    });
                }}
              />
            );
          })
        ) : (
          <div className="rounded-[8px] border border-dashed border-border/70 bg-card/60 px-4 py-4 text-sm text-muted-foreground">
            还没有消息
          </div>
        )}
      </div>

      <form
        className="min-w-0 border-t border-border/60 px-3 py-1.5"
        onSubmit={async (event) => {
          event.preventDefault();
          await handleSubmit();
        }}
      >
        <div className="w-full">
          <div ref={composerRef} className="relative">
            <textarea
              ref={textareaRef}
              rows={1}
              value={draft}
              onChange={(event) => {
                const nextDraft = event.target.value;
                const caret = event.target.selectionStart ?? nextDraft.length;
                setDraft(nextDraft);
                if (submitError) {
                  setSubmitError(null);
                }
                updateMentionState(nextDraft, caret);
              }}
              onClick={(event) => {
                const textarea = event.currentTarget;
                updateMentionState(textarea.value, textarea.selectionStart ?? 0);
              }}
              onFocus={(event) => {
                const textarea = event.currentTarget;
                updateMentionState(textarea.value, textarea.selectionStart ?? 0);
              }}
              onBlur={() => {
                requestAnimationFrame(() => {
                  const composer = composerRef.current;
                  const activeElement = document.activeElement;
                  if (!composer || (activeElement instanceof Node && composer.contains(activeElement))) {
                    return;
                  }
                  setMentionContext({ kind: "inactive" });
                });
              }}
              onKeyUp={(event) => {
                if (
                  event.key === "ArrowDown" ||
                  event.key === "ArrowUp" ||
                  event.key === "Enter" ||
                  event.key === "Tab" ||
                  event.key === "Escape"
                ) {
                  return;
                }
                updateMentionState(event.currentTarget.value, event.currentTarget.selectionStart ?? 0);
              }}
              onKeyDown={(event) => {
                if (mentionOptions.length > 0 && mentionContext.kind === "active") {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setActiveIndex((current) => (current + 1) % mentionOptions.length);
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveIndex((current) => (current - 1 + mentionOptions.length) % mentionOptions.length);
                    return;
                  }
                  if (event.key === "Tab") {
                    event.preventDefault();
                    applyMention(
                      mentionOptions[activeIndex]?.agentId ?? mentionOptions[0]?.agentId ?? "",
                    );
                    return;
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    applyMention(
                      mentionOptions[activeIndex]?.agentId ?? mentionOptions[0]?.agentId ?? "",
                    );
                    return;
                  }
                  if (event.key === "Escape") {
                    setMentionContext({ kind: "inactive" });
                  }
                }

                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  mentionOptions.length === 0 &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  void handleSubmit();
                  return;
                }
              }}
              placeholder={
                hasAvailableAgents
                  ? defaultAgent.kind === "found"
                    ? `默认向${defaultAgent.agentId}发送，可以使用@指定Agent`
                    : "当前拓扑缺少 start node，请使用@指定Agent发送消息"
                  : "当前还没有可用 Agent，请先配置团队成员"
              }
              className="no-drag block h-10 min-h-10 w-full resize-none rounded-[8px] border border-border bg-card px-3 py-2 text-sm leading-5 outline-none transition focus:border-primary"
            />

            {submitError ? (
              <div className="mt-1 flex items-center justify-end px-1 text-xs">
                <span className="text-primary">{submitError}</span>
              </div>
            ) : null}

            {mentionContext.kind === "active" && mentionOptions.length > 0 && (
              <div
                className="absolute z-20 w-56 max-h-[252px] overflow-y-auto rounded-[8px] border border-border bg-[#fff8f0] p-2 shadow-xl"
                style={{
                  left: menuPosition.left,
                  top: menuPosition.top,
                }}
              >
                <p className="px-2 pb-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                  Agents
                </p>
                <div className="space-y-1">
                  {mentionOptions.map((option, index) => (
                    <button
                      key={option.agentId}
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        applyMention(option.agentId);
                      }}
                      className={cn(
                        "no-drag w-full rounded-[6px] px-3 py-2 text-left text-sm transition",
                        index === activeIndex
                          ? "bg-primary text-primary-foreground"
                          : "hover:bg-muted",
                        )}
                    >
                      <span className="font-medium">{option.displayName}</span>
                      <span className="ml-2 text-xs opacity-70">{option.mentionLabel}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </form>
    </section>
  );
}
