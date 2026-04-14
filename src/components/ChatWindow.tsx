import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectSnapshot, TaskSnapshot } from "@shared/types";
import { cn } from "@/lib/utils";
import { getAgentColorToken } from "@/lib/agent-colors";
import { mergeTaskChatMessages, type ChatMessageItem } from "@/lib/chat-messages";

interface ChatWindowProps {
  project: ProjectSnapshot | undefined;
  task: TaskSnapshot | undefined;
  availableAgents: string[];
  onSubmit: (payload: { content: string; mentionAgent?: string }) => Promise<void>;
  onOpenTaskSession?: () => Promise<void>;
}

interface MentionContext {
  start: number;
  end: number;
  query: string;
}

const MENTION_MENU_WIDTH = 224;
const MENTION_MENU_MAX_VISIBLE_ITEMS = 5;
const MENTION_MENU_ITEM_HEIGHT = 41;
const MENTION_MENU_HEADER_HEIGHT = 28;
const MENTION_MENU_VERTICAL_PADDING = 16;
const MENTION_MENU_GAP = 12;
const MENTION_MENU_VIEWPORT_MARGIN = 12;

function getAgentDisplayName(name: string) {
  return name;
}

function getMentionContext(value: string, caret: number): MentionContext | null {
  const prefix = value.slice(0, caret);
  const match = prefix.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) {
    return null;
  }

  const start = prefix.lastIndexOf("@");
  if (start < 0) {
    return null;
  }

  return {
    start,
    end: caret,
    query: match[1] ?? "",
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
    div.style[property] = style[property];
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

function extractFirstMention(content: string): string | undefined {
  const match = content.match(/@([^\s]+)/);
  return match?.[1];
}

function getDefaultAgentName(agents: string[]): string | undefined {
  if (agents.includes("Build")) {
    return "Build";
  }
  return agents[0];
}

function getMessageBadge(kind: string | undefined, sender: string) {
  if (kind === "high-level-trigger") {
    return "Agent -> Agent";
  }
  if (kind === "task-created") {
    return "Task Started";
  }
  if (kind === "task-completed") {
    return "Task Result";
  }
  if (kind === "revision-request") {
    return "Needs Revision";
  }
  if (kind === "topology-blocked") {
    return "Topology Blocked";
  }
  if (sender === "system") {
    return "System";
  }
  return null;
}

function MessageBubble({ message }: { message: ChatMessageItem }) {
  const isUser = message.sender === "user";
  const isSystem = message.sender === "system";
  const isAgent = !isUser && !isSystem;
  const badges = [
    ...new Set(
      message.kinds
        .map((kind) => getMessageBadge(kind, message.sender))
        .filter((badge): badge is string => Boolean(badge)),
    ),
  ];
  const hasHighLevelTrigger = message.kinds.includes("high-level-trigger");
  const hasTaskCreated = message.kinds.includes("task-created");
  const hasTaskCompleted = message.kinds.includes("task-completed");
  const hasRevisionRequest = message.kinds.includes("revision-request");
  const hasTopologyBlocked = message.kinds.includes("topology-blocked");
  const agentColor = isAgent ? getAgentColorToken(message.sender) : null;
  const senderLabel = isUser ? "User" : isAgent ? getAgentDisplayName(message.sender) : message.sender;
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

  return (
    <article
      className={cn(
        "max-w-[88%] rounded-[8px] px-4 py-3 whitespace-pre-wrap",
        isUser && "ml-auto bg-primary text-primary-foreground",
        isAgent && "border",
        hasHighLevelTrigger && !isAgent && "border border-accent/60 bg-accent/35 text-foreground",
        hasTaskCreated && "border border-border/70 bg-muted/70 text-foreground",
        hasTaskCompleted && "border border-primary/20 bg-primary/10 text-foreground",
        hasRevisionRequest && "border border-secondary/60 bg-secondary/15 text-foreground",
        hasTopologyBlocked && "border border-primary/40 bg-primary/10 text-foreground",
        isSystem && message.kinds.length === 0 && "bg-muted text-foreground",
        isAgent && "shadow-sm",
      )}
      style={bubbleStyle}
    >
      <div className="mb-2 flex items-center justify-between gap-4 text-xs">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "shrink-0 rounded-full px-2.5 py-0.5 font-semibold tracking-[0.02em]",
              isUser && "border border-white/10",
              !isAgent && !isUser && "bg-black/8 text-current",
            )}
            style={senderBadgeStyle}
          >
            {senderLabel}
          </span>
          {badges.length > 0 ? (
            <span className="truncate opacity-80" style={metaTextStyle}>
              {badges.join(" · ")}
            </span>
          ) : null}
        </div>
        <span className="shrink-0 opacity-80" style={metaTextStyle}>
          {new Date(message.timestamp).toLocaleString()}
        </span>
      </div>
      <div className="text-sm leading-6">{message.content}</div>
    </article>
  );
}

export function ChatWindow({
  project,
  task,
  availableAgents,
  onSubmit,
  onOpenTaskSession,
}: ChatWindowProps) {
  const defaultAgentName = getDefaultAgentName(availableAgents);
  const [draft, setDraft] = useState("");
  const [mentionContext, setMentionContext] = useState<MentionContext | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuPosition, setMenuPosition] = useState({ left: 24, top: 12 });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (task) {
      setDraft("");
      setMentionContext(null);
      setSubmitError(null);
      return;
    }
  }, [task?.task.id]);

  const messages = useMemo(
    () => mergeTaskChatMessages(
      [...(task?.messages ?? [])].sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
    ),
    [task],
  );
  const mentionOptions = useMemo(() => {
    if (!mentionContext) {
      return [];
    }
    const query = mentionContext.query.toLowerCase();
    const filtered = availableAgents.filter((name) => name.toLowerCase().includes(query));
    return [...filtered].sort((left, right) => {
      if (left === "Build") {
        return -1;
      }
      if (right === "Build") {
        return 1;
      }
      return left.localeCompare(right);
    });
  }, [availableAgents, mentionContext]);

  useEffect(() => {
    const defaultIndex = defaultAgentName ? mentionOptions.indexOf(defaultAgentName) : -1;
    setActiveIndex(defaultIndex >= 0 ? defaultIndex : 0);
  }, [defaultAgentName, mentionContext?.query, mentionOptions]);

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

  function openAgentMenuAtCursor(textarea: HTMLTextAreaElement) {
    const caret = textarea.selectionStart ?? draft.length;
    setMentionContext({
      start: caret,
      end: caret,
      query: "",
    });
    updateMenuPosition(textarea, caret, availableAgents.length);
  }

  function updateMentionState(nextDraft: string, caret: number) {
    const nextContext = getMentionContext(nextDraft, caret);
    setMentionContext(nextContext);

    const textarea = textareaRef.current;
    if (nextContext && textarea) {
      const matchingOptions = availableAgents.filter((name) =>
        name.toLowerCase().includes(nextContext.query.toLowerCase()),
      );
      updateMenuPosition(textarea, caret, matchingOptions.length);
    }
  }

  function applyMention(agentName: string) {
    if (!mentionContext) {
      return;
    }

    const nextDraft = `${draft.slice(0, mentionContext.start)}@${agentName} ${draft.slice(mentionContext.end)}`;
    const nextCaret = mentionContext.start + agentName.length + 2;
    setDraft(nextDraft);
    setMentionContext(null);

    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      textarea?.focus();
      textarea?.setSelectionRange(nextCaret, nextCaret);
    });
  }

  async function handleSubmit() {
    const content = draft.trim();
    if (!content || !project || submitting) {
      return;
    }

    const submitted = draft;
    const mentionAgent = extractFirstMention(content) ?? defaultAgentName;

    setSubmitting(true);
    setSubmitError(null);
    setDraft("");
    setMentionContext(null);

    try {
      await onSubmit({
        content,
        mentionAgent,
      });
    } catch (error) {
      setDraft(submitted);
      setSubmitError(error instanceof Error ? error.message : "发送失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="PANEL-surface flex h-full min-h-0 flex-col rounded-[10px]">
      <header className="flex min-h-[34px] items-center justify-between gap-3 border-b border-border/60 px-5 py-2">
        <div className="flex items-center gap-2.5">
          <p className="font-display text-[1.45rem] font-bold text-primary">消息</p>
          <span className="rounded-full bg-[#c96f3b] px-2.5 py-0.5 text-xs font-semibold text-white">
            {messages.length}
          </span>
        </div>
        {task ? (
          <button
            type="button"
            onClick={() => {
              void onOpenTaskSession?.();
            }}
            className="no-drag rounded-[8px] border border-border bg-card px-3.5 py-1.5 text-xs font-semibold text-foreground transition hover:border-primary"
          >
            打开 Zellij
          </button>
        ) : null}
      </header>

      <div className="flex-1 min-h-0 space-y-3 overflow-y-auto px-5 py-4">
        {messages.length > 0 ? (
          messages.map((message) => <MessageBubble key={message.id} message={message} />)
        ) : (
          <div className="rounded-[8px] border border-dashed border-border/70 bg-card/60 px-4 py-4 text-sm text-muted-foreground">
            还没有消息
          </div>
        )}
      </div>

      <form
        className="border-t border-border/60 px-5 py-4"
        onSubmit={async (event) => {
          event.preventDefault();
          await handleSubmit();
        }}
      >
        <div className="w-full">
          <div className="relative">
            <textarea
              ref={textareaRef}
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
                const nextContext = getMentionContext(textarea.value, textarea.selectionStart ?? 0);
                if (nextContext) {
                  updateMentionState(textarea.value, textarea.selectionStart ?? 0);
                  return;
                }
                openAgentMenuAtCursor(textarea);
              }}
              onFocus={(event) => {
                const textarea = event.currentTarget;
                const nextContext = getMentionContext(textarea.value, textarea.selectionStart ?? 0);
                if (nextContext) {
                  updateMentionState(textarea.value, textarea.selectionStart ?? 0);
                  return;
                }
                openAgentMenuAtCursor(textarea);
              }}
              onKeyUp={(event) => {
                updateMentionState(event.currentTarget.value, event.currentTarget.selectionStart ?? 0);
              }}
              onKeyDown={(event) => {
                if (mentionOptions.length > 0 && mentionContext) {
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
                    applyMention(mentionOptions[activeIndex] ?? mentionOptions[0]);
                    return;
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    applyMention(mentionOptions[activeIndex] ?? mentionOptions[0]);
                    return;
                  }
                  if (event.key === "Escape") {
                    setMentionContext(null);
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
                task
                  ? "默认向Build Agent发送消息，使用@指定Agent"
                  : "默认向Build Agent发送消息，使用@指定Agent"
              }
              className="no-drag block min-h-[68px] w-full resize-none rounded-[8px] border border-border bg-card px-4 py-2.5 text-sm leading-6 outline-none transition focus:border-primary"
            />

            <div className="mt-2 flex items-center justify-end gap-3 px-1 text-xs">
              {submitError ? <span className="text-primary">{submitError}</span> : null}
            </div>

            {mentionContext && mentionOptions.length > 0 && (
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
                  {mentionOptions.map((agentName, index) => (
                    <button
                      key={agentName}
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        applyMention(agentName);
                      }}
                      className={cn(
                        "no-drag w-full rounded-[6px] px-3 py-2 text-left text-sm transition",
                        index === activeIndex
                          ? "bg-primary text-primary-foreground"
                          : "hover:bg-muted",
                      )}
                    >
                      <span className="font-medium">{getAgentDisplayName(agentName)}</span>
                      <span className="ml-2 text-xs opacity-70">@{agentName}</span>
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
