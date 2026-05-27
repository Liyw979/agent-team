import boxen from "boxen";
import { mergeTaskChatMessages, type ChatMessageItem } from "../lib/chat-messages";
import type { MessageRecord } from "@shared/types";

const MESSAGE_LEFT_PADDING = "    ";

function formatChatSender(entry: ChatMessageItem) {
  return "senderDisplayName" in entry
    && typeof entry.senderDisplayName === "string"
    && entry.senderDisplayName.trim().length > 0
    ? entry.senderDisplayName.trim()
    : entry.sender;
}

function formatSingleLineMessageContent(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  const pad = (input: number) => String(input).padStart(2, "0");
  return [
    `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  ].join(" ");
}

function measureCharacterWidth(char: string) {
  return /[^\u0000-\u00ff]/u.test(char) ? 2 : 1;
}

function measureDisplayWidth(value: string) {
  let width = 0;
  for (const char of value) {
    width += measureCharacterWidth(char);
  }
  return width;
}

function wrapText(value: string, width: number) {
  const lines = value.split(/\r?\n/);
  const wrapped: string[] = [];

  for (const line of lines) {
    if (!line) {
      wrapped.push("");
      continue;
    }

    let currentLine = "";
    let currentWidth = 0;
    for (const char of line) {
      const charWidth = measureCharacterWidth(char);
      if (currentWidth + charWidth > width) {
        wrapped.push(currentLine);
        currentLine = char;
        currentWidth = charWidth;
        continue;
      }
      currentLine += char;
      currentWidth += charWidth;
    }
    wrapped.push(currentLine);
  }

  return wrapped;
}

function renderMessageBox(title: string, content: string) {
  const terminalWidth = process.stdout.columns || 120;
  const boxWidth = Math.max(54, Math.min(terminalWidth, 112));
  const contentWidth = Math.max(
    boxWidth - 2 - measureDisplayWidth(MESSAGE_LEFT_PADDING),
    1,
  );
  const body = wrapText(content, contentWidth)
    .map((line) => `${MESSAGE_LEFT_PADDING}${line}`)
    .join("\n");

  return boxen(body, {
    title,
    titleAlignment: "left",
    width: boxWidth,
    padding: {
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    },
    borderStyle: "single",
  });
}

export function collectIncrementalChatTranscript(
  previousMessages: MessageRecord[],
  nextMessages: MessageRecord[],
): ChatMessageItem[] {
  const previousMerged = mergeTaskChatMessages(
    [...previousMessages].sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
  );
  const nextMerged = mergeTaskChatMessages(
    [...nextMessages].sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
  );

  return nextMerged.slice(previousMerged.length);
}

// 历史要求：拓扑里渲染的 agent final message 必须同步打印到命令行，每条 final message 只占一行。
export function collectIncrementalAgentFinalMessages(
  previousMessages: MessageRecord[],
  nextMessages: MessageRecord[],
): ChatMessageItem[] {
  const previousMessageIds = new Set(previousMessages.map((message) => message.id));
  return nextMessages
    .filter((message) => message.kind === "agent-final" && !previousMessageIds.has(message.id))
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .map((message) => ({
      id: message.id,
      sender: message.sender,
      ...("senderDisplayName" in message
        ? { senderDisplayName: message.senderDisplayName }
        : {}),
      timestamp: message.timestamp,
      content: message.content,
      kinds: ["agent-final"],
      messageChain: [message],
    }));
}

export function renderChatStreamEntries(entries: ChatMessageItem[]): string {
  if (entries.length === 0) {
    return "";
  }

  const lines = entries.map((entry) => {
    const sender = formatChatSender(entry);
    if (entry.kinds.includes("agent-final")) {
      return `[${formatTimestamp(entry.timestamp)}] ${sender}: ${formatSingleLineMessageContent(entry.content)}`;
    }
    return renderMessageBox(`[${formatTimestamp(entry.timestamp)}] ${sender}`, entry.content);
  });

  return `${lines.join("\n\n")}\n\n`;
}
