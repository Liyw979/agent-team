import boxen from "boxen";
import { mergeTaskChatMessages, type ChatMessageItem } from "../src/lib/chat-messages";
import type { MessageRecord } from "@shared/types";

const MESSAGE_LEFT_PADDING = "    ";

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

export function measureDisplayWidth(value: string) {
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

export function renderChatStreamEntries(entries: ChatMessageItem[]): string {
  if (entries.length === 0) {
    return "";
  }

  return entries.map((entry) => {
    const sender = entry.senderDisplayName?.trim() || entry.sender;
    return `${renderMessageBox(`[${formatTimestamp(entry.timestamp)}] ${sender}`, entry.content)}\n`;
  }).join("\n");
}
